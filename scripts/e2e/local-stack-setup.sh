#!/usr/bin/env bash
# Builds or updates a LOCAL Supabase stack that the provider onboarding build
# runs on, so scripts/e2e/onboarding-local-stack.sh (the real-stack test, or
# --serve for a hand walk-through) and the SQL smokes work against it.
#
#   bash scripts/e2e/local-stack-setup.sh [--workdir DIR] [--port-base N]
#
# DIR defaults to ~/.minted-local-supabase. N defaults to 554, which gives the
# API port 55421, the database 55422, Studio 55423 and the shadow database
# 55420. The project id is derived from N, so stacks with different port bases
# never share containers. Keep one port base per DIR.
#
# The repo's supabase/config.toml can't start a local stack (CLAUDE.md, Known
# warts), so this script keeps its own project in DIR:
# - DIR/supabase/config.toml: Postgres 17, seed off, Studio on, only the
#   services the app uses. Rewritten on every run.
# - DIR/supabase/migrations: links to this repo's migrations. A file whose
#   version another file already took gets the next free version, because
#   the migration ledger refuses a duplicate.
# Then it starts the stack, or applies new migrations to the running one,
# creates the two Vault secrets with random values when they are missing, and
# runs the auth grants the migrations can't make locally. Every step is safe
# to rerun. It refuses an API or database that is not on this machine and
# never prints a key.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$HOME/.minted-local-supabase"
PORT_BASE=554

while [ $# -gt 0 ]; do
  case "$1" in
    --workdir) DIR="${2:?--workdir needs a directory}" && shift 2 ;;
    --port-base) PORT_BASE="${2:?--port-base needs a number}" && shift 2 ;;
    -h | --help) echo "Usage: $0 [--workdir DIR] [--port-base N]" && exit 0 ;;
    *) echo "Unknown argument: $1. Usage: $0 [--workdir DIR] [--port-base N]" >&2 && exit 1 ;;
  esac
done

case "$PORT_BASE" in
  [1-9][0-9] | [1-9][0-9][0-9]) ;;
  *) echo "--port-base must be a number from 10 to 655." >&2 && exit 1 ;;
esac
if [ "$PORT_BASE" -gt 655 ]; then
  echo "--port-base must be a number from 10 to 655." >&2
  exit 1
fi

for tool in docker supabase psql; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is not on PATH." >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop, then run this again." >&2
  exit 1
fi

mkdir -p "$DIR/supabase/migrations"
DIR="$(cd "$DIR" && pwd)"
if [ "$DIR" = "$ROOT" ]; then
  echo "Use a directory outside the repo for --workdir." >&2
  exit 1
fi
MIGRATIONS="$DIR/supabase/migrations"
if [ -n "$(find "$MIGRATIONS" -mindepth 1 -maxdepth 1 ! -type l)" ]; then
  echo "$MIGRATIONS holds files that are not links. This script manages only links. Use another --workdir." >&2
  exit 1
fi

API_PORT="${PORT_BASE}21"
DB_PORT="${PORT_BASE}22"
STUDIO_PORT="${PORT_BASE}23"
SHADOW_PORT="${PORT_BASE}20"
LOG="$DIR/setup.log"

cat >"$DIR/supabase/config.toml" <<TOML
# Written by scripts/e2e/local-stack-setup.sh. Rerunning it rewrites this file.
project_id = "minted-local-$PORT_BASE"

[api]
port = $API_PORT
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]

[db]
port = $DB_PORT
shadow_port = $SHADOW_PORT
major_version = 17

[db.seed]
enabled = false

[db.pooler]
enabled = false

[studio]
enabled = true
port = $STUDIO_PORT

[auth]
enabled = true
site_url = "http://127.0.0.1:8091"

[storage]
enabled = true

[inbucket]
enabled = false

[realtime]
enabled = false

[analytics]
enabled = false

[edge_runtime]
enabled = false
TOML

find "$MIGRATIONS" -mindepth 1 -maxdepth 1 -type l -delete
used=" "
for file in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$file")"
  version="${name%%_*}"
  while case "$used" in *" $version "*) true ;; *) false ;; esac; do
    version=$((version + 1))
  done
  used="$used$version "
  ln -s "$file" "$MIGRATIONS/${version}_${name#*_}"
done
echo "Linked $(find "$MIGRATIONS" -type l | wc -l | tr -d ' ') migrations into $MIGRATIONS."

: >"$LOG"
if supabase status --workdir "$DIR" >/dev/null 2>&1; then
  echo "The stack is running."
else
  for port in "$API_PORT" "$DB_PORT" "$STUDIO_PORT"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Port $port is already in use. Pick another --port-base." >&2
      exit 1
    fi
  done
  echo "Starting the stack. The first start pulls Docker images and applies every migration, which takes a few minutes."
  if ! supabase start --workdir "$DIR" >>"$LOG" 2>&1; then
    tail -n 30 "$LOG" >&2
    echo "supabase start failed. The full log is $LOG." >&2
    exit 1
  fi
fi
echo "Applying any migrations the stack does not have yet."
if ! supabase migration up --local --workdir "$DIR" >>"$LOG" 2>&1; then
  tail -n 30 "$LOG" >&2
  echo "supabase migration up failed. The full log is $LOG." >&2
  exit 1
fi

API_URL="" DB_URL="" STUDIO_URL=""
eval "$(supabase status --workdir "$DIR" -o env 2>/dev/null |
  grep -E '^(API_URL|DB_URL|STUDIO_URL)=' || true)"
case "$API_URL" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *) echo "Refusing to continue: the API URL is not on this machine." >&2 && exit 1 ;;
esac
case "$DB_URL" in
  postgresql://*@127.0.0.1:* | postgresql://*@localhost:*) ;;
  *) echo "Refusing to continue: the database is not on this machine." >&2 && exit 1 ;;
esac

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
SELECT vault.create_secret(encode(extensions.gen_random_bytes(32), 'base64'), k.name)
  FROM unnest(ARRAY['ssn_vault_key', 'portal_credentials_key']) AS k(name)
 WHERE NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.name = k.name);
SQL
echo "The Vault secrets ssn_vault_key and portal_credentials_key are in place."

# The migrations run as postgres, which can't grant on the auth schema in a
# local stack; supabase_admin can (local password: postgres).
ADMIN_URL="$(printf '%s' "$DB_URL" | sed 's#^postgresql://postgres:#postgresql://supabase_admin:#')"
psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA auth TO minted_e612_authz_owner;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT SELECT ON auth.users TO service_role;
SQL
echo "The local auth grants are in place."

cat <<EOF

The local stack is ready.
  API     $API_URL
  DB      $DB_URL
  Studio  ${STUDIO_URL:-not running}
  Log     $LOG

Next, start the app on it with a sample practice and a staff login:
  SUPABASE_WORKDIR=$DIR bash scripts/e2e/onboarding-local-stack.sh --serve
Or run the real-stack test:
  SUPABASE_WORKDIR=$DIR bash scripts/e2e/onboarding-local-stack.sh
EOF
