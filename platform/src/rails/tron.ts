/**
 * The Tron rail: USDT as a TRC-20 token, the asset most OTC counterparties
 * actually hold.
 *
 * Tron's public node speaks its own HTTP API rather than JSON-RPC, so this
 * rail talks to TronGrid directly. One provider only for now: TronGrid is the
 * reference node and a second independent full-node API with the same shape
 * is not freely available, so `sources` is honest about being 1. The browser
 * half is TronLink, which exposes `window.tronWeb`.
 */

import { type Env } from "../db.ts";
import { type Rail, type AddressReport, type Verification, type Health } from "../rail.ts";
import { challenge } from "../wallets.ts";
import { addressProblem, addressHex20, addressFromHex, proves, TRON_CHAIN_ID, type TronNetwork } from "../tron.ts";

const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DUST_MINOR = 1;                                     // 0.000001 USDT

/** USDT's contract on each network. Nile's is the one the faucet hands out. */
export const TRON_USDT: Record<TronNetwork, string> = {
  mainnet: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  nile: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
};

const API: Record<TronNetwork, { name: string; url: string }> = {
  mainnet: { name: "TronGrid", url: "https://api.trongrid.io" },
  nile: { name: "TronGrid Nile", url: "https://nile.trongrid.io" },
};
const EXPLORER: Record<TronNetwork, string> = {
  mainnet: "https://tronscan.org/#", nile: "https://nile.tronscan.org/#",
};

function headers(env: Env): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = (env as any).TRONGRID_API_KEY as string | undefined;
  if (key) h["TRON-PRO-API-KEY"] = key;
  return h;
}

