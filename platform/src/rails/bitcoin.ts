/**
 * The Bitcoin rail.
 *
 * Different from the Ethereum one in every way that matters: money is an
 * output in a transaction, not a balance in a contract; nobody can freeze an
 * address; proof of control is BIP-322 or the older signed message; and
 * finality is measured in blocks ten minutes apart. The platform above sees
 * none of that — it sees the same Rail.
 *
 * The chain is read through Esplora-style HTTP (mempool.space, Blockstream)
 * rather than a node of our own, cross-checked where more than one answers,
 * exactly as the Ethereum rail cross-checks RPC endpoints.
 *
 * Sending: the sender's own wallet builds and broadcasts the payment
 * (Unisat-compatible `sendBitcoin`), one per recipient, so the record has one
 * txid per leg as it does on Ethereum. A single transaction paying every
 * recipient — cleaner, cheaper — is the obvious next step and is noted in
 * docs/chain-adapter.md; it needs the platform to compose a PSBT and the
 * record to accept one hash across several legs.
 */

import { type Env } from "../db.ts";
import { type Rail, type AddressReport, type Verification, type Health } from "../rail.ts";
import { parseAddress, verifyMessage, BTC_CHAIN_ID, type Network } from "../btc.ts";
import { challenge } from "../wallets.ts";


/** Below this a Bitcoin output is "dust" and nodes will not relay it. 1,000 sats clears every script type. */
const DUST_SATS = 1000;

interface Esplora { name: string; url: string }

const ENDPOINTS: Record<Network, Esplora[]> = {
  mainnet: [
    { name: "mempool.space", url: "https://mempool.space/api" },
    { name: "blockstream", url: "https://blockstream.info/api" },
  ],
  signet: [
    { name: "mempool.space signet", url: "https://mempool.space/signet/api" },
  ],
  testnet: [
    { name: "mempool.space testnet4", url: "https://mempool.space/testnet4/api" },
  ],
};

const EXPLORER: Record<Network, string> = {
  mainnet: "https://mempool.space", signet: "https://mempool.space/signet",
  testnet: "https://mempool.space/testnet4",
};

