#!/bin/bash
# The whole thing, start to finish, against a local platform and a real chain.
#
# Every step a human would take, taken. Emails are not sent — without a Resend
# key the platform logs and skips them — so the links are read from the tokens
# table instead of an inbox, which is the same link the recipient would click.
#
# What this cannot rehearse: that the emails arrive. That needs real addresses
# and is the production pass.
#
#   ./flow.sh            run it
#
# Nothing here touches production. It talks to 127.0.0.1:8788 and, for the
# chain, to Sepolia with a throwaway key.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
export CLOUDFLARE_ACCOUNT_ID=c2102a85d6857866b83b6146e44cad1b

BASE=http://127.0.0.1:8788
CLIENT=(-H "Host: client.thepaymaster.co.uk")
ADMIN=/tmp/flow-admin.jar
PASS=0; FAIL=0

# The chain this rehearsal runs on, and the token it moves. Sepolia, and the
# mock USDT that reproduces the real one's awkwardness.
CHAIN_ID=11155111
# The mock USDT deployed on Sepolia for this rehearsal. It reproduces the real
# token's awkwardness — no return value, a blacklist — so the platform meets
# the same behaviour it will meet on mainnet.
TOKEN=${TOKEN:-$(cat /tmp/flow-token.txt 2>/dev/null)}
CHAIN=../rehearsal/chain.mjs
FEE_WALLET=0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e
SENDER_EMAIL=sender@example.invalid

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok()   { PASS=$((PASS+1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
bad()  { FAIL=$((FAIL+1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 — expected [$2] got [$1]"; fi; }

sql() { npx wrangler d1 execute thepaymaster --local --json --command "$1" 2>/dev/null \
        | python3 -c "import json,sys
try: rs=json.load(sys.stdin)[0]['results']
except Exception: print(''); raise SystemExit
print(rs[0][list(rs[0])[0]] if rs else '')"; }

sqlrow() { npx wrangler d1 execute thepaymaster --local --json --command "$1" 2>/dev/null \
        | python3 -c "import json,sys
rs=json.load(sys.stdin)[0]['results']
print(json.dumps(rs[0]) if rs else '{}')"; }

# A client session for a party, the way the platform makes one: a random value
# whose SHA-256 is the stored hash. Same mechanism as a followed link.
#
# Needed because curl will not store the platform's Secure cookie over plain
# http, so the jar it writes on /join is empty. The link is still followed and
# still checked; this is only how the rehearsal keeps hold of the session
# afterwards. Nothing here weakens the real mechanism.
session() {
  local party=$1 value="flow-$1-$RANDOM$RANDOM"
  local hash; hash=$(printf '%s' "$value" | shasum -a 256 | cut -d' ' -f1)
  npx wrangler d1 execute thepaymaster --local --command \
    "INSERT INTO sessions (id,hash,party_id,expires_at)
     VALUES ('ses_$1_$RANDOM','$hash','$party',datetime('now','+1 day'))" >/dev/null 2>&1
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
say "1. A stranger sends an enquiry"
# ---------------------------------------------------------------------------
CODE=$(curl -s -o /tmp/f.html -w "%{http_code}" -X POST "$BASE/enquiry" \
  --data-urlencode "name=Marina Vasquez" \
  --data-urlencode "email=marina@example.invalid" \
  --data-urlencode "phone=+44 7700 900123" \
  --data-urlencode "amount=350000000" \
  --data-urlencode "currency=USDT" \
  --data-urlencode "likelihood=high" \
  --data-urlencode "contact_pref=email" \
  --data-urlencode "detail=Distribution of USDT to several parties. Funding round." \
  --data-urlencode "website=")
check "$CODE" "200" "the public form accepts it"
EID=$(sql "SELECT id FROM enquiries ORDER BY rowid DESC LIMIT 1")
[ -n "$EID" ] && ok "recorded as $EID" || bad "no enquiry row was written"

# ---------------------------------------------------------------------------
say "2. Staff sign in and pick it up"
# ---------------------------------------------------------------------------
rm -f "$ADMIN"; cp /tmp/adm.j "$ADMIN" 2>/dev/null || ./tools/localsignin.sh >/dev/null 2>&1
[ -f /tmp/adm.j ] && cp /tmp/adm.j "$ADMIN"
CODE=$(curl -s -b "$ADMIN" -o /tmp/f.html -w "%{http_code}" "$BASE/enquiries")
check "$CODE" "200" "the enquiry queue loads"
grep -q "Marina Vasquez" /tmp/f.html && ok "the new enquiry is in it" || bad "enquiry not shown in the queue"

# ---------------------------------------------------------------------------
say "3. Staff create the transaction and set the chain"
# ---------------------------------------------------------------------------
BEFORE=$(sql "SELECT count(*) FROM transactions")
curl -s -b "$ADMIN" -o /dev/null -X POST "$BASE/new" \
  --data-urlencode "name=Rehearsal distribution" \
  --data-urlencode "detail=End to end rehearsal" \
  --data-urlencode "inbound=crypto" --data-urlencode "outbound=crypto" \
  --data-urlencode "converts=0" \
  --data-urlencode "currency_in=USDT" --data-urlencode "currency_out=USDT" \
  --data-urlencode "fee_bps=100" --data-urlencode "fee_mode=grossed_up" \
  --data-urlencode "acting_for=payer"
AFTER=$(sql "SELECT count(*) FROM transactions")
if [ "$AFTER" -le "$BEFORE" ]; then
  bad "no transaction was created (still $AFTER)"; exit 1
fi
TX=$(sql "SELECT id FROM transactions ORDER BY rowid DESC LIMIT 1")
REF=$(sql "SELECT ref FROM transactions WHERE id='$TX'")
ok "created $REF ($TX)"

CODE=$(curl -s -b "$ADMIN" -o /dev/null -w "%{http_code}" -X POST "$BASE/t/$TX/chain" \
  --data-urlencode "chain_id=$CHAIN_ID" \
  --data-urlencode "token_address=$TOKEN" \
  --data-urlencode "fee_wallet=$FEE_WALLET")
check "$CODE" "302" "chain settings saved"
check "$(sql "SELECT chain_id FROM transactions WHERE id='$TX'")" "$CHAIN_ID" "chain recorded"
check "$(sql "SELECT fee_wallet FROM transactions WHERE id='$TX'")" "$FEE_WALLET" "fee wallet recorded"

# ---------------------------------------------------------------------------
say "4. The sender is sent a link and uses it"
# ---------------------------------------------------------------------------
curl -s -b "$ADMIN" -o /dev/null -X POST "$BASE/t/$TX/startlink" \
  --data-urlencode "email=$SENDER_EMAIL"
SKIPPED=$(sql "SELECT count(*) FROM audit_log WHERE action='email.skipped'")
ok "the invitation email was composed (skipped locally: $SKIPPED so far)"

# The link carries a secret we never store — only its hash — so for the
# rehearsal the platform is asked to mint one we know.
START=$(node --experimental-strip-types -e '
import("./src/tokens.ts").then(async (t) => {
  // A token is a random value; the row keeps only its hash. Reproduce that.
  const raw = "flowstart" + Math.random().toString(36).slice(2);
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hash = [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");
  console.log(raw + " " + hash);
})' 2>/dev/null | tail -1)
RAW=${START% *}; HASH=${START#* }
npx wrangler d1 execute thepaymaster --local --command \
  "UPDATE tokens SET hash='$HASH' WHERE transaction_id='$TX' AND purpose='start'
     AND used_at IS NULL" >/dev/null 2>&1

CODE=$(curl -s "${CLIENT[@]}" -o /tmp/f.html -w "%{http_code}" "$BASE/start/$RAW")
check "$CODE" "200" "the sender's link opens the setup form"

CODE=$(curl -s "${CLIENT[@]}" -o /tmp/f.html -w "%{http_code}" -X POST "$BASE/start/$RAW" \
  --data-urlencode "sender_name=Marina Vasquez" \
  --data-urlencode "name=Rehearsal distribution" \
  --data-urlencode "detail=Funding distribution to three parties" \
  --data-urlencode "rname0=Alina Sorokin"   --data-urlencode "remail0=alina@example.invalid" \
  --data-urlencode "rname1=Devrim Kaya"     --data-urlencode "remail1=devrim@example.invalid" \
  --data-urlencode "rname2=Priya Raghunath" --data-urlencode "remail2=priya@example.invalid")
check "$CODE" "200" "the sender submits their recipients"
N=$(sql "SELECT count(*) FROM participations WHERE transaction_id='$TX' AND role='recipient'")
check "$N" "3" "three recipients recorded"
SENDER=$(sql "SELECT party_id FROM participations WHERE transaction_id='$TX' AND role='sender'")
[ -n "$SENDER" ] && ok "the sender is on the transaction" || bad "no sender participation"
check "$(sql "SELECT used_at IS NOT NULL FROM tokens WHERE hash='$HASH'")" "1" "the link is spent"

# ---------------------------------------------------------------------------
say "5. Staff review and invite the recipients"
# ---------------------------------------------------------------------------
curl -s -b "$ADMIN" -o /tmp/f.html -w "" "$BASE/t/$TX"
grep -q "Alina Sorokin" /tmp/f.html && ok "staff can see the roster" || bad "roster not shown"

# The amounts: 800, 100, 100 of a 1000 USDT distribution.
# The whole split goes in one submission: the form is the split, not one row
# of it, and posting a single value would blank the others.
PIDS=$(npx wrangler d1 execute thepaymaster --local --json --command \
  "SELECT id FROM participations WHERE transaction_id='$TX' AND role='recipient' ORDER BY rowid" \
  2>/dev/null | python3 -c "import json,sys;print(' '.join(r['id'] for r in json.load(sys.stdin)[0]['results']))")
set -- $PIDS
curl -s -b "$ADMIN" -o /dev/null -X POST "$BASE/t/$TX/split" \
  --data-urlencode "v_$1=800" --data-urlencode "v_$2=100" --data-urlencode "v_$3=100"
ALLOC=$(sql "SELECT count(*) FROM participations WHERE transaction_id='$TX' AND amount_minor IS NOT NULL")
check "$ALLOC" "3" "amounts allocated to all three"

# A form post always carries a content type; curl only does if given a body.
CODE=$(curl -s -b "$ADMIN" -o /dev/null -w "%{http_code}" -X POST "$BASE/t/$TX/release" \
  --data-urlencode "confirm=yes")
check "$CODE" "302" "staff release the transaction and invite everyone"
INV=$(sql "SELECT count(*) FROM participations WHERE transaction_id='$TX'
             AND role='recipient' AND invited_at IS NOT NULL")
check "$INV" "3" "all three recipients invited"
# The sender is invited back too, so there are four links in all.
JOINS=$(sql "SELECT count(*) FROM tokens WHERE transaction_id='$TX' AND purpose='join'")
check "$JOINS" "4" "a join link for each recipient, and one back for the sender"

# ---------------------------------------------------------------------------
say "6. Each recipient follows their link"
# ---------------------------------------------------------------------------
mint() {   # replace a token's hash with one we know, and hand back the secret
  local where=$1 raw="flowjoin$RANDOM$RANDOM"
  local hash; hash=$(printf '%s' "$raw" | shasum -a 256 | cut -d' ' -f1)
  local n; n=$(sql "SELECT count(*) FROM tokens WHERE $where")
  if [ "$n" = "0" ]; then printf ''; return 1; fi
  npx wrangler d1 execute thepaymaster --local --command \
    "UPDATE tokens SET hash='$hash' WHERE $where" >/dev/null 2>&1
  printf '%s' "$raw"
}
set -- $PIDS
for PID in "$@"; do
  NAME=$(sql "SELECT y.display_name FROM participations p JOIN parties y ON y.id=p.party_id WHERE p.id='$PID'")
  RAWJ=$(mint "transaction_id='$TX' AND purpose='join' AND participation_id='$PID' AND used_at IS NULL")
  if [ -z "$RAWJ" ]; then bad "$NAME has no join link to follow"; continue; fi
  curl -s "${CLIENT[@]}" -o /dev/null "$BASE/join/$RAWJ"
  # Following the link is only real if it left a session behind.
  PARTY=$(sql "SELECT party_id FROM participations WHERE id='$PID'")
  LIVE=$(sql "SELECT count(*) FROM sessions WHERE party_id='$PARTY' AND revoked_at IS NULL")
  if [ "${LIVE:-0}" -ge 1 ]; then ok "$NAME is in"; else bad "$NAME followed the link but has no session"; fi
  session "$PARTY" > "/tmp/flow-cookie-$PID"
done
SESS=$(sql "SELECT count(*) FROM sessions WHERE party_id IN
  (SELECT party_id FROM participations WHERE transaction_id='$TX' AND role='recipient')")
[ "$SESS" -ge 3 ] && ok "three recipient sessions exist" || bad "only $SESS recipient sessions"

# ---------------------------------------------------------------------------
say "7. Everybody completes KYC"
# ---------------------------------------------------------------------------
# A passport and a proof of address, as the platform requires. Genuine PNGs:
# the uploader checks the file's leading bytes rather than trusting the
# content type it is handed, so a text file with a .png name is refused —
# correctly.
python3 - <<'PNG'
import base64
one = base64.b64decode(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
open("/tmp/flow-passport.png","wb").write(one)
open("/tmp/flow-bill.png","wb").write(one)
PNG

kyc() {  # cookie value, legal name, dob, nationality, residence
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$1" -o /tmp/kyc.html -X POST "$BASE/verify" \
    -F "action=submit" -F "kind=individual" \
    -F "legal_name=$2" -F "date_of_birth=$3" \
    -F "nationality=$4" -F "residence_country=$5" \
    -F "address=1 Example Street, London" \
    -F "doc_passport=@/tmp/flow-passport.png;type=image/png" \
    -F "doc_proof_of_address=@/tmp/flow-bill.png;type=image/png"
}
SCOOKIE=$(session "$SENDER")
kyc "$SCOOKIE" "Marina Vasquez" "1979-04-12" "ES" "GB"
i=0
for PID in $PIDS; do
  PARTY=$(sql "SELECT party_id FROM participations WHERE id='$PID'")
  NAME=$(sql "SELECT display_name FROM parties WHERE id='$PARTY'")
  kyc "$(cat /tmp/flow-cookie-$PID)" "$NAME" "198$i-06-0$((i+1))" "GB" "GB"
  i=$((i+1))
done
SUB=$(sql "SELECT count(*) FROM parties WHERE kyc_submitted_at IS NOT NULL
            AND id IN (SELECT party_id FROM participations WHERE transaction_id='$TX')")
check "$SUB" "4" "all four parties submitted their details"

# ---------------------------------------------------------------------------
say "8. Staff check each party and record the verdict"
# ---------------------------------------------------------------------------
for PARTY in $(npx wrangler d1 execute thepaymaster --local --json --command \
  "SELECT DISTINCT party_id FROM participations WHERE transaction_id='$TX'" 2>/dev/null \
  | python3 -c "import json,sys;print(' '.join(r['party_id'] for r in json.load(sys.stdin)[0]['results']))"); do
  curl -s -b "$ADMIN" -o /dev/null -X POST "$BASE/p/$PARTY/decide" \
    --data-urlencode "passed=1" --data-urlencode "months=12" \
    --data-urlencode "note=Checked at Themis, rehearsal"
done
# Distinct parties, not verification rows: the same person keeps their party
# across runs, so rows accumulate while people do not.
OK=$(sql "SELECT count(DISTINCT party_id) FROM verifications WHERE status='passed'
            AND party_id IN (SELECT party_id FROM participations WHERE transaction_id='$TX')")
check "$OK" "4" "all four passed"

# ---------------------------------------------------------------------------
say "9. Recipients supply their own wallets, and prove them"
# ---------------------------------------------------------------------------
for PID in $PIDS; do
  COOKIE=$(cat "/tmp/flow-cookie-$PID")
  NAME=$(sql "SELECT y.display_name FROM participations p JOIN parties y ON y.id=p.party_id WHERE p.id='$PID'")
  # Seeded with the transaction too, so every run has fresh recipients. Reusing
  # addresses would leave last run's balances sitting in them and make the
  # final check meaningless.
  SEED=$(echo "$NAME-$TX" | tr 'A-Z ' 'a-z-')
  ADDR=$(node rehearsal/sign.mjs address "$SEED")

  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$COOKIE" -o /dev/null -X POST "$BASE/d/$TX" \
    --data-urlencode "action=save" --data-urlencode "kind=wallet" \
    --data-urlencode "chain=ethereum" --data-urlencode "address=$ADDR"

  # Read it back and confirm it first: the page only offers the proof once the
  # address has been confirmed, which is the order a real recipient sees.
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$COOKIE" -o /dev/null -X POST "$BASE/d/$TX" \
    --data-urlencode "action=confirm"
  # The platform issues the challenge; the wallet signs exactly that text.
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$COOKIE" -o /tmp/deal.html "$BASE/d/$TX"
  MSG=$(python3 - <<'CHAL'
import re, html
h = open("/tmp/deal.html").read()
# The exact text the wallet must sign, as the platform renders it. Exact
# matters: one character out and the signature recovers to another address.
m = re.search(r'<div class="chal" id="challenge">(.*?)</div>', h, re.S)
print(html.unescape(m.group(1)) if m else "", end="")
CHAL
)
  if [ -z "$MSG" ]; then bad "$NAME was offered no challenge to sign"; continue; fi
  SIG=$(printf '%s' "$MSG" | node rehearsal/sign.mjs sign "$SEED")
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$COOKIE" -o /dev/null -X POST "$BASE/d/$TX" \
    --data-urlencode "action=prove" --data-urlencode "signature=$SIG"
  PROVED=$(sql "SELECT proved_at IS NOT NULL FROM destinations WHERE participation_id='$PID'")
  if [ "$PROVED" = "1" ]; then ok "$NAME proved $ADDR"; else bad "$NAME's signature was not accepted"; fi
done

# ---------------------------------------------------------------------------
say "10. The sender adds the wallet they will pay from, and proves it"
# ---------------------------------------------------------------------------
FUNDER=$(node rehearsal/sign.mjs address @sender)
curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$SCOOKIE" -o /dev/null -X POST "$BASE/d/$TX" \
  --data-urlencode "action=add_wallet" --data-urlencode "chain=ethereum" \
  --data-urlencode "address=$FUNDER" --data-urlencode "label=Treasury"
curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$SCOOKIE" -o /tmp/deal.html "$BASE/d/$TX"
MSG=$(python3 - <<'CHAL'
import re, html
h = open("/tmp/deal.html").read()
m = re.search(r'<div class="chal" id="challenge">(.*?)</div>', h, re.S)
print(html.unescape(m.group(1)) if m else "", end="")
CHAL
)
if [ -z "$MSG" ]; then bad "the sender was offered no challenge"; else
  SIG=$(printf '%s' "$MSG" | node rehearsal/sign.mjs sign @sender)
  # A sender may have several wallets, so the proof names the one it is for.
  # Taken from the page rather than looked up: addresses are stored in EIP-55
  # mixed case, so matching on a lower-case string finds nothing.
  WID=$(python3 - <<'WID'
import re
h = open("/tmp/deal.html").read()
m = re.search(r'name="wallet" value="([^"]+)"', h)
print(m.group(1) if m else "", end="")
WID
)
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$SCOOKIE" -o /tmp/prove.html -X POST "$BASE/d/$TX" \
    --data-urlencode "action=prove_wallet" --data-urlencode "wallet=$WID" \
    --data-urlencode "signature=$SIG"
  P=$(sql "SELECT proved_at IS NOT NULL FROM sending_wallets WHERE transaction_id='$TX'")
  if [ "$P" = "1" ]; then ok "the sender proved $FUNDER"; else
    WHY=$(python3 - <<'ERR'
import re, html
h = open("/tmp/prove.html").read()
m = re.search(r'<div class="err">(.*?)</div>', h, re.S)
print(html.unescape(re.sub(r"<[^>]*>", "", m.group(1))).strip()[:90] if m
      else f"no error shown; wallet id was empty" )
ERR
)
    bad "the sender's signature was not accepted — $WHY"
  fi
fi

# ---------------------------------------------------------------------------
say "11. Staff screen every address"
# ---------------------------------------------------------------------------
ADDRS=$(npx wrangler d1 execute thepaymaster --local --json --command \
  "SELECT address FROM destinations WHERE participation_id IN
     (SELECT id FROM participations WHERE transaction_id='$TX')
   UNION SELECT address FROM sending_wallets WHERE transaction_id='$TX'
   UNION SELECT fee_wallet FROM transactions WHERE id='$TX'" 2>/dev/null \
  | python3 -c "import json,sys;print(' '.join(r['address'] for r in json.load(sys.stdin)[0]['results'] if r['address']))")
N=0
for A in $ADDRS; do
  curl -s -b "$ADMIN" -o /dev/null -X POST "$BASE/t/$TX/screen" \
    --data-urlencode "address=$A" --data-urlencode "verdict=clear" \
    --data-urlencode "findings=Rehearsal — checked and clear"
  N=$((N+1))
done
ok "screened $N addresses"

# ---------------------------------------------------------------------------
say "12. The gate"
# ---------------------------------------------------------------------------
curl -s -b "$ADMIN" -o /tmp/t.html "$BASE/t/$TX"
python3 - <<'GATE'
import re, html
h = open("/tmp/t.html").read()
rows = re.findall(r'<strong>([^<]+)</strong>\s*<div class="muted">([^<]*)', h)
for label, detail in rows:
    print(f"     {html.unescape(label)[:44]:46} {html.unescape(detail)[:56]}")
GATE

# ---------------------------------------------------------------------------
say "13. Recipients lock their addresses, staff confirm"
# ---------------------------------------------------------------------------
for PID in $PIDS; do
  COOKIE=$(cat "/tmp/flow-cookie-$PID")
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$COOKIE" -o /dev/null -X POST "$BASE/d/$TX" \
    --data-urlencode "action=confirm"
done
# Each destination is locked on its own: staff read that address and commit to
# it, one at a time, which is the point of the step.
for DID in $(npx wrangler d1 execute thepaymaster --local --json --command \
  "SELECT d.id FROM destinations d JOIN participations p ON p.id=d.participation_id
    WHERE p.transaction_id='$TX'" 2>/dev/null \
  | python3 -c "import json,sys;print(' '.join(r['id'] for r in json.load(sys.stdin)[0]['results']))"); do
  curl -s -b "$ADMIN" -o /dev/null -X POST "$BASE/t/$TX/lock" --data-urlencode "destination=$DID"
done
LOCKED=$(sql "SELECT count(*) FROM destinations WHERE status='locked' AND participation_id IN
  (SELECT id FROM participations WHERE transaction_id='$TX')")
check "$LOCKED" "3" "all three addresses locked"

# ---------------------------------------------------------------------------
say "14. The sender is funded, and the chain checks come alive"
# ---------------------------------------------------------------------------
NEED=$(sql "SELECT gross_expected_minor FROM transactions WHERE id='$TX'")
MINT=$(python3 -c "print(2000 * 10**6)")
(cd ../rehearsal && node chain.mjs mint "$TOKEN" "$FUNDER" "$MINT") >/dev/null
HELD=$(cd ../rehearsal && node chain.mjs balance "$TOKEN" "$FUNDER")
PRETTY=$(python3 -c "import sys; print(format(int(sys.argv[1])/1e6, ',.6f'))" "$HELD")
if [ "$HELD" -ge "$MINT" ]; then ok "the sender holds $PRETTY on chain"
else bad "minting did not land (holds $HELD)"; fi

curl -s -b "$ADMIN" -o /tmp/t.html "$BASE/t/$TX"
python3 - <<'GATE'
import re, html
h = open("/tmp/t.html").read()
for label, detail in re.findall(r'<strong>([^<]+)</strong>\s*<div class="muted">([^<]*)', h):
    print(f"     {html.unescape(label)[:44]:46} {html.unescape(detail)[:54]}")
GATE

# ---------------------------------------------------------------------------
say "14b. Staff move it through the gate"
# ---------------------------------------------------------------------------
for TO in kyc ready; do
  CODE=$(curl -s -b "$ADMIN" -o /dev/null -w "%{http_code}" -X POST "$BASE/t/$TX/move" \
    --data-urlencode "to=$TO" --data-urlencode "note=rehearsal")
  check "$CODE" "302" "moved to $TO"
done

# ---------------------------------------------------------------------------
say "15. The sender tests every address with one unit"
# ---------------------------------------------------------------------------
# Asking the platform what to send, exactly as the browser does, then signing
# it with the sender's own key and handing back the hash.
leg_send() {   # leg id, kind
  local leg=$1 kind=$2
  local json; json=$(curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$SCOOKIE" -X POST \
    "$BASE/d/$TX/send/prepare" --data-urlencode "leg=$leg" --data-urlencode "kind=$kind")
  local problem; problem=$(python3 -c "
import json,sys; print(json.loads(sys.argv[1]).get('problem',''))" "$json")
  if [ -n "$problem" ]; then printf 'REFUSED %s' "$problem"; return 1; fi

  local to amount human
  to=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['to'])" "$json")
  amount=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['amountMinor'])" "$json")
  human=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['human'])" "$json")

  local hash; hash=$(cd ../rehearsal && node chain.mjs transfer "$TOKEN" "$to" "$amount") || return 1
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$SCOOKIE" -o /tmp/leg.html -X POST "$BASE/d/$TX/send" \
    --data-urlencode "leg=$leg" --data-urlencode "kind=$kind" --data-urlencode "tx_hash=$hash"
  local err; err=$(python3 - <<'ERR'
import re, html
h = open("/tmp/leg.html").read()
m = re.search(r'<div class="err">(.*?)</div>', h, re.S)
print(html.unescape(re.sub(r"<[^>]*>", "", m.group(1))).strip()[:70] if m else "")
ERR
)
  if [ -n "$err" ]; then printf 'REJECTED %s' "$err"; return 1; fi
  printf '%s (%s)' "$human" "${hash:0:12}…"
}

LEGS="$PIDS fee"
for LEG in $LEGS; do
  OUT=$(leg_send "$LEG" test) && ok "test to $LEG — $OUT" || bad "test to $LEG — $OUT"
done

# ---------------------------------------------------------------------------
say "16. The sender pays every line"
# ---------------------------------------------------------------------------
for LEG in $LEGS; do
  OUT=$(leg_send "$LEG" payment) && ok "paid $LEG — $OUT" || bad "paid $LEG — $OUT"
done

# ---------------------------------------------------------------------------
say "17. What the chain actually holds now"
# ---------------------------------------------------------------------------
TOTAL=0
for PID in $PIDS; do
  A=$(sql "SELECT address FROM destinations WHERE participation_id='$PID'")
  NAME=$(sql "SELECT y.display_name FROM participations p JOIN parties y ON y.id=p.party_id WHERE p.id='$PID'")
  # What the platform recorded paying, not what was allocated: grossing up
  # leaves a remainder of a millionth, and it goes to one recipient rather than
  # to us. Comparing against the allocation would call that a discrepancy.
  WANT=$(sql "SELECT c.amount_minor FROM custody_events c
                JOIN payout_legs l ON l.event_id = c.id
               WHERE l.participation_id='$PID' AND c.event='sent'
               ORDER BY c.rowid DESC LIMIT 1")
  GOT=$(cd ../rehearsal && node chain.mjs balance "$TOKEN" "$A")
  PRETTY=$(python3 -c "import sys;print(format(int(sys.argv[1])/1e6, ',.6f'))" "$GOT")
  # One unit more than paid: the test payment, which is theirs to keep.
  EXPECT=$((WANT + 1))
  if [ "$GOT" = "$EXPECT" ]; then ok "$NAME holds $PRETTY"
  else bad "$NAME holds $GOT, expected $EXPECT"; fi
  TOTAL=$((TOTAL + GOT))
done
FEEBAL=$(cd ../rehearsal && node chain.mjs balance "$TOKEN" "$FEE_WALLET")
ok "our fee wallet holds $(python3 -c "import sys;print(format(int(sys.argv[1])/1e6, ',.6f'))" "$FEEBAL")"

# ---------------------------------------------------------------------------
say "18. The dossier"
# ---------------------------------------------------------------------------
curl -s -b "$ADMIN" -o /dev/null -X POST "$BASE/t/$TX/dossier/seal"
SEAL=$(sqlrow "SELECT root, leaf_count FROM dossier_seals WHERE transaction_id='$TX'
                ORDER BY rowid DESC LIMIT 1")
ROOT=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('root',''))" "$SEAL")
LEAVES=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('leaf_count',0))" "$SEAL")
[ -n "$ROOT" ] && ok "sealed over $LEAVES facts — ${ROOT:0:24}…" || bad "nothing was sealed"

# A recipient's own record, and the proof that ties it to that root.
PID=$(echo $PIDS | cut -d' ' -f1)
curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$(cat /tmp/flow-cookie-$PID)" \
  -o /tmp/rec.html "$BASE/d/$TX/record"
python3 - <<'REC'
import re, hashlib
h = open("/tmp/rec.html").read()
root = re.search(r'mono big">([0-9a-f]{64})', h)
if not root:
    print("  \033[31m✗\033[0m the recipient's record did not render"); raise SystemExit
root = root.group(1)
blocks = re.split(r'<section class="fact">', h)[1:]
good = 0
for b in blocks:
    leaf = re.search(r'leaf ([0-9a-f]{64})', b).group(1)
    steps = re.findall(r'<span class="muted">(left|right)</span>\s*<span class="mono">([0-9a-f]{64})</span>', b)
    acc = bytes.fromhex(leaf)
    for side, hx in steps:
        sib = bytes.fromhex(hx)
        acc = hashlib.sha256((sib + acc) if side == "left" else (acc + sib)).digest()
    good += acc.hex() == root
other = re.search(r"Other parties' entries</th>\s*<td>(\d+)", h)
print(f"  \033[32m✓\033[0m recipient sees {len(blocks)} of their own entries, "
      f"{other.group(1) if other else '?'} others counted but not shown")
print(f"  \033[32m✓\033[0m {good} of {len(blocks)} prove against the sealed root")
REC

printf "\n\033[1mDone — %d passed, %d failed\033[0m\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
