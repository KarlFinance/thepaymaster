# ThePaymaster platform

Admin and client for ThePaymaster. Phase 1 is the spine: transactions can be
created and moved through the pipeline, and every change is written to an
append-only log with the name of whoever made it.

## The shape of it

Five transaction types, one object. A transaction has an **inbound** leg and an
**outbound** leg, each fiat or crypto, plus a **converts** flag. Everything
type-specific follows:

| | inbound | outbound | recipients supply | settled by |
|---|---|---|---|---|
| Fiat → Fiat | fiat | fiat | bank details | us |
| Fiat → Crypto | fiat | crypto | wallet | OTC desk |
| Crypto → Fiat | crypto | fiat | bank details | OTC desk |
| Crypto → Crypto | crypto | crypto | wallet | **the sender, on-chain** |
| Crypto → Crypto (conv.) | crypto | crypto | wallet | OTC desk |

What a recipient supplies is decided by the outbound leg alone; whether the
sender must prove wallets, by the inbound leg. Nothing else differs.

## Money

Integer minor units throughout — pence, or the sixth decimal of a USDT. No
float touches an amount. `src/money.ts` holds the fee engine and its tests.

The fee has two modes, and the difference is which number is nailed down:

- **deducted** — the sender's figure is fixed; recipients share what is left
- **grossed_up** — the recipients' figures are fixed; the sender sends
  `net / (1 - fee)`, **not** `net * (1 + fee)`. The naive version shorts the
  recipients: on £2m at 1% it leaves them £200 light and the split does not
  reconcile.

Division rarely comes out even, so `remainder_to` names the party who absorbs
the odd unit and the total always adds up.

## Running it

    node --experimental-strip-types src/money.test.ts   # fee arithmetic
    ./dev.sh                                            # local, on :8788

## Deploying

    ./deploy.sh

Routes are added deliberately in the dashboard rather than declared in
`wrangler.toml`, so a deploy never changes what the public sees by accident.

## Before this holds anything real

- **Put it behind Cloudflare Access.** The password login in `src/auth.ts` is a
  stopgap and says so. Access replaces it with identity you already have.
- **Enable R2** on the account — needed for documents, and currently refused
  with `code 10042` until it is switched on in the dashboard once.
