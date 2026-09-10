# One platform, several rails — the chain adapter

*Design sketch, 10 Sep 2026. **Step 1 is done** (`src/rail.ts`, `src/rails/ethereum.ts`;
execute, executeview, proof and readiness go through the rail). The browser-side
fragments, the chain-settings form and `transactions.rail` are steps 2–3.*

## Where the chain leaks in today

Nine files import `chain.ts` or `wallets.ts`. The chain-specific knowledge is
concentrated in **five places**:

| Place | What it knows about Ethereum |
|---|---|
| `chain.ts` | `eth_*` JSON-RPC, three-endpoint cross-check, `Transfer` event decoding, Tether blacklist `isBlackListed(address)`, `eth_getCode` for contracts, 0x hash shape |
| `wallets.ts` | EIP-55 checksum, EIP-191 `personal_sign` recovery, EIP-1271 `isValidSignature` |
| `execute.ts` | one `transfer(to, amount)` per leg; dust = 1 minor unit; balance via `balanceOf` |
| Browser scripts in `executeview.ts`, `proof.ts`, `dossierview.ts`, `index.ts` | `window.ethereum`, `eth_requestAccounts`, `personal_sign`, `eth_sendTransaction`, waiting on `eth_getTransactionReceipt` |
| Schema | `transactions.chain_id INTEGER`, `token_address`, `fee_wallet`; `destinations.address` + `proof_signature`; `wallet_screens.chain_id` |

Everything else — parties, KYC, destinations lifecycle, screening, mandates,
attestations, notifications, journey, dossier — never asks which chain it is on.

## The interface

```ts
/** A rail: one chain + one asset the platform can move on it. */
export interface Rail {
  /** "eth:1:usdt", "eth:11155111:usdt", "btc:mainnet", "btc:signet", "tron:mainnet:usdt" */
  key: string;
  name: string;                       // "USDT on Ethereum", "Bitcoin"
  decimals: number;                   // 6, 8, 6
  symbol: string;                     // "USDT", "BTC"
  explorer: { tx(hash: string): string; address(a: string): string };

  // --- addresses -----------------------------------------------------------
  /** Reject anything that is not an address on this rail; return canonical form. */
  normalise(address: string): { ok: true; address: string } | { ok: false; why: string };
  /** Shape check on a transaction hash / txid before we spend an RPC call on it. */
  hashProblem(hash: string): string | null;

  // --- proving control -----------------------------------------------------
  /** The text the wallet signs. Must embed name, ref and nonce as today. */
  challenge(o: { name: string; ref: string; address: string; nonce: string }): string;
  /** Does this signature prove `address` signed `message`? EIP-191/1271, or BIP-322/legacy. */
  provesControl(env: Env, o: { message: string; signature: string; address: string }): Promise<boolean>;
  /** Addresses that can never sign (exchange deposits) go through attestation — unchanged. */

  // --- looking at the chain ------------------------------------------------
  health(env: Env): Promise<Array<{ name: string; ok: boolean; height?: number; note?: string }>>;
  balance(env: Env, address: string): Promise<bigint>;          // minor units
  inspect(env: Env, address: string): Promise<{
    isContract: boolean;      // ETH: eth_getCode; BTC: script type is P2SH/P2WSH (multisig)
    frozen: boolean | null;   // ETH/USDT: Tether blacklist; BTC: null — no such thing
    note?: string;
  }>;

  // --- moving money --------------------------------------------------------
  /** The smallest payment this rail will carry. ETH/USDT: 1. BTC: above the dust limit. */
  dustMinor(): bigint;
  /**
   * Compose what the sender's wallet must sign. ETH returns one call per leg;
   * BTC returns ONE PSBT paying every leg and the fee in a single transaction.
   * The UI renders whatever comes back; the plan does not care how many.
   */
  compose(env: Env, o: {
    from: string;
    legs: Array<{ participationId: string; to: string; amountMinor: bigint }>;
  }): Promise<Array<{
    legs: string[];                  // which participationIds this signable covers
    kind: "eth_sendTransaction" | "psbt" | "tron_triggerSmartContract";
    payload: unknown;                // what the browser hands to the wallet
    human: string;                   // "0.495 USDT to 0x…", "3 outputs, 0.51 BTC + fee"
  }>>;
  /** Did `hash` actually pay `to` at least `amountMinor` of this asset? Cross-checked. */
  verify(env: Env, hash: string, want: { to: string; amountMinor: bigint }): Promise<
    | { ok: true; confirmations: number; blockTime: string; paidMinor: bigint }
    | { ok: false; problem: "pending" | "not found" | "reverted" | "wrong recipient" | "short" | "wrong asset" }>;
  /** How many confirmations before we call it settled. ETH: 1 receipt + cross-check. BTC: 3. */
  finality(): number;

  // --- the browser side -----------------------------------------------------
  /** Inline JS for: connect wallet, sign a message, sign/submit a composed item, poll to finality. */
  browser(): { connect: string; sign: string; submit: string; awaitFinal: string };
}
```

