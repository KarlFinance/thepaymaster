#!/bin/bash
# Deploy the platform worker.
#
# Same two traps as the website: the Mac's default node is v16 and wrangler
# needs 22, and wrangler caches the last Cloudflare account it used. This
# belongs in the karl.finance account, where the zone is.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
export CLOUDFLARE_ACCOUNT_ID=c2102a85d6857866b83b6146e44cad1b
rm -rf .wrangler/cache
node --experimental-strip-types src/money.test.ts
npx wrangler deploy
