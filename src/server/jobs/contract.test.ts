import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_SLOT_RE } from "./notificationSends";
import { JOB_NAME_RE } from "./registry";

// MINT-106: jobs log only through safeLog (ctx.log.error → logServerError).
const root = process.cwd();

// MINT-108: the fake in src/__fixtures__/followUpDigestFakeDb.ts stands in for
// notification_sends, so the rules it mirrors must be the migration's.
const SENDS_MIGRATION = readFileSync(
  join(root, "supabase/migrations/20261101100100_notification_sends.sql"),
  "utf8",
);
const sendsSource = readFileSync(join(root, "src/server/jobs/notificationSends.ts"), "utf8");
const runSource = readFileSync(join(root, "src/server/jobs/followupDigestRun.ts"), "utf8");

describe("notification_sends migration and code agree", () => {
  it("sorts after the notification sequences migration it follows", () => {
    const order = readdirSync(join(root, "supabase/migrations"))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(order.indexOf("20261101100100_notification_sends.sql")).toBeGreaterThan(
      order.indexOf("20261101100000_notification_sequences.sql"),
    );
    expect(order.indexOf("20261101100000_notification_sequences.sql")).toBeGreaterThan(-1);
  });

  it("keeps one row per (org, job, slot, recipient): a failed row is claimed again, nothing else", () => {
    expect(SENDS_MIGRATION).toContain(
      "CONSTRAINT notification_sends_pkey PRIMARY KEY (org_id, job, slot, recipient_user_id)",
    );
    expect(SENDS_MIGRATION).toMatch(
      /ON CONFLICT \(org_id, job, slot, recipient_user_id\) DO UPDATE\s+SET outcome = 'claimed', claimed_at = now\(\)\s+WHERE s\.outcome = 'failed';\s+RETURN FOUND;/,
    );
    // The finish moves only a claimed row.
    expect(SENDS_MIGRATION).toMatch(
      /SET outcome = p_outcome\s+WHERE[\s\S]*?AND outcome = 'claimed';/,
    );
  });

  it("never records a send that may have been delivered as failed", () => {
    // A SendGrid 5xx or 408 is provider_rejected from the mailer, but the job
    // treats it as maybe delivered (isDefiniteRejection) and leaves it claimed.
    expect(runSource).toMatch(/status < 500 && status !== 408/);
    expect(runSource).not.toMatch(/"network"/);
  });

  it("checks the job and slot with the code's patterns", () => {
    const sqlPattern = (re: RegExp) => `'${re.source}'`;
    expect(SENDS_MIGRATION).toContain(`CHECK (job ~ ${sqlPattern(JOB_NAME_RE)})`);
    expect(SENDS_MIGRATION).toContain(`CHECK (slot ~ ${sqlPattern(NOTIFICATION_SLOT_RE)})`);
    // A local date and a twice-a-day second send fit it.
    expect("2026-10-31").toMatch(NOTIFICATION_SLOT_RE);
    expect("2026-10-31:2").toMatch(NOTIFICATION_SLOT_RE);
  });

  it("calls the RPCs by the names and arguments the migration defines", () => {
    expect(SENDS_MIGRATION).toMatch(
      /FUNCTION public\.claim_notification_send\(\s+p_job text,\s+p_slot text,\s+p_org_id uuid,\s+p_recipient_user_id uuid\s+\) RETURNS boolean/,
    );
    expect(SENDS_MIGRATION).toMatch(
      /FUNCTION public\.finish_notification_send\(\s+p_job text,\s+p_slot text,\s+p_org_id uuid,\s+p_recipient_user_id uuid,\s+p_outcome text\s+\) RETURNS boolean/,
    );
    expect(sendsSource).toContain('db.rpc("claim_notification_send", keyArgs(key))');
    expect(sendsSource).toContain('db.rpc("finish_notification_send", {');
    for (const arg of ["p_job:", "p_slot:", "p_org_id:", "p_recipient_user_id:", "p_outcome:"]) {
      expect(sendsSource).toContain(arg);
    }
  });

  it("is service_role only: RLS on, no policy, nothing for anon or authenticated", () => {
    expect(SENDS_MIGRATION).not.toMatch(/CREATE POLICY/i);
    expect(SENDS_MIGRATION).toContain(
      "ALTER TABLE public.notification_sends ENABLE ROW LEVEL SECURITY;",
    );
    expect(SENDS_MIGRATION).toContain(
      "REVOKE ALL ON TABLE public.notification_sends FROM public, anon, authenticated, service_role;",
    );
    expect(SENDS_MIGRATION).toContain(
      "GRANT SELECT ON TABLE public.notification_sends TO service_role;",
    );
    expect(SENDS_MIGRATION).not.toMatch(/GRANT [^;]* TO [^;]*\b(anon|authenticated)\b/);
    expect(SENDS_MIGRATION).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]* ON TABLE/);
    for (const fn of [
      "claim_notification_send(text, text, uuid, uuid)",
      "finish_notification_send(text, text, uuid, uuid, text)",
    ]) {
      const escaped = fn.replace(/[()]/g, "\\$&");
      expect(SENDS_MIGRATION).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${escaped}\\s+FROM public, anon, authenticated;`,
        ),
      );
      expect(SENDS_MIGRATION).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role;`),
      );
    }
    expect(SENDS_MIGRATION.match(/SECURITY DEFINER\nSET search_path = ''/g)).toHaveLength(2);
  });

  it("stores no PHI and no receipt: the key, the outcome and when it was claimed", () => {
    const table = SENDS_MIGRATION.slice(
      SENDS_MIGRATION.indexOf("CREATE TABLE IF NOT EXISTS public.notification_sends"),
      SENDS_MIGRATION.indexOf("ALTER TABLE public.notification_sends"),
    );
    const columns = [...table.matchAll(/^ {2}([a-z_]+) (?:uuid|text|timestamptz)/gm)].map(
      (m) => m[1],
    );
    expect(columns).toEqual([
      "org_id",
      "job",
      "slot",
      "recipient_user_id",
      "outcome",
      "claimed_at",
    ]);
    expect(table).toContain("REFERENCES public.organizations(id) ON DELETE CASCADE");
    expect(SENDS_MIGRATION).not.toMatch(/notification_org_slots|CREATE (UNIQUE )?INDEX/);
  });
});

describe("jobs code logs only through safeLog", () => {
  it("has no console call outside tests, in any file under src/server/jobs/", () => {
    const dir = join(root, "src/server/jobs");
    const sources = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/\bconsole\s*\./);
    }
  });
});