async function post(env: Env, network: TronNetwork, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API[network].url}${path}`, { method: "POST", headers: headers(env), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`TronGrid ${res.status}`);
  const data: any = await res.json();
  // TronGrid answers 200 with {"Error": "..."} for rate limits and bad input.
  if (data && typeof data.Error === "string") throw new Error(data.Error.split(".")[0]);
  return data;
}

const pad32 = (hex20: string) => hex20.toLowerCase().padStart(64, "0");

export function tronRail(network: TronNetwork, o: { token?: string | null; decimals?: number; symbol?: string } = {}): Rail {
  const token = o.token || TRON_USDT[network];
  const symbol = o.symbol ?? "USDT";
  const decimals = o.decimals ?? 6;
  const chainId = TRON_CHAIN_ID[network];
  const tokenHex = addressHex20(token) ?? "";

  async function constant(env: Env, fn: string, param: string, from = token): Promise<string | null> {
    const r = await post(env, network, "/wallet/triggerconstantcontract", {
      owner_address: from, contract_address: token, function_selector: fn, parameter: param, visible: true,
    });
    const out = r?.constant_result?.[0];
    return typeof out === "string" && out.length ? out : null;
  }

  return {
    key: `tron:${network}:${symbol.toLowerCase()}`,
    name: network === "mainnet" ? `${symbol} on Tron (TRC-20)` : `${symbol} on Tron Nile (rehearsal)`,
    symbol, decimals,
    token, native: false,
    canFreeze: true,                                       // Tether's TRC-20 contract has the same blacklist
    chainId,
    explorer: {
      tx: (hash) => `${EXPLORER[network]}/transaction/${hash}`,
      address: (a) => `${EXPLORER[network]}/address/${a}`,
    },

    normalise(address) {
      const why = addressProblem(address);
      return why ? { ok: false, why } : { ok: true, address: address.trim() };
    },
    hashProblem(hash) {
      const h = hash.trim();
      if (!h) return "No transaction id.";
      if (!/^[0-9a-f]{64}$/i.test(h)) return "A Tron transaction id is 64 hex characters, with no 0x in front.";
      return null;
    },

    challenge,
    async provesControl(_env, o) { return proves(o.message, o.signature, o.address); },

    async balance(env, address) {
      const h = addressHex20(address); if (!h) return 0n;
      const out = await constant(env, "balanceOf(address)", pad32(h));
      return out ? BigInt("0x" + out) : 0n;
    },
    async nativeBalance(env, address) {
      try {
        const r = await post(env, network, "/wallet/getaccount", { address, visible: true });
        return typeof r?.balance === "number" ? BigInt(r.balance) : 0n;   // sun
      } catch { return null; }
    },

    async inspect(env, address, role): Promise<AddressReport> {
      try {
        const h = addressHex20(address);
        if (!h) return { address, role, balance: null, frozen: null, contract: null, error: "not a Tron address" };
        // One call at a time: without an API key TronGrid allows three requests
        // a second and suspends the caller for five when exceeded.
        const bal = await constant(env, "balanceOf(address)", pad32(h)).catch(() => null);
        const black = await constant(env, "isBlackListed(address)", pad32(h)).catch(() => null);
        const acct = await post(env, network, "/wallet/getcontract", { value: address, visible: true }).catch(() => null);
        return {
          address, role,
          balance: bal ? BigInt("0x" + bal) : null,
          frozen: black === null ? null : BigInt("0x" + black) === 1n,
          contract: acct ? Boolean(acct.bytecode || acct.contract_address) : null,
        };
      } catch (err) {
        return { address, role, balance: null, frozen: null, contract: null, error: (err as Error).message };
      }
    },

    async health(env): Promise<Health[]> {
      try {
        const r = await post(env, network, "/wallet/getnowblock", {});
        const height = r?.block_header?.raw_data?.number ?? null;
        return [{ name: API[network].name, ok: typeof height === "number", height }];
      } catch (err) {
        return [{ name: API[network].name, ok: false, height: null, note: (err as Error).message }];
      }
    },

    dustMinor: () => DUST_MINOR,

    async verify(env, hash, want): Promise<Verification | null> {
      const toHex = addressHex20(want.to);
      if (!toHex) return { ok: false, from: null, block: null, sources: 1, agreed: true, problem: "not a Tron address" };
      const amount = BigInt(want.amountMinor);
      let info: any, tx: any;
      try {
        tx = await post(env, network, "/wallet/gettransactionbyid", { value: hash });
        info = await post(env, network, "/wallet/gettransactioninfobyid", { value: hash });
      } catch { return null; }
      const exists = tx && Object.keys(tx).length > 0;
      if (!exists) return { ok: false, from: null, block: null, sources: 1, agreed: true, problem: "no such transaction" };
      const fromHex = tx?.raw_data?.contract?.[0]?.parameter?.value?.owner_address as string | undefined;
      const from = fromHex ? addressFromHex(fromHex) : null;
      const included = info && typeof info.blockNumber === "number";
      if (!included) return { ok: false, from, block: null, sources: 1, agreed: true, problem: "pending" };
      const succeeded = info?.receipt?.result === "SUCCESS" || tx?.ret?.[0]?.contractRet === "SUCCESS";
      const logs: any[] = Array.isArray(info?.log) ? info.log : [];
      const hit = logs.some((l) =>
        String(l.address ?? "").toLowerCase().endsWith(tokenHex.toLowerCase()) &&
        String(l.topics?.[0] ?? "").toLowerCase() === TRANSFER_TOPIC &&
        String(l.topics?.[2] ?? "").toLowerCase().endsWith(toHex.toLowerCase()) &&
        BigInt("0x" + String(l.data ?? "0")) === amount);
      return { ok: succeeded && hit, from, block: info.blockNumber, sources: 1, agreed: true,
               problem: succeeded && hit ? undefined : succeeded ? "that transaction does not pay this address that amount" : "reverted" };
    },

    browser: {
      walletHint: "TronLink",
      script: `window.railWallet = (function () {
        function tw() { return window.tronWeb; }
        return {
          present: function () { return !!(window.tronLink || window.tronWeb); },
          same: function (a, b) { return String(a) === String(b); },
          accounts: async function () {
            if (window.tronLink && window.tronLink.request) {
              await window.tronLink.request({ method: "tron_requestAccounts" });
            }
            var a = tw() && tw().defaultAddress && tw().defaultAddress.base58;
            return a ? [a] : [];
          },
          signMessage: function (address, msg) { return tw().trx.signMessageV2(msg); },
          prepare: async function () {},
          send: async function (check) {
            var c = await tw().contract().at(check.token);
            return c.transfer(check.to, check.amountMinor).send({ feeLimit: 100000000 });
          },
          landed: async function (hash) {
            try { var i = await tw().trx.getTransactionInfo(hash); return !!(i && i.blockNumber); }
            catch (e) { return false; }
          },
          waitSeconds: 90,
          pendingAdvice: "Tron usually confirms within a minute. If it is still pending, record the transaction id under 'Sent it another way?' once it shows on Tronscan.",
        };
      })();`,
    },
  };
}
