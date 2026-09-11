/**
 * The Ethereum rail: an ERC-20 token — USDT in production — on an EVM chain.
 *
 * Nothing here is new. Every function is the one that already lived in
 * chain.ts and wallets.ts, with the chain id and token address closed over so
 * the caller does not have to carry them. Those two files remain the
 * implementation; this is the face the platform sees.
 */

import { type Env } from "../db.ts";
import { type Rail, type AddressReport, type Verification, type Health } from "../rail.ts";
import { CHAINS, USDT_MAINNET, tokenBalance, isBlacklisted, isContract, endpoints,
         transferHappened, etherTransferHappened, txHashProblem, explorerLink, addressLink, health } from "../chain.ts";
import { challenge, provesControl, addressProblem, toChecksum } from "../wallets.ts";

/** One unit of the token: 0.000001 USDT. Cheap enough to send to every address first. */
const DUST_MINOR = 1;

export function ethereumRail(o: {
  chainId: number; token: string | null; decimals: number; symbol: string;
  /** The chain's own coin (Ether) rather than a token. */
  native?: boolean;
}): Rail {
  const chainId = o.chainId;
  const native = Boolean(o.native);
  const token = native ? null : (o.token || USDT_MAINNET);
  const chain = CHAINS[chainId];

  const ethBalance = async (env: Env, address: string): Promise<bigint | null> => {
    for (const ep of endpoints(env, chainId)) {
      try {
        const res = await fetch(ep.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
        });
        const body = await res.json<any>();
        if (body?.result) return BigInt(body.result);
      } catch { /* next endpoint */ }
    }
    return null;
  };

  return {
    key: `eth:${chainId}:${o.symbol.toLowerCase()}`,
    name: `${o.symbol} on ${chain?.name ?? `chain ${chainId}`}`,
    symbol: o.symbol,
    decimals: o.decimals,
    token,
    native,
    // Only USDT has isBlackListed(); the check returns null for other tokens
    // and the gate treats null as "could not check", which is the right
    // caution for a token we have not looked at. Ether itself has no issuer.
    canFreeze: !native,
    chainId,
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

    balance: (env, address) => native
      ? ethBalance(env, address).then((b) => b ?? 0n)
      : tokenBalance(env, chainId, token!, address),

    nativeBalance: (env, address) => ethBalance(env, address),

    async inspect(env, address, role): Promise<AddressReport> {
      try {
        const [balance, frozen, contract] = await Promise.all([
          native ? ethBalance(env, address) : tokenBalance(env, chainId, token!, address).catch(() => null),
          native ? Promise.resolve(null) : isBlacklisted(env, chainId, token!, address),
          isContract(env, chainId, address),
        ]);
        return { address, role, balance, frozen, contract };
      } catch (err) {
        return { address, role, balance: null, frozen: null, contract: null,
                 error: (err as Error).message };
      }
    },

    dustMinor: () => DUST_MINOR,

    async health(env): Promise<Health[]> {
      return (await health(env, chainId)).map((r) => ({
        name: r.name, ok: r.ok, height: r.block,
        wrongNetwork: r.ok && r.chainId !== chainId, note: r.error,
      }));
    },

    browser: {
      walletHint: "MetaMask, Rabby or another Ethereum wallet",
      script: `window.railWallet = (function () {
        var want = ${JSON.stringify("0x" + chainId.toString(16))};
        var eth = function () { return window.ethereum; };
        return {
          present: function () { return !!window.ethereum; },
          same: function (a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); },
          accounts: function () { return eth().request({ method: "eth_requestAccounts" }); },
          signMessage: function (address, msg) {
            return eth().request({ method: "personal_sign", params: [msg, address] });
          },
          prepare: async function () {
            if (await eth().request({ method: "eth_chainId" }) !== want) {
              await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
            }
          },
          send: async function (check) {
            var accounts = await eth().request({ method: "eth_requestAccounts" });
            // A token moves by calling its contract; Ether moves by value.
            var tx = check.native
              ? { from: accounts[0], to: check.to, value: check.value, data: "0x" }
              : { from: accounts[0], to: check.token, value: "0x0", data: check.data };
            return eth().request({ method: "eth_sendTransaction", params: [tx] });
          },
          landed: async function (hash) {
            try { return !!(await eth().request({ method: "eth_getTransactionReceipt", params: [hash] })); }
            catch (e) { return false; }
          },
          waitSeconds: 120,
          pendingAdvice: "",
        };
      })();`,
    },

    verify(env, hash, want): Promise<Verification | null> {
      return native
        ? etherTransferHappened(env, chainId, hash, { to: want.to, amountWei: want.amountMinor })
        : transferHappened(env, chainId, hash, { token: token!, to: want.to, amountMinor: want.amountMinor });
    },
  };
}
