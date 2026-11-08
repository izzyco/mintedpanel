// Staff side of provider onboarding (full authenticate(), writers only):
// create, resend and cancel (docs/provider-onboarding/slice-1-invite-to-form.md
// §5, docs/provider-onboarding/data-map.md). Each write is one SECURITY
// DEFINER RPC that is EXECUTE-granted to service_role only and writes its own
// audit rows, so these handlers never call writeAudit. Nothing here logs a
// body, email, token, id or object path. While provider_intake_settings.paused
// is set, create and resend answer 503 intake_paused before they write
// anything. Cancel only takes access away, so a pause never blocks it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ok, fail } from "./envelope";
import { isWriter, type AuthContext } from "./guard";
import { logServerError } from "./safeLog";
import { INVITE_TTL_DAYS, hashToken, newToken, validateInviteInput } from "./intakeTokens";
import {
  PAUSED_ERROR,
  UUID,
  defaultDeps,
  recordDelivery,
  trySend,
  type Delivery,
  type IntakeConfig,
  type IntakeDeps,
  type RpcResult,
} from "./intakeShared";

function inviteExpiry(now: Date): string {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

async function intakePaused(db: SupabaseClient<Database>): Promise<boolean> {
  const { data, error } = await db.rpc("intake_paused");
  if (error) throw error;
  return data === true;
}

function notConfigured(config: IntakeConfig): boolean {
  return !config.emailReady || !config.appBaseUrl || !config.fromEmail;
}

function actorName(ctx: AuthContext): string {
  return ctx.userName ?? ctx.email ?? "";
}

// The invite email, and what happened to it kept on the invite. The link
// carries the token whose hash the RPC just stored.
async function sendInvite(
  ctx: AuthContext,
  deps: IntakeDeps,
  invite: {
    to: string;
    firstName: string;
    practiceName: string;
    token: string;
    inviteId: string;
    route: string;
  },
): Promise<Delivery> {
  const delivery = await trySend(deps, {
    to: invite.to,
    template: "provider_invitation",
    data: {
      practiceName: invite.practiceName,
      firstName: invite.firstName,
      link: `${deps.config.appBaseUrl}/intake/${invite.token}`,
    },
    practiceName: invite.practiceName,
    replyTo: {
      email: ctx.email ?? (deps.config.fromEmail as string),
      name: ctx.userName ?? undefined,
    },
  });
  await recordDelivery(ctx.db, "invite", invite.inviteId, delivery, {
    method: "POST",
    route: invite.route,
  });
  return delivery;
}

export async function handleCreateProviderInvite(
  body: unknown,
  ctx: AuthContext,
  deps: IntakeDeps = defaultDeps(),
): Promise<Response> {
  if (!isWriter(ctx)) return fail(403, "Only admins and specialists can invite providers");
  if (notConfigured(deps.config)) return fail(500, "Provider invites are not configured");
  const parsed = validateInviteInput(body);
  if (!parsed.ok) return fail(422, parsed.error);
  if (await intakePaused(ctx.db)) return fail(503, PAUSED_ERROR);

  const token = newToken();
  const { data, error } = await ctx.db.rpc("create_provider_intake_invite", {
    p_org_id: ctx.orgId,
    p_actor_id: ctx.userId,
    p_actor_name: actorName(ctx),
    p_input: { ...parsed.input },
    p_token_hash: hashToken(token),
    p_expires_at: inviteExpiry(deps.now()),
  });
  if (error) throw error;
  const result = data as RpcResult;

  switch (result?.result) {
    case "invalid_input":
      return fail(422, "First name, last name, email and group are required");
    case "group_not_found":
      return fail(404, "Group not found");
    case "duplicate":
      return ok({ outcome: "already_exists", providerId: result.provider_id as string });
    case "added_group":
      return ok({ outcome: "added_group", providerId: result.provider_id as string });
    case "conflict":
      return fail(
        409,
        "More than one provider in this organization has this email or NPI. Nothing was saved or sent. Check their records, then invite again.",
      );
    case "created": {
      const delivery = await sendInvite(ctx, deps, {
        to: parsed.input.email,
        firstName: parsed.input.first_name,
        practiceName: String(result.practice_name ?? ""),
        token,
        inviteId: String(result.invite_id),
        route: "/api/provider-invites",
      });
      return ok(
        { outcome: "created", providerId: result.provider_id as string, delivery },
        null,
        201,
      );
    }
    default:
      throw new Error("create_provider_intake_invite returned an unknown result");
  }
}

export async function handleResendProviderInvite(
  providerId: string,
  ctx: AuthContext,
  deps: IntakeDeps = defaultDeps(),
): Promise<Response> {
  if (!isWriter(ctx)) return fail(403, "Only admins and specialists can resend invites");
  if (notConfigured(deps.config)) return fail(500, "Provider invites are not configured");
  if (!UUID.test(providerId)) return fail(404, "Invite not found");
  if (await intakePaused(ctx.db)) return fail(503, PAUSED_ERROR);

  const token = newToken();
  const { data, error } = await ctx.db.rpc("resend_provider_intake_invite", {
    p_org_id: ctx.orgId,
    p_actor_id: ctx.userId,
    p_actor_name: actorName(ctx),
    p_provider_id: providerId,
    p_token_hash: hashToken(token),
    p_expires_at: inviteExpiry(deps.now()),
  });
  if (error) throw error;
  const result = data as RpcResult;

  switch (result?.result) {
    case "not_found":
      return fail(404, "Invite not found");
    case "cooldown":
      return fail(429, "An invite was sent in the last 10 minutes. Try again shortly.");
    case "resent": {
      // The RPC picks the address (the record's current email), which may not
      // be what staff typed into the dialog, so the response says which it was.
      const email = String(result.email);
      const delivery = await sendInvite(ctx, deps, {
        to: email,
        firstName: String(result.first_name ?? ""),
        practiceName: String(result.practice_name ?? ""),
        token,
        inviteId: String(result.invite_id),
        route: "/api/provider-invites/:param/resend",
      });
      return ok({ delivery, email });
    }
    default:
      throw new Error("resend_provider_intake_invite returned an unknown result");
  }
}

const STORAGE_PAGE = 100;

interface StoragePrefix {
  bucket: string;
  prefix: string;
}

async function objectsUnder(
  db: SupabaseClient<Database>,
  { bucket, prefix }: StoragePrefix,
): Promise<string[]> {
  const store = db.storage.from(bucket);
  const files: string[] = [];
  const folders = [prefix.replace(/\/$/, "")];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (let offset = 0; ; offset += STORAGE_PAGE) {
      const { data, error } = await store.list(folder, { limit: STORAGE_PAGE, offset });
      if (error) throw error;
      for (const entry of data) {
        const path = `${folder}/${entry.name}`;
        if (entry.id === null) folders.push(path);
        else files.push(path);
      }
      if (data.length < STORAGE_PAGE) break;
    }
  }
  return files;
}

