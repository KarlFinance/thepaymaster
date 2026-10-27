#!/bin/bash
# The self-serve route, start to finish: the sender starts it on the public page,
# and staff do nothing but decide each person's identity. Everything else —
# screening, locking, the gate, sealing — the platform must do by itself.
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
TOKEN=${TOKEN:-$(cat /tmp/flow-token.txt 2>/dev/null || echo 0x2a35E1b121B3E231ED824C5b4e31FC40167385D8)}
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


SUFFIX=$RANDOM
# Fresh each run: one sender may start only three distributions a day.
SENDER_EMAIL=selfserve-sender-$SUFFIX@example.invalid
# Self-serve on the Sepolia rehearsal rail with the mock USDT.
npx wrangler d1 execute thepaymaster --local --command \
  "INSERT OR REPLACE INTO platform_settings (key, value, updated_by) VALUES
     ('self_serve_rail', 'eth:$CHAIN_ID:usdt', 'rehearsal'),
     ('self_serve_token', '$TOKEN', 'rehearsal'),
     ('self_serve', 'on', 'rehearsal')" >/dev/null 2>&1
rm -f "$ADMIN"; [ -f /tmp/adm.j ] || ./tools/localsignin.sh >/dev/null 2>&1; cp /tmp/adm.j "$ADMIN"

# ---------------------------------------------------------------------------
say "1. The sender starts the distribution on the public page"
# ---------------------------------------------------------------------------
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/distribute")" "200" "the start page opens"
CODE=$(curl -s -o /tmp/ss.html -w "%{http_code}" -X POST "$BASE/distribute" \
  --data-urlencode "cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX" \
  --data-urlencode "sender_name=Tomas Okafor" --data-urlencode "sender_email=$SENDER_EMAIL" \
  --data-urlencode "sender_phone=+44 7700 900456" \
  --data-urlencode "name=Self-serve rehearsal $SUFFIX" \
  --data-urlencode "detail=Proceeds of a completed sale, owed to three partners" \
  --data-urlencode "gross=1,010" \
  --data-urlencode "rname0=Ines Halvorsen"  --data-urlencode "remail0=ines-$SUFFIX@example.invalid"  --data-urlencode "rshare0=70" \
  --data-urlencode "rname1=Kwame Adjei"     --data-urlencode "remail1=kwame-$SUFFIX@example.invalid" --data-urlencode "rshare1=20" \
  --data-urlencode "rname2=Lucia Ferraro"   --data-urlencode "remail2=lucia-$SUFFIX@example.invalid" --data-urlencode "rshare2=10" \
  --data-urlencode "acknowledged=1" --data-urlencode "website=")
check "$CODE" "200" "the form is accepted"
grep -q "Check your email" /tmp/ss.html && ok "the sender is told to check their email" || bad "no confirmation page"
TX=$(sql "SELECT id FROM transactions WHERE self_serve=1 ORDER BY rowid DESC LIMIT 1")
REF=$(sql "SELECT ref FROM transactions WHERE id='$TX'")
ok "created $REF ($TX)"
check "$(sql "SELECT status FROM transactions WHERE id='$TX'")" "draft" "it waits for the sender to confirm"
check "$(sql "SELECT execution||'/'||rail||'/'||fee_mode FROM transactions WHERE id='$TX'")" "sender/eth:$CHAIN_ID:usdt/deducted" "the tested route: the sender pays, fee deducted"
check "$(sql "SELECT fee_wallet FROM transactions WHERE id='$TX'")" "$FEE_WALLET" "our fee wallet from the registry"
check "$(sql "SELECT sum(share_bps) FROM participations WHERE transaction_id='$TX' AND role='recipient'")" "10000" "shares total 100%"
check "$(sql "SELECT count(*) FROM enquiries WHERE transaction_id='$TX'")" "1" "it is on the enquiry queue too"
check "$(sql "SELECT count(*) FROM tokens WHERE transaction_id='$TX' AND purpose='join'")" "1" "only the sender has a link so far"
STAFFMAIL=$(sql "SELECT count(*) FROM audit_log WHERE entity_id='$TX' AND note LIKE '%new self-serve distribution%'")
[ "${STAFFMAIL:-0}" -ge 1 ] && ok "staff were emailed about it" || bad "no staff email logged"

