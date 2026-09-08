#!/bin/bash
# Build and deploy the site to Cloudflare Pages.
#
# Two things this Mac gets wrong on its own, both of which have cost time:
#   - the default node is v16 and wrangler needs 22, so the nvm one is forced
#   - wrangler caches the last account it used, and this machine has been logged
#     into two; the site belongs in the karl.finance account, where the
#     thepaymaster.co.uk zone is
set -euo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
export CLOUDFLARE_ACCOUNT_ID=c2102a85d6857866b83b6146e44cad1b   # Dev.karl.finance@gmail.com

rm -rf .wrangler/cache
python3 build.py
npx wrangler pages deploy dist --project-name thepaymaster --branch main --commit-dirty=true
