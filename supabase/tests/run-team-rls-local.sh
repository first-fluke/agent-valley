#!/usr/bin/env bash
# Creates and removes a private, synthetic PostgreSQL cluster. Never connects remotely.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pg_bin_dir=""
for candidate in \
  "${PG_BIN_DIR:-}" \
  /opt/homebrew/opt/postgresql@18/bin \
  /opt/homebrew/opt/postgresql@17/bin \
  /usr/local/opt/postgresql@18/bin \
  /usr/local/opt/postgresql@17/bin \
  /usr/lib/postgresql/{18,17,16,15,14}/bin \
  "$(dirname "$(command -v postgres 2>/dev/null || printf /no/postgres)")"; do
  if [[ -n "$candidate" && -x "$candidate/postgres" && -x "$candidate/initdb" && -x "$candidate/pg_ctl" && -x "$candidate/psql" ]]; then
    pg_bin_dir=$candidate
    break
  fi
done

if [[ -z "$pg_bin_dir" ]]; then
  printf '%s\n' 'UNAVAILABLE: local PostgreSQL server binary is not installed; SQL RLS runtime test not run.' >&2
  exit 77
fi

cluster_root=$(mktemp -d /tmp/av-team-rls.XXXXXXXX)
mkdir "$cluster_root/socket"
started=0
cleanup() {
  if [[ "$started" == 1 ]]; then
    "$pg_bin_dir/pg_ctl" -D "$cluster_root/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$cluster_root"
}
trap cleanup EXIT

"$pg_bin_dir/initdb" -D "$cluster_root/data" -A trust -U postgres --no-instructions >/dev/null
port=$((50000 + RANDOM % 10000))
"$pg_bin_dir/pg_ctl" -D "$cluster_root/data" -l "$cluster_root/server.log" \
  -o "-c listen_addresses='' -k $cluster_root/socket -p $port" -w start >/dev/null
started=1
psql=("$pg_bin_dir/psql" -X -q -v ON_ERROR_STOP=1 -h "$cluster_root/socket" -p "$port" -U postgres -d postgres)

"${psql[@]}" -f "$script_dir/team_rls_fixture.sql"

baseline_output=""
if baseline_output=$("${psql[@]}" -c "set role authenticated; set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; select count(*) from public.team_members;" 2>&1); then
  printf '%s\n' 'FAIL: pre-migration team_members query unexpectedly succeeded.' >&2
  exit 1
fi
if [[ "$baseline_output" != *'infinite recursion detected in policy for relation "team_members"'* ]]; then
  printf 'FAIL: pre-migration query failed for another reason: %s\n' "$baseline_output" >&2
  exit 1
fi
printf '%s\n' 'Confirmed baseline: team_members select triggers infinite RLS recursion.'

"${psql[@]}" -f "$script_dir/../migrations/002_team_rls_identity.sql"
"${psql[@]}" -f "$script_dir/team_rls_regression.sql"
