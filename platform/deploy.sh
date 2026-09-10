#!/bin/bash
# Deploy the platform worker — migrations first, and only then the code.
#
# The code that ships assumes the schema its migrations describe. Deploying
# the worker while a remote migration has failed (a transient API error is
# enough) leaves production querying columns that do not exist. So: apply,
# confirm nothing is pending, then deploy; any failure stops the script
# before the worker changes.
#
# Same two traps as the website: the Mac's default node is v16 and wrangler
# needs 22, and wrangler caches the last Cloudflare account it used.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
export CLOUDFLARE_ACCOUNT_ID=c2102a85d6857866b83b6146e44cad1b
rm -rf .wrangler/cache

for f in src/*.test.ts; do
  node --experimental-strip-types "$f" 2>&1 | grep -qE "FAILED|^# fail [1-9]" && { echo "tests failed: $f"; exit 1; }
done

for attempt in 1 2 3; do
  if npx wrangler d1 migrations apply thepaymaster --remote; then break; fi
  echo "migration attempt $attempt failed; retrying"; sleep 5
  [ "$attempt" = 3 ] && { echo "migrations did not apply — not deploying"; exit 1; }
done
if npx wrangler d1 migrations list thepaymaster --remote 2>&1 | grep -q "\.sql"; then
  echo "migrations still pending — not deploying"; exit 1
fi

npx wrangler deploy
