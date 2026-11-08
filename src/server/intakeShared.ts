// What the staff invite routes (providerInviteRoutes.ts) and the provider
// intake routes (providerIntakeRoutes.ts) both run on: the email config and
// deps, sending an email and keeping what happened to it, and the pause answer.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { logServerError, type ErrorLogSite } from "./safeLog";
import { resolveEmailEnv } from "./email/env";
import { EmailError, sendEmail } from "./email/sendgrid";
import type { SendEmailInput } from "./email/sendgrid";
import type { TemplateKey } from "./email/templates";

export interface IntakeConfig {
  appBaseUrl: string | null;
  fromEmail: string | null;
  emailReady: boolean;
  secureCookie: boolean;
  /** ONBOARDING_OPS_EMAIL: told when a provider submits or asks for help. */
  opsEmail: string | null;
}

// The origin the invite email links to. Anything but a bare https origin (or
// http://localhost in dev) counts as missing, so a typo is a 500, not a bad link.
export function resolveAppBaseUrl(raw: string | undefined, dev: boolean): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(dev && local && url.protocol === "http:")) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveIntakeConfig(): IntakeConfig {
  const email = resolveEmailEnv();
  return {
    appBaseUrl: resolveAppBaseUrl(process.env.APP_BASE_URL, Boolean(import.meta.env.DEV)),
    fromEmail: email.fromEmail ?? null,
    emailReady: Boolean(email.apiKey && email.fromEmail),
    // Safari drops Secure cookies on http://localhost.
    secureCookie: !import.meta.env.DEV,
    opsEmail: process.env.ONBOARDING_OPS_EMAIL?.trim() || null,
  };
}

export interface IntakeDeps {
  config: IntakeConfig;
  send: <K extends TemplateKey>(input: SendEmailInput<K>) => Promise<{ sandbox: boolean }>;
  now: () => Date;
}

export function defaultDeps(): IntakeDeps {
  return {
    config: resolveIntakeConfig(),
    send: (input) => sendEmail(input),
    now: () => new Date(),
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PAUSED_ERROR = "intake_paused";

export type RpcResult = Record<string, unknown> | null;

// What staff are told about the email. "sandbox" means SendGrid accepted it
// in sandbox mode (SENDGRID_SANDBOX is exactly "true"), so nothing was
// delivered. A failure is never an error, because the invite is already saved.
export type Delivery = "sent" | "sandbox" | "failed";

export async function trySend<K extends TemplateKey>(
  deps: IntakeDeps,
  input: SendEmailInput<K>,
): Promise<Delivery> {
  try {
    const { sandbox } = await deps.send(input);
    return sandbox ? "sandbox" : "sent";
  } catch (error) {
    if (!(error instanceof EmailError)) throw error;
    console.warn("[intake] email not sent:", error.kind, error.status ?? "");
    return "failed";
  }
}

// What happened to an email is kept on its invite or code. Losing that note
// must never fail a request whose email already went out.
export async function recordDelivery(
  db: SupabaseClient<Database>,
  kind: "invite" | "code" | "submitted",
  id: string,
  delivery: Delivery,
  site: ErrorLogSite,
): Promise<void> {
  try {
    const { error } = await db.rpc("record_intake_email_delivery", {
      p_kind: kind,
      p_id: id,
      p_delivery: delivery,
    });
    if (error) throw error;
  } catch (error) {
    logServerError("[intake] email delivery not recorded", error, site);
  }
}
