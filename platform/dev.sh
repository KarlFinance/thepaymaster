#!/bin/bash
# Local dev on :8788, against a local copy of the D1 database.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
export CLOUDFLARE_ACCOUNT_ID=c2102a85d6857866b83b6146e44cad1b
npx wrangler dev --port 8788 --local
