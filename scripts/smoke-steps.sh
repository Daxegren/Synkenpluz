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
if [ "${SMOKE_PROD:-}" = "1" ]; then
  # Rökprov av det kompilerade produktionsbygget (samma sak som körs i containern).
  npm run build >/dev/null
  ADMIN="node dist/scripts/admin.js"
  SERVER_CMD="node dist/src/main.js"
else
  ADMIN="npx tsx scripts/admin.ts"
  SERVER_CMD="node --import tsx src/main.ts"
fi

echo "== Administration =="
$ADMIN create-tenant T1 "Testkund"
$ADMIN set-accounts T1 1930 1580 6570 2641
$ADMIN set-mode T1 live
KEY="$($ADMIN issue-key T1 30 | tail -1)"
echo '{"clientId":"hemlig-id","clientSecret":"hemlig-nyckel"}' | $ADMIN set-connection T1 fortnox
$ADMIN list-tenants

echo "== Ogiltig indata får inte skrivas ut =="
if OUT="$(echo '{"token": "sk_live_HEMLIG' | $ADMIN set-connection T1 fortnox 2>&1)"; then echo "FEL: ogiltig JSON accepterades"; exit 1; fi
if echo "$OUT" | grep -q "sk_live"; then echo "FEL: hemlighet i felutskrift"; exit 1; fi
echo "felmeddelande: $OUT"
if $ADMIN issue-key T1 30d >/dev/null 2>&1; then echo "FEL: ogiltigt dagsvärde accepterades"; exit 1; fi
echo "ogiltigt dagsvärde avvisades"

echo "== Server =="
$SERVER_CMD >"$(dirname "$0")/../.smoke-server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "health:        $(curl -s http://127.0.0.1:$PORT/health)"
echo "utan nyckel:   HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/v1/payouts)"
echo "med nyckel:    $(curl -s -H "x-api-key: $KEY" http://127.0.0.1:$PORT/v1/payouts)"
APP_HEADERS="$(curl -s -D - -o /dev/null http://127.0.0.1:$PORT/app)"
echo "webbgränssnitt: $(echo "$APP_HEADERS" | head -1 | tr -d '\r')"
echo "$APP_HEADERS" | grep -qi "content-security-policy: default-src 'none'" || { echo "FEL: /app saknar strikt CSP"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/app/app.js)" = "200" ] || { echo "FEL: /app/app.js levereras inte"; exit 1; }
echo "fel nyckel:    HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: ${KEY}x" http://127.0.0.1:$PORT/v1/payouts)"

echo "== Nedstängning =="
kill -TERM $SERVER
wait $SERVER && echo "servern avslutades med kod 0" || { echo "servern avslutades med fel"; exit 1; }
trap - EXIT

if grep -q "hemlig-nyckel\|$KEY" .smoke-server.log; then echo "FEL: hemlighet i serverloggen"; exit 1; fi
echo "inga hemligheter i serverloggen"
rm -f .smoke-server.log
echo "OK"
