#!/bin/zsh
# Clear the pre-launch test data from production. Run it yourself:
#
#   ~/Desktop/ThePaymaster/platform/tools/cleanup-test-data.sh
#
# 1. Shows what is there now.
# 2. Takes a full backup of the production database into ../backups/.
# 3. Asks you to type CLEAR TEST DATA.
# 4. Runs tools/cleanup-test-data.sql and deletes the test people's uploaded
#    documents (parties/… in R2). The papers (client information sheet and the
#    two guides) are kept.
# 5. Shows what is left.
#
# Uses the deploy token in ~/.cf-deploy-token. Never prints it.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
export CLOUDFLARE_ACCOUNT_ID=c2102a85d6857866b83b6146e44cad1b
export CLOUDFLARE_API_TOKEN="$(cat ~/.cf-deploy-token)"
DBNAME=thepaymaster

counts() {
  npx wrangler d1 execute $DBNAME --remote --json --command "
    SELECT (SELECT count(*) FROM transactions) AS transactions, (SELECT count(*) FROM parties) AS people,
           (SELECT count(*) FROM enquiries) AS enquiries, (SELECT count(*) FROM artefacts) AS documents,
           (SELECT count(*) FROM agreements) AS agreements, (SELECT count(*) FROM verifications) AS identity_checks,
           (SELECT count(*) FROM admins) AS admins, (SELECT count(*) FROM house_wallets) AS house_wallets" 2>/dev/null \
  | python3 -c "import json,sys; r=json.load(sys.stdin)[0]['results'][0]; print('   ' + '   '.join(f'{k.replace(\"_\",\" \")}: {v}' for k,v in r.items()))"
}

echo "Production now:"
counts

stamp=$(date +%Y-%m-%d-%H%M)
mkdir -p ../backups
echo "\nBacking up the production database…"
npx wrangler d1 export $DBNAME --remote --output "../backups/thepaymaster-$stamp.sql" >/dev/null 2>&1
chmod 600 "../backups/thepaymaster-$stamp.sql"
echo "   saved ../backups/thepaymaster-$stamp.sql ($(wc -c < ../backups/thepaymaster-$stamp.sql | tr -d ' ') bytes)"

echo "\nThis permanently deletes every transaction, person, enquiry, agreement and uploaded"
echo "document above. Admins, settings and wallets stay. The backup can restore it."
read -r "answer?Type CLEAR TEST DATA to go ahead: "
if [[ "$answer" != "CLEAR TEST DATA" ]]; then echo "Nothing deleted."; exit 1; fi

echo "\nClearing the database…"
npx wrangler d1 execute $DBNAME --remote --file tools/cleanup-test-data.sql >/dev/null 2>&1
echo "   done"

echo "Deleting the test people's uploaded documents…"
python3 - <<'PY'
import json, os, urllib.request
tok = os.environ["CLOUDFLARE_API_TOKEN"]; acct = os.environ["CLOUDFLARE_ACCOUNT_ID"]
base = f"https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/thepaymaster/objects"
req = lambda url, method="GET": json.load(urllib.request.urlopen(urllib.request.Request(url, method=method, headers={"Authorization": "Bearer " + tok})))
keys, cursor = [], None
while True:
    d = req(base + "?per_page=1000&prefix=parties/" + (f"&cursor={cursor}" if cursor else ""))
    keys += [o["key"] for o in d.get("result", [])]
    info = d.get("result_info") or {}
    if not info.get("is_truncated"): break
    cursor = info.get("cursor")
for k in keys:
    req(base + "/" + urllib.request.quote(k, safe=""), "DELETE")
print(f"   deleted {len(keys)} files; the papers are kept")
PY

echo "\nProduction now:"
counts
echo "\nClean. The next transaction will be TPM-$(date +%Y)-0001."
