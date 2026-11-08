#!/usr/bin/env bash
# Runs e2e/onboarding-local-stack.spec.ts: provider onboarding end to end in a
# real browser against a LOCAL Supabase stack, from the staff invite to Admit,
# plus Cancel and a help request. Never hosted, never a real email.
#
#   bash scripts/e2e/onboarding-local-stack.sh [extra playwright args]
#   bash scripts/e2e/onboarding-local-stack.sh --serve
#
# --serve starts the same two servers but runs no test. It makes the sample
# practice "Local Rehab" (scripts/e2e/onboarding-fixture.sql) with a fixed
# staff login, or reuses it, prints where everything is, and stays up until
# Ctrl-C, for a walk-through by hand
# (docs/provider-onboarding/local-verification.md).
#
# Needs a running local stack with every migration applied, both Vault
# secrets and the local-only auth grants, and psql and the supabase CLI on
# PATH. scripts/e2e/local-stack-setup.sh builds that stack. The runner checks
# it and stops when something is missing.
#
# Settings (all optional):
#   SUPABASE_WORKDIR    where `supabase status` runs (default: this repo)
#   APP_PORT            the vite dev server (default 8091)
#   MAIL_PORT           the mail capture server (default 8092)
#   E2E_SCREENSHOT_DIR  screenshots (default test-results/onboarding-local-stack/screens)
#
# It reads the stack's URL and keys from `supabase status` (never printed),
# refuses any API or database that is not on this machine, starts the mail
# capture server (scripts/e2e/mail-capture.mjs) and `vite dev` with SendGrid
# pointed at it, runs Playwright with playwright.local-stack.config.ts, and
# stops both servers on exit. Server logs go to test-results/onboarding-local-stack/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVE=""
if [ "${1:-}" = "--serve" ]; then
  SERVE=1
  shift
fi
WORKDIR="${SUPABASE_WORKDIR:-$ROOT}"
APP_PORT="${APP_PORT:-8091}"
MAIL_PORT="${MAIL_PORT:-8092}"
OUT="$ROOT/test-results/onboarding-local-stack"
mkdir -p "$OUT"

API_URL="" ANON_KEY="" SERVICE_ROLE_KEY="" DB_URL="" STUDIO_URL=""
eval "$(supabase status --workdir "$WORKDIR" -o env 2>/dev/null |
  grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL|STUDIO_URL)=' || true)"
for name in API_URL ANON_KEY SERVICE_ROLE_KEY DB_URL; do
  if [ -z "${!name}" ]; then
    echo "supabase status gave no $name. Is the local stack running in $WORKDIR?" >&2
    exit 1
  fi
done
case "$API_URL" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *) echo "Refusing to run: the API URL is not on this machine." >&2 && exit 1 ;;
esac
case "$DB_URL" in
  postgresql://*@127.0.0.1:* | postgresql://*@localhost:*) ;;
  *) echo "Refusing to run: the database is not on this machine." >&2 && exit 1 ;;
esac
missing="$(psql "$DB_URL" -X -q -At -c "SELECT concat_ws('; ',
  CASE WHEN to_regclass('public.provider_onboardings') IS NULL THEN 'the provider onboarding migrations' END,
  CASE WHEN (SELECT count(*) FROM vault.secrets
              WHERE name IN ('ssn_vault_key', 'portal_credentials_key')) < 2 THEN 'the two Vault secrets' END,
  CASE WHEN NOT has_schema_privilege('minted_e612_authz_owner', 'auth', 'USAGE')
       THEN 'USAGE on schema auth for minted_e612_authz_owner' END,
  CASE WHEN NOT has_table_privilege('service_role', 'auth.users', 'SELECT')
       THEN 'SELECT on auth.users for service_role' END)")"
if [ -n "$missing" ]; then
  echo "The local stack is missing: $missing. Run scripts/e2e/local-stack-setup.sh." >&2
  exit 1
fi
for port in "$APP_PORT" "$MAIL_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use." >&2
    exit 1
  fi
done

