# The flows, as built (11 September 2026)

One platform, five transaction types, and how each moves. Every flow shares
the same spine: enquiry (with the verification acknowledgement) → parties
verified → agreements generated from the record and signed in the account
(Sender's Paymaster Agreement; a Recipient's Authorisation per recipient) →
accounts or wallets proved → readiness gate → movement → sealed record and
per-party dossier.

| Type | Movement | Where the money rests | Confirmation |
|---|---|---|---|
| Fiat → fiat | Sender pays the HSBC client account under the Reference Code; staff pay recipients from it | `thepaymaster_hsbc` | Manual: sender presses "I have sent it", staff confirm receipt and each payment with evidence, each recipient confirms arrival. Statement import + reconcile as an aid. |
| Fiat → fiat, sender direct | Sender pays recipients and our fee from their own bank | `client` | Built, switched **off** on the Fiat page: outside the commercial agent model as operated. |
| Crypto → crypto, Mode C | Sender sends to our client wallet (reference tx, then balance); staff Distribute from it | `thepaymaster_wallet` | Receipt recorded by hash, verified through the rail to the client wallet from a proved sending wallet; each payment signed by staff in the browser and verified before recording. |
| Crypto → crypto, sender executes | Sender signs each payment (or one batch) from a proved wallet; our fee is a line of the same distribution | `none` | Verified on chain per leg. |
| Fiat → crypto (buy) | Sender pays the client account; desk buys with gross less our 1%; desk delivers to our client wallet; staff Distribute | hsbc → otc_desk → `thepaymaster_wallet` | Receipt by advice; conversion recorded with rate, desk fee at source and the delivery hash verified on chain; legs verified on chain. |
| Crypto → fiat (sell) | Sender sends to our client wallet; desk sells; fiat proceeds to the client account; manual fiat payout | `thepaymaster_wallet` → otc_desk → hsbc | Receipt by hash; conversion recorded with the desk's confirmation; payments as manual fiat. **Contract pending** (not a Mode in the Agreement). |

Fees: ThePaymaster 1% of the gross (deducted pro rata, paid by the sender in
addition, or borne by named recipients — the Transaction Schedule says which).
MAS Digital 2.5% at source on what it converts; the desk's charge, recorded,
never collected by us. 3.5% all in on a conversion.

Rails: USDT, USDC, Ether on Ethereum; Bitcoin; USDT on Tron (TRC-20). Test
networks: Sepolia, signet, Nile.

Switches (Fiat page): fiat mode manual | HSBC API (needs credentials) |
sender direct; default crypto route Mode C | sender executes.

Registry (Wallets page): our fee wallets and client wallets, one per rail,
proved by a signature from the key; a transaction's fee wallet and client
wallet are chosen from it, never typed.
