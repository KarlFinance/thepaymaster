#!/bin/bash
# Sign in to the local dev server the way a person does: password, then a code
# generated from the secret the enrolment page issues. Leaves a cookie jar at
# /tmp/adm.j for the rest of a test run.
#
# There is deliberately no bypass for this. A login that can be skipped in
# development is a login whose failures are found in production.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
BASE=${BASE:-http://127.0.0.1:8788}
EMAIL=${EMAIL:-rl@thepaymaster.co.uk}
J=/tmp/adm.j; rm -f $J

# The temporary password only works once, because the first sign-in is
# required to replace it. After that the local account uses a fixed
# development passphrase, so try both.
LOCAL_PW="local-dev-passphrase-77"
PW=$(grep -- "-- $EMAIL " admin-credentials.txt | sed 's/.*temporary password: //' || true)
try_login() {
  curl -s -c $J -o /dev/null -w "%{redirect_url}" -X POST \
    --data-urlencode "email=$EMAIL" --data-urlencode "password=$1" "$BASE/login"
}
WHERE=$(try_login "$LOCAL_PW")
if [ -z "$WHERE" ]; then WHERE=$(try_login "$PW"); fi
PW="$LOCAL_PW"

# Already enrolled? Then the secret is in the local database and the code has
# to be generated from that rather than from a fresh enrolment page.
SECRET=$(curl -s -b $J -c $J "$BASE/2fa/setup" \
  | grep -o 'name="secret" value="[A-Z2-7]*"' | sed 's/.*value="//;s/"//' || true)
ENROLLING=1
if [ -z "$SECRET" ]; then
  ENROLLING=0
  SECRET=$(npx wrangler d1 execute thepaymaster --local \
    --command "SELECT totp_secret FROM admins WHERE email = '$EMAIL'" 2>/dev/null \
    | grep -o '"totp_secret": "[A-Z2-7]*"' | sed 's/.*: "//;s/"//' || true)
fi

if [ -n "$SECRET" ]; then
  CODE=$(node --experimental-strip-types -e "
    import('./src/totp.ts').then(async m => {
      const key = await crypto.subtle.importKey('raw', m.base32Decode('$SECRET'),
        {name:'HMAC',hash:'SHA-1'}, false, ['sign']);
      const c = Math.floor(Date.now()/1000/30);
      const b = new ArrayBuffer(8), d = new DataView(b);
      d.setUint32(0, Math.floor(c/2**32)); d.setUint32(4, c>>>0);
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, b));
      const o = mac[mac.length-1] & 15;
      const n = ((mac[o]&127)<<24)|(mac[o+1]<<16)|(mac[o+2]<<8)|mac[o+3];
      console.log(String(n%1000000).padStart(6,'0'));
    });" 2>/dev/null)
  if [ "$ENROLLING" = "1" ]; then
    curl -s -b $J -c $J -o /dev/null -X POST -d "secret=$SECRET&code=$CODE" "$BASE/2fa/setup"
    curl -s -b $J -o /dev/null -X POST \
      --data-urlencode "current=$(grep -- "-- $EMAIL " admin-credentials.txt | sed 's/.*temporary password: //')" \
      --data-urlencode "next=$LOCAL_PW" --data-urlencode "repeat=$LOCAL_PW" "$BASE/account"
  else
    curl -s -b $J -c $J -o /dev/null -X POST -d "code=$CODE" "$BASE/2fa"
  fi
fi
curl -s -b $J -o /dev/null -w "signed in: %{http_code}\n" "$BASE/"
