/**
 * The Ethereum rail: an ERC-20 token — USDT in production — on an EVM chain.
 *
 * Nothing here is new. Every function is the one that already lived in
 * chain.ts and wallets.ts, with the chain id and token address closed over so
 * the caller does not have to carry them. Those two files remain the
 * implementation; this is the face the platform sees.
 */

import { type Env } from "../db.ts";
import { type Rail, type AddressReport, type Verification } from "../rail.ts";
import { CHAINS, USDT_MAINNET, tokenBalance, isBlacklisted, isContract, endpoints,
         transferHappened, txHashProblem, explorerLink, addressLink } from "../chain.ts";
import { challenge, provesControl, addressProblem, toChecksum } from "../wallets.ts";

/** One unit of the token: 0.000001 USDT. Cheap enough to send to every address first. */
const DUST_MINOR = 1;

export function ethereumRail(o: {
  chainId: number; token: string | null; decimals: number; symbol: string;
}): Rail {
  const chainId = o.chainId;
  const token = o.token || USDT_MAINNET;
  const chain = CHAINS[chainId];

  return {
    key: `eth:${chainId}:${o.symbol.toLowerCase()}`,
    name: `${o.symbol} on ${chain?.name ?? `chain ${chainId}`}`,
    symbol: o.symbol,
    decimals: o.decimals,
    // Only USDT has isBlackListed(); the check returns null for other tokens
    // and the gate treats null as "could not check", which is the right
    // caution for a token we have not looked at.
    canFreeze: true,
    explorer: {
      tx: (hash) => explorerLink(chainId, hash),
      address: (a) => addressLink(chainId, a),
    },

    normalise(address) {
      const why = addressProblem(address);
      return why ? { ok: false, why } : { ok: true, address: toChecksum(address.trim()) };
    },
    hashProblem: txHashProblem,

    challenge,
    provesControl: (env, opts) => provesControl(env, chainId, opts),

    balance: (env, address) => tokenBalance(env, chainId, token, address),

    async nativeBalance(env, address) {
      for (const ep of endpoints(env, chainId)) {
        try {
          const res = await fetch(ep.url, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1,
              method: "eth_getBalance", params: [address, "latest"] }),
          });
          const body = await res.json<any>();
          if (body?.result) return BigInt(body.result);
        } catch { /* next endpoint */ }
      }
      return null;
    },

    async inspect(env, address, role): Promise<AddressReport> {
      try {
        const [balance, frozen, contract] = await Promise.all([
          tokenBalance(env, chainId, token, address).catch(() => null),
          isBlacklisted(env, chainId, token, address),
          isContract(env, chainId, address),
        ]);
        return { address, role, balance, frozen, contract };
      } catch (err) {
        return { address, role, balance: null, frozen: null, contract: null,
                 error: (err as Error).message };
      }
    },

    dustMinor: () => DUST_MINOR,

    verify(env, hash, want): Promise<Verification | null> {
      return transferHappened(env, chainId, hash, {
        token, to: want.to, amountMinor: want.amountMinor,
      });
    },
  };
}