async function get(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json, text/plain" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

const sameAddress = (a: string, b: string) =>
  a === b || (/^(bc|tb)1/i.test(a) && a.toLowerCase() === b.toLowerCase());

export function bitcoinRail(network: Network): Rail {
  const eps = ENDPOINTS[network];
  const explorer = EXPLORER[network];
  const parse = (address: string) => parseAddress(address, network);

  return {
    key: `btc:${network}`,
    name: network === "mainnet" ? "Bitcoin" : `Bitcoin ${network} (rehearsal)`,
    symbol: "BTC",
    decimals: 8,
    canFreeze: false,
    chainId: BTC_CHAIN_ID[network],
    explorer: {
      tx: (hash) => `${explorer}/tx/${hash}`,
      address: (a) => `${explorer}/address/${a}`,
    },

    normalise(address) {
      const a = parse(address);
      return "why" in a ? { ok: false, why: a.why } : { ok: true, address: a.text };
    },
    hashProblem(hash) {
      const h = hash.trim();
      if (!h) return "No transaction id.";
      if (!/^[0-9a-f]{64}$/i.test(h)) {
        return "A Bitcoin transaction id is 64 hex characters, with no 0x in front.";
      }
      return null;
    },

    challenge,
    async provesControl(_env, o) {
      const a = parse(o.address);
      if ("why" in a) return false;
      return verifyMessage(a, o.message, o.signature);
    },

    async balance(_env, address) {
      for (const ep of eps) {
        try {
          const r = await get(`${ep.url}/address/${address}`);
          if (r?.chain_stats) {
            return BigInt(r.chain_stats.funded_txo_sum) - BigInt(r.chain_stats.spent_txo_sum);
          }
        } catch { /* next */ }
      }
      throw new Error("No Bitcoin endpoint answered.");
    },
    nativeBalance(env, address) {
      return this.balance(env, address).catch(() => null);
    },

    async inspect(_env, address, role): Promise<AddressReport> {
      const a = parse(address);
      if ("why" in a) return { address, role, balance: null, frozen: null, contract: null, error: a.why };
      let balance: bigint | null = null;
      try { balance = await this.balance(_env, address); } catch { /* unknown */ }
      // A script address (multisig, wrapped segwit) is the nearest Bitcoin has
      // to a contract: fine to pay, worth a person knowing.
      return { address, role, balance, frozen: null, contract: a.type === "p2sh" || a.type === "p2wsh" };
    },

    dustMinor: () => DUST_SATS,

    async verify(_env, hash, want): Promise<Verification | null> {
      const amount = BigInt(want.amountMinor);
      const answers = await Promise.all(eps.map(async (ep) => {
        try {
          const tx = await get(`${ep.url}/tx/${hash}`);
          if (!tx) return { ep, exists: false, ok: false, from: null as string | null, block: null as number | null, confirmed: false };
          const outs: any[] = Array.isArray(tx.vout) ? tx.vout : [];
          const hit = outs.some((o) => o.scriptpubkey_address &&
            sameAddress(String(o.scriptpubkey_address), want.to) && BigInt(o.value ?? 0) === amount);
          const confirmed = Boolean(tx.status?.confirmed);
          return {
            ep, exists: true, ok: hit && confirmed, hit, confirmed,
            from: (tx.vin?.[0]?.prevout?.scriptpubkey_address ?? null) as string | null,
            block: confirmed ? Number(tx.status.block_height) : null,
          };
        } catch { return null; }
      }));
      const heard = answers.filter((a): a is NonNullable<typeof a> => a !== null);
      if (!heard.length) return null;

      const exists = heard.some((a) => a.exists);
      const agreed = heard.every((a) => a.exists === heard[0].exists && a.ok === heard[0].ok);
      if (!exists) return { ok: false, from: null, block: null, sources: heard.length, agreed, problem: "not found" };
      const seen = heard.find((a) => a.exists)!;
      if (!(seen as any).hit) {
        return { ok: false, from: seen.from, block: seen.block, sources: heard.length, agreed,
                 problem: "that transaction does not pay this address that amount" };
      }
      if (!(seen as any).confirmed) {
        return { ok: false, from: seen.from, block: null, sources: heard.length, agreed, problem: "pending" };
      }
      return { ok: heard.every((a) => a.ok), from: seen.from, block: seen.block, sources: heard.length, agreed };
    },

    async health(): Promise<Health[]> {
      return Promise.all(eps.map(async (ep) => {
        try {
          const h = await get(`${ep.url}/blocks/tip/height`);
          return { name: ep.name, ok: true, height: Number(h) };
        } catch (err) {
          return { name: ep.name, ok: false, height: null, note: (err as Error).message };
        }
      }));
    },

    browser: {
      walletHint: "Unisat, OKX or another Bitcoin browser wallet",
      // Unisat's API, which OKX and Bitget also expose. Xverse and Leather use
      // a different one (sats-connect) and are the next to add; until then the
      // "copy the message, sign elsewhere, paste" route covers them, as it
      // covers Sparrow and hardware wallets.
      script: `window.railWallet = (function () {
        function w() { return window.unisat || (window.okxwallet && window.okxwallet.bitcoin) || null; }
        var api = ${JSON.stringify(eps[0].url)};
        var wantNet = ${JSON.stringify(network === "mainnet" ? "livenet" : network)};
        return {
          present: function () { return !!w(); },
          same: function (a, b) { a = String(a); b = String(b);
            return a === b || (/^(bc|tb)1/i.test(a) && a.toLowerCase() === b.toLowerCase()); },
          accounts: async function () {
            var p = w();
            try { if (p.switchChain && wantNet !== "livenet") await p.switchChain(wantNet === "signet" ? "BITCOIN_SIGNET" : "BITCOIN_TESTNET4"); } catch (e) {}
            return p.requestAccounts();
          },
          signMessage: async function (address, msg) { return w().signMessage(msg, "bip322-simple"); },
          prepare: async function () {},
          send: async function (check) {
            return w().sendBitcoin(check.to, Number(check.amountMinor));
          },
          landed: async function (hash) {
            try {
              var r = await fetch(api + "/tx/" + hash + "/status");
              if (!r.ok) return false;
              var s = await r.json(); return !!s.confirmed;
            } catch (e) { return false; }
          },
          // Ten minutes a block; the page waits a while and then hands over to
          // the record-it-later path rather than spinning for an hour.
          waitSeconds: 180,
          pendingAdvice: "Bitcoin takes about ten minutes to confirm a payment. Nothing is wrong. " +
            "Keep the transaction id; once it has confirmed, paste it under " +
            "'Sent it another way?' on this page and it will be recorded.",
        };
      })();`,
    },
  };
}
