#!/usr/bin/env bash
# Read-only drift check: compares a database's catalog fingerprint to
# tests/migration/production-fingerprint.json.
# Run from backend/:  PROD_READONLY_URL='postgresql://...' bash verify-prod-fingerprint.sh
# Exit 0 = all 7 categories match. Exit 1 = drift. Exit 2 = could not run safely.
set -euo pipefail
: "${PROD_READONLY_URL:?set PROD_READONLY_URL (use a read-only role; do not paste it into chat)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SQL="$HERE/tests/migration/fingerprint.sql"
EXP="$HERE/tests/migration/production-fingerprint.json"
[ -f "$SQL" ] && [ -f "$EXP" ] || { echo "run from backend/ (fingerprint files not found)"; exit 2; }

export PGOPTIONS='-c default_transaction_read_only=on'
export PGCONNECT_TIMEOUT=15

# Safety gate: refuse to proceed unless the session is truly read-only.
RO="$(psql "$PROD_READONLY_URL" -tA -c 'show transaction_read_only' 2>/dev/null || true)"
[ "$RO" = "on" ] || { echo "ABORT: session is not read-only (got '${RO:-no connection}')"; exit 2; }

OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
psql "$PROD_READONLY_URL" -v ON_ERROR_STOP=1 -tA -F'|' -f "$SQL" > "$OUT"

EXP="$EXP" OUT="$OUT" node -e '
const fs=require("fs");
const exp=JSON.parse(fs.readFileSync(process.env.EXP,"utf8"));
const rows=fs.readFileSync(process.env.OUT,"utf8").trim().split("\n").map(l=>l.split("|"));
const seen=new Set();let bad=0;
for(const [cat,n,h] of rows){seen.add(cat);const e=exp[cat];const ok=e&&String(e.n)===n&&e.h===h;
  if(!ok)bad++;console.log((ok?"MATCH    ":"MISMATCH ")+cat.padEnd(20)+" n="+n+(ok?"":"  (expected n="+(e&&e.n)+")"));}
for(const k of Object.keys(exp)) if(!k.startsWith("_")&&!seen.has(k)){bad++;console.log("MISSING  "+k);}
console.log(bad?"\nDRIFT: "+bad+" categor"+(bad>1?"ies":"y")+" differ. Do NOT apply 021; diff those categories first.":"\nOK: live catalog matches the committed production fingerprint.");
process.exit(bad?1:0)'