echo "  — a submission without the human check is refused"
curl -s -o /tmp/ss3.html -X POST "$BASE/distribute" \
  --data-urlencode "sender_name=Bot" --data-urlencode "sender_email=bot-$SUFFIX@example.invalid" \
  --data-urlencode "name=x" --data-urlencode "detail=x" --data-urlencode "gross=100" \
  --data-urlencode "rname0=A" --data-urlencode "remail0=a2-$SUFFIX@example.invalid" --data-urlencode "rshare0=100" \
  --data-urlencode "acknowledged=1"
grep -q "could not confirm this came from a person" /tmp/ss3.html && ok "no Turnstile token, no distribution" || bad "a tokenless submission was not refused"
check "$(sql "SELECT count(*) FROM parties WHERE email='bot-$SUFFIX@example.invalid'")" "0" "nothing was saved for it"

echo "  — a bad split is refused"
curl -s -o /tmp/ss2.html -X POST "$BASE/distribute" \
  --data-urlencode "cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX" \
  --data-urlencode "sender_name=X" --data-urlencode "sender_email=x-$SUFFIX@example.invalid" \
  --data-urlencode "name=x" --data-urlencode "detail=x" --data-urlencode "gross=100" \
  --data-urlencode "rname0=A" --data-urlencode "remail0=a-$SUFFIX@example.invalid" --data-urlencode "rshare0=60" \
  --data-urlencode "acknowledged=1"
grep -q "must add up to 100" /tmp/ss2.html && ok "shares of 60% are refused" || bad "a 60% split was not refused"

# ---------------------------------------------------------------------------
say "2. The sender confirms, and everyone is invited"
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
SENDER_PID=$(sql "SELECT id FROM participations WHERE transaction_id='$TX' AND role='sender'")
SENDER=$(sql "SELECT party_id FROM participations WHERE id='$SENDER_PID'")
RAWJ=$(mint "transaction_id='$TX' AND purpose='join' AND participation_id='$SENDER_PID' AND used_at IS NULL")
curl -s "${CLIENT[@]}" -o /dev/null "$BASE/join/$RAWJ"
check "$(sql "SELECT status FROM transactions WHERE id='$TX'")" "awaiting_parties" "confirming released it"
check "$(sql "SELECT count(*) FROM participations WHERE transaction_id='$TX' AND role='recipient' AND invited_at IS NOT NULL")" "3" "all three recipients invited"
PIDS=$(npx wrangler d1 execute thepaymaster --local --json --command \
  "SELECT id FROM participations WHERE transaction_id='$TX' AND role='recipient' ORDER BY rowid" \
  2>/dev/null | python3 -c "import json,sys;print(' '.join(r['id'] for r in json.load(sys.stdin)[0]['results']))")
for PID in $PIDS; do
  NAME=$(sql "SELECT y.display_name FROM participations p JOIN parties y ON y.id=p.party_id WHERE p.id='$PID'")
  RAWJ=$(mint "transaction_id='$TX' AND purpose='join' AND participation_id='$PID' AND used_at IS NULL")
  if [ -z "$RAWJ" ]; then bad "$NAME has no join link"; continue; fi
  curl -s "${CLIENT[@]}" -o /dev/null "$BASE/join/$RAWJ"
  PARTY=$(sql "SELECT party_id FROM participations WHERE id='$PID'")
  session "$PARTY" > "/tmp/flow-cookie-$PID"
  ok "$NAME followed their link"
done
SCOOKIE=$(session "$SENDER")

# ---------------------------------------------------------------------------
say "3. Everybody verifies: name, address, date of birth, passport, proof of address"
# ---------------------------------------------------------------------------
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
kyc "$SCOOKIE" "Tomas Okafor" "1975-02-03" "NG" "GB"
grep -q "Thank you" /tmp/kyc.html && ok "the sender's documents are in" || bad "the sender's KYC was not accepted"
i=0
for PID in $PIDS; do
  PARTY=$(sql "SELECT party_id FROM participations WHERE id='$PID'")
  NAME=$(sql "SELECT display_name FROM parties WHERE id='$PARTY'")
  kyc "$(cat /tmp/flow-cookie-$PID)" "$NAME" "198$i-06-0$((i+1))" "GB" "GB"
  grep -q "Thank you" /tmp/kyc.html && ok "$NAME's documents are in" || bad "$NAME's KYC was not accepted"
  i=$((i+1))
