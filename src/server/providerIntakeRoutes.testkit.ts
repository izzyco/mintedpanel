// Test-only: the fakes providerInviteRoutes.test.ts and
// providerIntakeRoutes.test.ts share. No route module imports this file.
import { vi } from "vitest";
import type { ApiEnvelope } from "./envelope";
import type { IntakeConfig, IntakeDeps } from "./intakeShared";

export const PROVIDER = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const NOW = new Date("2026-10-25T12:00:00Z");

export const CONFIG: IntakeConfig = {
  appBaseUrl: "https://staging.example.test",
  fromEmail: "no-reply@mintedpanel.com",
  emailReady: true,
  secureCookie: true,
  opsEmail: null,
};

export function makeDeps(overrides: Partial<IntakeDeps> = {}) {
  const send = vi.fn().mockResolvedValue({ status: 202, sandbox: false });
  const deps: IntakeDeps = { config: CONFIG, send, now: () => NOW, ...overrides };
  return { deps, send: deps.send as ReturnType<typeof vi.fn> };
}

export interface RpcReply {
  data: unknown;
  error: unknown;
}

// `result` answers the route's own RPC. The off switch reads "not paused" and
// the delivery record succeeds unless a test passes its own reply (an Error
// is thrown, like a dropped connection).
export function fakeDb(result: unknown = null, replies: Record<string, RpcReply | Error> = {}) {
  const defaults: Record<string, RpcReply> = {
    intake_paused: { data: false, error: null },
    intake_link_paused: { data: false, error: null },
    record_intake_email_delivery: { data: true, error: null },
  };
  return {
    rpc: vi.fn(async (name: string, _args?: Record<string, unknown>): Promise<RpcReply> => {
      const reply = replies[name] ?? defaults[name] ?? { data: result, error: null };
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

export const PAUSED = {
  intake_paused: { data: true, error: null },
  intake_link_paused: { data: true, error: null },
};

export function rpcNames(db: ReturnType<typeof fakeDb>): string[] {
  return db.rpc.mock.calls.map(([name]) => name);
}

export function rpcArgs(db: ReturnType<typeof fakeDb>, name: string): Record<string, unknown> {
  const call = db.rpc.mock.calls.find(([called]) => called === name);
  if (!call) throw new Error(`${name} was not called`);
  return call[1] ?? {};
}

export async function body(res: Response): Promise<ApiEnvelope<Record<string, unknown>>> {
  return (await res.json()) as ApiEnvelope<Record<string, unknown>>;
}