// Cancel. The RPC revokes her access and deletes the record or closes
// the journey in one transaction, then names the Storage prefixes that held
// her files. A file that can't be deleted waits under a journey that is no
// longer open, where a sweep can find it, and the cancel still answers 200.
export async function handleCancelProviderOnboarding(
  providerId: string,
  ctx: AuthContext,
): Promise<Response> {
  if (!isWriter(ctx)) return fail(403, "Only admins and specialists can cancel an onboarding");
  if (!UUID.test(providerId)) return fail(404, "Onboarding not found");

  const { data, error } = await ctx.db.rpc("cancel_provider_onboarding", {
    p_org_id: ctx.orgId,
    p_actor_id: ctx.userId,
    p_actor_name: actorName(ctx),
    p_provider_id: providerId,
  });
  if (error) throw error;
  const result = data as RpcResult;

  switch (result?.result) {
    case "not_found":
      return fail(404, "Onboarding not found");
    case "already_submitted":
      return fail(409, "already_submitted");
    case "deleted":
    case "closed":
      for (const prefix of result.storage as StoragePrefix[]) {
        try {
          const files = await objectsUnder(ctx.db, prefix);
          const store = ctx.db.storage.from(prefix.bucket);
          for (let i = 0; i < files.length; i += STORAGE_PAGE) {
            const { error: removeError } = await store.remove(files.slice(i, i + STORAGE_PAGE));
            if (removeError) throw removeError;
          }
        } catch (storageError) {
          logServerError("[onboarding] cancelled files not deleted", storageError, {
            method: "POST",
            route: "/api/provider-invites/:param/cancel",
          });
        }
      }
      return ok({ outcome: result.result });
    default:
      throw new Error("cancel_provider_onboarding returned an unknown result");
  }
}