Two implementations:

* `rails/ethereum.ts` — today's `chain.ts` + `wallets.ts` with the function
  names changed and `chainId`/`token` closed over at construction. **No logic
  changes.** `retarget()` for Sepolia stays.
* `rails/bitcoin.ts` — new. Esplora-style HTTP (mempool.space, Blockstream,
  a paid node) cross-checked three ways as today. BIP-322 + legacy
  `signmessage` verification on the same secp256k1 curve `@noble/curves`
  already provides; bech32/bech32m/base58check for addresses; PSBT builder;
  `verify()` fetches the txid and checks outputs.

`rails/index.ts` picks by `transactions.rail` and is the only place the string
is parsed.

## What changes at the call sites

| Today | After |
|---|---|
| `transferHappened(env, chainId, hash, {token, to, amount})` | `rail.verify(env, hash, {to, amountMinor})` |
| `provesControl(env, chainId, {…})` in `proof.ts` (×2) | `rail.provesControl(env, {…})` |
| `addressProblem` / `toChecksum` (`proof.ts`, `index.ts`) | `rail.normalise()` |
| `isBlacklisted`, `isContract`, `tokenBalance` in `execute.ts` | `rail.inspect()`, `rail.balance()` |
| `DUST_MINOR = 1` | `rail.dustMinor()` |
| Per-leg `data: transfer(...)` composition | `rail.compose()` — the send page renders N signables instead of assuming one per leg |
| `window.ethereum` scripts (4 files) | `rail.browser()` fragments; one shared runner |
| Readiness line "No address is frozen by Tether" | shown only when `inspect().frozen !== null` |
| `CURRENCIES` decimals | come from `rail.decimals` |

The dossier gains nothing new: it already records destinations, proofs, screens,
custody events and hashes as opaque facts. `06-destination` grows a `rail` field.

## Schema

```sql
ALTER TABLE transactions ADD COLUMN rail TEXT;      -- back-filled: chain_id 1 → 'eth:1:usdt', 11155111 → 'eth:11155111:usdt'
-- chain_id and token_address stay for the Ethereum rail's own use; the platform stops reading them directly.
ALTER TABLE destinations ADD COLUMN proof_scheme TEXT;   -- 'eip191' | 'eip1271' | 'bip322' | 'legacy'
ALTER TABLE wallet_screens ADD COLUMN rail TEXT;         -- Nominis takes a chain name; map from rail
```

## Things that only show up when you try

* **Bitcoin has no "reverted".** A txid either confirms or is dropped from the
  mempool. `verify()` returns `pending` until `finality()` confirmations, and
  the send page's wait moves from ~15 s to ~30 min: needs a "we'll email you"
  path rather than a spinner. `paymentLanded` already exists for that.
* **One PSBT pays everyone.** The sender signs once. The record then has one
  hash across all legs; `payout_legs` already keys on (leg, event) so several
  legs sharing an event is fine — but `recordLeg()` today assumes one hash per
  leg and will need to accept a batch.
* **Dust test on BTC costs real money** (a miner fee per test, ~£0.20–£3). Still
  worth it; the plan should show the cost.
* **Change outputs.** A PSBT paying recipients returns change to the sender.
  The dossier should record the change output as such, or an auditor sees an
  unexplained payee.
* **Address reuse.** Bitcoin wallets generate a fresh address per receipt;
  recipients may hand over an address their wallet later treats as used. Fine
  for us — lock it and pay it once — but the help text should say "use this
  address once".
* **Hardware wallets and BIP-322.** Ledger signs legacy messages for `1…` and
  `bc1q…` (via Ledger Live / Sparrow), Trezor similarly; full BIP-322 for
  taproot `bc1p…` is thin. The proof form should offer the same "copy the
  message, sign elsewhere, paste" route it has now, and the attestation route
  covers the rest.
* **Testnet.** Signet is the stable choice for a rehearsal; a `chain.mjs`
  equivalent needs a small faucet-funded key, as with Sepolia.
* **Tron, if it comes first**, is nearer the Ethereum rail than the Bitcoin
  one: account model, TRC-20 `Transfer` events, TronLink's `signMessageV2`,
  base58 `T…` addresses. Most of `rails/ethereum.ts` copies across.

## Order of work

1. Introduce `Rail` and `rails/ethereum.ts` by moving code, not rewriting it.
   Rehearsal (`flow.sh`) must pass unchanged. One deploy, no visible change.
2. Add `transactions.rail`, back-fill, switch the chain-settings form to a
   rail picker.
3. Build `rails/bitcoin.ts` against signet; extend `chain.mjs` for BTC;
   rehearse end to end.
4. Only then offer BTC on the enquiry form.

Step 1 is about two days and is worth doing regardless — it is what stops the
next chain from touching nine files.