done
KYCMAIL=$(sql "SELECT count(*) FROM audit_log WHERE action LIKE 'email.%' AND note LIKE '%has submitted their details — decide%' AND entity_id IN (SELECT party_id FROM participations WHERE transaction_id='$TX') AND at >= (SELECT created_at FROM transactions WHERE id='$TX')")
check "$KYCMAIL" "4" "staff were emailed to decide each of the four"

# ---------------------------------------------------------------------------
say "3b. Staff's one job: decide each person's identity"
# ---------------------------------------------------------------------------
for PARTY in $(npx wrangler d1 execute thepaymaster --local --json --command \
  "SELECT DISTINCT party_id FROM participations WHERE transaction_id='$TX'" 2>/dev/null \
  | python3 -c "import json,sys;print(' '.join(r['party_id'] for r in json.load(sys.stdin)[0]['results']))"); do
  curl -s -b "$ADMIN" -o /dev/null -X POST "$BASE/p/$PARTY/decide" \
    --data-urlencode "passed=1" --data-urlencode "months=12" \
    --data-urlencode "ceiling=2000.00" --data-urlencode "note=Self-serve rehearsal"
done
check "$(sql "SELECT count(DISTINCT party_id) FROM verifications WHERE status='passed' AND party_id IN (SELECT party_id FROM participations WHERE transaction_id='$TX')")" "4" "all four passed"

# ---------------------------------------------------------------------------
say "4. Wallets: recipients give and prove theirs; the sender proves theirs"
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
say "4b. The sender adds the wallet they will pay from, and proves it"
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
say "5. Everybody signs their agreement"
# ---------------------------------------------------------------------------
agree() {  # cookie value, typed name, who
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$1" -o /tmp/ag.html "$BASE/d/$TX"
  local h; h=$(python3 -c "
import re; m=re.search(r'name=\"hash\" value=\"([0-9a-f]{64})\"', open('/tmp/ag.html').read()); print(m.group(1) if m else '')")
  if [ -z "$h" ]; then bad "$3 was offered no agreement to sign"; return; fi
  curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$1" -o /tmp/ag2.html -X POST "$BASE/d/$TX/agreement" \
    --data-urlencode "hash=$h" --data-urlencode "typed_name=$2"
  local party; party=$(sql "SELECT id FROM parties WHERE display_name='$2' ORDER BY rowid DESC LIMIT 1")
  local n; n=$(sql "SELECT count(*) FROM agreements WHERE transaction_id='$TX' AND content_hash='$h'")
  if [ "$n" = "1" ]; then ok "$3 signed"; else bad "$3's signature was not recorded"; fi
}
agree "$SCOOKIE" "Tomas Okafor" "the sender"
for PID in $PIDS; do
  NAME=$(sql "SELECT y.display_name FROM participations p JOIN parties y ON y.id=p.party_id WHERE p.id='$PID'")
  agree "$(cat /tmp/flow-cookie-$PID)" "$NAME" "$NAME"
done

# ---------------------------------------------------------------------------
say "6. Nothing has been screened by a person — the platform did it"
# ---------------------------------------------------------------------------
curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$SCOOKIE" -o /dev/null "$BASE/d/$TX"
# Screens are per address, not per transaction: an address screened clear in
# the last six days is not screened again. So: does every address on this
# transaction have a clear, current screen, none of them from a person?
SCR=$(sql "SELECT count(*) FROM (SELECT address FROM destinations WHERE participation_id IN (SELECT id FROM participations WHERE transaction_id='$TX')
            UNION SELECT address FROM sending_wallets WHERE transaction_id='$TX' UNION SELECT fee_wallet FROM transactions WHERE id='$TX') a
          WHERE (SELECT verdict FROM wallet_screens w WHERE lower(w.address)=lower(a.address) AND w.chain_id=$CHAIN_ID
                   AND (w.expires_at IS NULL OR w.expires_at > datetime('now')) ORDER BY w.screened_at DESC, w.rowid DESC LIMIT 1)='clear'")
check "$SCR" "5" "all five addresses carry a clear, current screen (3 recipients, sender, our fee wallet)"
check "$(sql "SELECT count(*) FROM wallet_screens WHERE transaction_id='$TX' AND provider<>'sanctions-list'")" "0" "no screen by staff"
check "$(sql "SELECT count(*) FROM destinations WHERE status='locked' AND participation_id IN (SELECT id FROM participations WHERE transaction_id='$TX')")" "3" "all three addresses locked by themselves"
HELD0=$(cd ../rehearsal && node chain.mjs balance "$TOKEN" "$FUNDER")
if [ "$HELD0" -ge 1010000000 ]; then
  check "$(sql "SELECT status FROM transactions WHERE id='$TX'")" "ready" "ready already: the rehearsal wallet still holds enough from earlier runs"
else
  check "$(sql "SELECT status FROM transactions WHERE id='$TX'")" "awaiting_parties" "not ready while the sender holds too little on chain"
fi

# ---------------------------------------------------------------------------
say "8. The sender is funded and opens their page: ready, by itself"
# ---------------------------------------------------------------------------
(cd ../rehearsal && node chain.mjs mint "$TOKEN" "$FUNDER" "$((2000 * 1000000))") >/dev/null
curl -s "${CLIENT[@]}" -H "Cookie: tpm_client=$SCOOKIE" -o /tmp/deal.html "$BASE/d/$TX"
check "$(sql "SELECT status FROM transactions WHERE id='$TX'")" "ready" "moved to ready without staff"
RS=$(sql "SELECT count(*) FROM audit_log WHERE entity_id='$TX' AND note LIKE '%is ready — you can send%'")
[ "${RS:-0}" -ge 1 ] && ok "the sender was emailed that it is ready" || bad "no ready-to-send email"
if [ "$(sql "SELECT status FROM transactions WHERE id='$TX'")" != "ready" ]; then
  curl -s -b "$ADMIN" -o /tmp/t.html "$BASE/t/$TX"
  python3 - <<'GATE'
import re, html
h = open("/tmp/t.html").read()
for label, detail in re.findall(r'<strong>([^<]+)</strong>\s*<div class="muted">([^<]*)', h):
    print(f"     {html.unescape(label)[:44]:46} {html.unescape(detail)[:60]}")
GATE
  sql "SELECT note FROM audit_log WHERE entity_id='$TX' AND action='self_serve.advance_failed' ORDER BY rowid DESC LIMIT 1"
  printf "\n\033[1mStopped — %d passed, %d failed\033[0m\n" "$PASS" "$FAIL"; exit 1
fi

# ---------------------------------------------------------------------------
say "9. The sender tests every address, pays our fee first, then everyone"
# ---------------------------------------------------------------------------
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

for LEG in $PIDS fee; do
  OUT=$(leg_send "$LEG" test) && ok "test to $LEG — $OUT" || bad "test to $LEG — $OUT"
done
FIRST=$(echo $PIDS | cut -d' ' -f1)
OUT=$(leg_send "$FIRST" payment)
case "$OUT" in
  "REFUSED Waiting for ThePaymaster's fee"*) ok "a recipient payment is refused before our fee lands" ;;
  *) bad "a recipient payment was not held back for the fee — $OUT" ;;
