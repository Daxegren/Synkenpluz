#!/usr/bin/env bash
# Startar en temporär Postgres-instans, kör test/pg mot den och städar alltid efteråt.
#
# Env (valfria):
#   PG_BIN        katalog med initdb/pg_ctl (default /usr/lib/postgresql/16/bin)
#   PG_TEST_PORT  fast port (default: dynamiskt ledig port)
#   PG_RUN_USER   icke-root-användare som kör servern när skriptet körs som root (default postgres)
# Extra argument skickas vidare till vitest.
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_RUN_USER="${PG_RUN_USER:-postgres}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -x "$PG_BIN/initdb" ] || { echo "hittar inte $PG_BIN/initdb (sätt PG_BIN)" >&2; exit 2; }

TMP="$(mktemp -d /tmp/synkenpluz-pg.XXXXXX)"
if [ "$(id -u)" = 0 ]; then
  command -v runuser >/dev/null || { echo "kör som root men runuser saknas" >&2; exit 2; }
  chown "$PG_RUN_USER" "$TMP"
  as_pg() { runuser -u "$PG_RUN_USER" -- "$@"; }
else
  as_pg() { "$@"; }
fi

PORT="${PG_TEST_PORT:-$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")}"
STARTED=0

cleanup() {
  local code=$?
  if [ "$STARTED" = 1 ]; then
    as_pg "$PG_BIN/pg_ctl" -D "$TMP/data" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT INT TERM

as_pg "$PG_BIN/initdb" -D "$TMP/data" -U postgres --auth=trust --encoding=UTF8 --locale=C >"$TMP/initdb.log" 2>&1 \
  || { cat "$TMP/initdb.log" >&2; exit 1; }

# fsync av: temporär instans, snabbare. unix_socket_directories i TMP så inget skräp i /var/run.
as_pg "$PG_BIN/pg_ctl" -D "$TMP/data" -l "$TMP/server.log" -w \
  -o "-p $PORT -h 127.0.0.1 -k $TMP -c fsync=off -c max_connections=100" start >/dev/null \
  || { cat "$TMP/server.log" >&2; exit 1; }
STARTED=1

echo "Postgres $("$PG_BIN/postgres" --version | awk '{print $3}') på 127.0.0.1:$PORT (temporär, katalog $TMP)"
cd "$ROOT"
export PG_TEST_URL="postgres://postgres@127.0.0.1:$PORT/postgres"
# PG_RUN_CMD kör ett eget kommando mot instansen i stället för testerna (används av scripts/smoke.sh).
if [ -n "${PG_RUN_CMD:-}" ]; then
  bash -c "$PG_RUN_CMD"
else
  npx vitest run test/pg "$@"
fi
