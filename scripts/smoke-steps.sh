#!/usr/bin/env bash
# Rökprovning av den körbara tjänsten mot PG_TEST_URL. Anropas via scripts/smoke.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

export DATABASE_URL="$PG_TEST_URL"
export API_KEY_PEPPER="$(openssl rand -hex 32)"
export MASTER_KEYS="k1:$(openssl rand -hex 32)"
export CYCLE_INTERVAL_MS=0
export PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
export HOST=127.0.0.1
ADMIN="npx tsx scripts/admin.ts"

echo "== Administration =="
$ADMIN create-tenant T1 "Testkund"
$ADMIN set-accounts T1 1930 1580 6570 2641
$ADMIN set-mode T1 live
KEY="$($ADMIN issue-key T1 30 | tail -1)"
echo '{"clientId":"hemlig-id","clientSecret":"hemlig-nyckel"}' | $ADMIN set-connection T1 fortnox
$ADMIN list-tenants

echo "== Server =="
node --import tsx src/main.ts >"$(dirname "$0")/../.smoke-server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "health:        $(curl -s http://127.0.0.1:$PORT/health)"
echo "utan nyckel:   HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/v1/payouts)"
echo "med nyckel:    $(curl -s -H "x-api-key: $KEY" http://127.0.0.1:$PORT/v1/payouts)"
echo "fel nyckel:    HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: ${KEY}x" http://127.0.0.1:$PORT/v1/payouts)"

echo "== Nedstängning =="
kill -TERM $SERVER
wait $SERVER && echo "servern avslutades med kod 0" || { echo "servern avslutades med fel"; exit 1; }
trap - EXIT

if grep -q "hemlig-nyckel\|$KEY" .smoke-server.log; then echo "FEL: hemlighet i serverloggen"; exit 1; fi
echo "inga hemligheter i serverloggen"
rm -f .smoke-server.log
echo "OK"