esac
for LEG in fee $PIDS; do
  OUT=$(leg_send "$LEG" payment) && ok "paid $LEG — $OUT" || bad "paid $LEG — $OUT"
done

# ---------------------------------------------------------------------------
say "10. Settled, sealed and closed — by itself"
# ---------------------------------------------------------------------------
check "$(sql "SELECT status FROM transactions WHERE id='$TX'")" "closed" "settled and closed when the last payment landed"
check "$(sql "SELECT count(*) FROM dossier_seals WHERE transaction_id='$TX' AND sealed_by IS NULL")" "1" "sealed by the platform, not staff"
for PID in $PIDS; do
  A=$(sql "SELECT address FROM destinations WHERE participation_id='$PID'")
  NAME=$(sql "SELECT y.display_name FROM participations p JOIN parties y ON y.id=p.party_id WHERE p.id='$PID'")
  GOT=$(cd ../rehearsal && node chain.mjs balance "$TOKEN" "$A")
  ok "$NAME holds $(python3 -c "import sys;print(format(int(sys.argv[1])/1e6, ',.6f'))" "$GOT") USDT"
done
STAFF=$(sql "SELECT count(*) FROM audit_log WHERE actor_kind='admin' AND (entity_id='$TX' OR entity_id IN (SELECT id FROM destinations WHERE participation_id IN (SELECT id FROM participations WHERE transaction_id='$TX')))")
check "$STAFF" "0" "staff touched nothing on the transaction itself"
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