if [ -n "$SERVE" ]; then
  STAFF_EMAIL=staff@local.test
  STAFF_PASSWORD=local-staff-password
  staff_id() {
    psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=1 \
      -c "SELECT id FROM auth.users WHERE email = '$STAFF_EMAIL'"
  }
  # A rerun resets the password, so the login printed below always works.
  id="$(staff_id)"
  if [ -z "$id" ]; then
    method=POST url="$API_URL/auth/v1/admin/users"
  else
    method=PUT url="$API_URL/auth/v1/admin/users/$id"
  fi
  body="$(printf '{"email":"%s","password":"%s","email_confirm":true,"user_metadata":{"full_name":"Sam Staff"}}' \
    "$STAFF_EMAIL" "$STAFF_PASSWORD")"
  code="$(curl -s -o "$OUT/staff-user.json" -w '%{http_code}' -X "$method" "$url" \
    -H "apikey: $SERVICE_ROLE_KEY" -H "authorization: Bearer $SERVICE_ROLE_KEY" \
    -H "content-type: application/json" -d "$body")"
  if [ "$code" != 200 ]; then
    echo "GoTrue answered $code to $method $url. See $OUT/staff-user.json." >&2
    exit 1
  fi
  psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=1 \
    -v practice="Local Rehab" -v staff_id="$(staff_id)" -v staff_email="$STAFF_EMAIL" \
    -v group_name="Local Group" -v facility_name="Charlotte Clinic" -v facility_city=Charlotte \
    -v payer_name="Local Payer" -f "$ROOT/scripts/e2e/onboarding-fixture.sql" >/dev/null
fi

pids=()
stop_servers() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap stop_servers EXIT INT TERM

node "$ROOT/scripts/e2e/mail-capture.mjs" "$MAIL_PORT" >"$OUT/mail-capture.log" 2>&1 &
pids+=($!)

APP_ORIGIN="http://127.0.0.1:$APP_PORT"
# Every Supabase and email variable the app reads is set here, so nothing in
# .env or the shell can point this run at a hosted project or at SendGrid.
(
  cd "$ROOT"
  exec env \
    VITE_SUPABASE_URL="$API_URL" \
    VITE_SUPABASE_ANON_KEY="$ANON_KEY" \
    SUPABASE_URL="$API_URL" \
    SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" \
    SUPABASE_ANON_KEY="$ANON_KEY" \
    SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
    SENDGRID_API_KEY=local-capture \
    SENDGRID_FROM_EMAIL=no-reply@example.test \
    SENDGRID_FROM_NAME="Minted Panel" \
    SENDGRID_SANDBOX=false \
    SENDGRID_API_URL="http://127.0.0.1:$MAIL_PORT/v3/mail/send" \
    APP_BASE_URL="$APP_ORIGIN" \
    ONBOARDING_OPS_EMAIL=ops@example.test \
    node node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port "$APP_PORT" --strictPort
) >"$OUT/vite.log" 2>&1 &
pids+=($!)

ready=""
for _ in $(seq 1 120); do
  if curl -sf "$APP_ORIGIN/api/health" >/dev/null && curl -sf "http://127.0.0.1:$MAIL_PORT/messages" >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "The servers did not start. See $OUT/vite.log and $OUT/mail-capture.log." >&2
  exit 1
fi

if [ -n "$SERVE" ]; then
  # Before the banner, so a Ctrl-C the moment it shows still exits cleanly.
  trap 'exit 0' INT TERM
  cat <<EOF

Minted Panel is running on the local stack.
  App     $APP_ORIGIN/login
  Staff   $STAFF_EMAIL / $STAFF_PASSWORD (admin of Local Rehab)
  Inbox   http://127.0.0.1:$MAIL_PORT/ (every email the app sends, newest first)
  Studio  ${STUDIO_URL:-not running}
  DB      psql "$DB_URL"
  Logs    $OUT

Press Ctrl-C to stop the app and the inbox. The stack keeps running.
To stop the stack too, run supabase stop --workdir "$WORKDIR"
EOF
  while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do
    sleep 1
  done
  echo "A server stopped. See $OUT/vite.log and $OUT/mail-capture.log." >&2
  exit 1
fi

status=0
(
  cd "$ROOT"
  E2E_LOCAL_STACK=1 \
    APP_ORIGIN="$APP_ORIGIN" \
    LOCAL_API_URL="$API_URL" \
    LOCAL_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
    LOCAL_DB_URL="$DB_URL" \
    MAIL_CAPTURE_URL="http://127.0.0.1:$MAIL_PORT" \
    npx playwright test --config playwright.local-stack.config.ts "$@"
) || status=$?
exit "$status"
