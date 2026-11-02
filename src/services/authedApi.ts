// The one browser -> /api fetch for sanctioned surfaces (CLAUDE.md "Data
// access"): the caller's JWT + active org, the { data, error } envelope, and
// the access-context revision check.
import { supabase } from "@/integrations/supabase/externalClient";
import { requireActiveOrg } from "@/lib/audit";
import {
  getContextRevisionSnapshot,
  observeContextRevisionForRequest,
} from "@/lib/contextRevision";

interface ApiEnvelope<T> {
  data: T | null;
  error: string | null;
}

/** A non-OK /api response. The message is the envelope's error, exactly as
 * before; `status` and `retryAfterSeconds` (from a Retry-After header in
 * seconds, when sent) let a caller tell a rate limit from an outage. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  const seconds = raw === null ? Number.NaN : Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export async function authedApiFetch<T>(
  path: string,
  init?: RequestInit,
  options: { rejectStale?: boolean } = {},
): Promise<T> {
  const orgId = requireActiveOrg();
  // Capture before any asynchronous auth/session work. An auth transition
  // during getSession or response parsing must invalidate this response.
  const before = getContextRevisionSnapshot();
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Not signed in");
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      "x-org-id": orgId,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (observeContextRevisionForRequest(response, before, options)) {
    throw new Error("Access context changed; retry the request");
  }
  if (!response.ok || envelope.data === null) {
    throw new ApiRequestError(
      envelope.error ?? `Request failed (${response.status})`,
      response.status,
      retryAfterSeconds(response),
    );
  }
  return envelope.data;
}
