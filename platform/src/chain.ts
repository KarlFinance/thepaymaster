/**
 * Asking the chain itself, rather than taking anyone's word.
 *
 * Every check here answers a question that costs real money to get wrong on a
 * USDT distribution, and every one is a free read.
 *
 *   Does the sender actually hold it? A transaction that reaches the point of
 *   execution and reverts for want of balance has wasted everyone's day and
 *   told the recipients something they should not have had to learn that way.
 *
 *   Has Tether blacklisted any address involved? This is the one most people
 *   miss. USDT is not a neutral token: Tether can and does freeze addresses on
 *   law-enforcement request, and a blacklisted recipient cannot receive. Sending
 *   to one destroys the funds in the sense that matters — they arrive nowhere
 *   and cannot be recovered by us.
 *
 *   Is a recipient address a contract? Perfectly legitimate — a Safe, an
 *   exchange deposit contract — but a contract that cannot handle a token
 *   receipt is a way to lose funds permanently, so it is flagged for a human
 *   rather than assumed either way.
 *
 * USDT is also not a well-behaved ERC-20: its transfer and approve return
 * nothing rather than a boolean, and its approve refuses to move a non-zero
 * allowance to another non-zero value. Anything that executes against it has
 * to be tested against USDT specifically, not against a token that merely
 * implements the same interface.
 */

import { type Env } from "./db.ts";

/** Tether on Ethereum mainnet. Six decimals, not eighteen. */
export const USDT_MAINNET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

export const CHAINS: Record<number, { name: string; rpc: string; explorer: string }> = {
  1: {
    name: "Ethereum",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
  },
  11155111: {
    name: "Sepolia",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
};

function pad(address: string): string {
  return address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

async function rpc(env: Env, chainId: number, method: string,
                   params: unknown[]): Promise<any> {
  // A public endpoint is fine for reads and costs nothing. Before a real
  // execution this should be a paid endpoint with an agreement behind it —
  // a public node rate-limiting at the wrong moment is not a risk worth
  // carrying on a transaction this size.
  const url = env.ETH_RPC_URL && chainId === 1
    ? env.ETH_RPC_URL
    : CHAINS[chainId]?.rpc;
  if (!url) throw new Error(`no RPC for chain ${chainId}`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = await res.json<any>();
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

async function ethCall(env: Env, chainId: number, to: string, data: string): Promise<string> {
  return rpc(env, chainId, "eth_call", [{ to, data }, "latest"]);
}

/** Balance in the token's own smallest unit. */
export async function tokenBalance(env: Env, chainId: number, token: string,
                                   holder: string): Promise<bigint> {
  const result = await ethCall(env, chainId, token, "0x70a08231" + pad(holder));
  return BigInt(result || "0x0");
}

/**
 * Tether's own blacklist.
 *
 * Only USDT has this; the selector is for its isBlackListed(address). A token
 * without the function will throw, which is treated as "cannot tell" rather
 * than "not blacklisted" — the difference matters.
 */
export async function isBlacklisted(env: Env, chainId: number, token: string,
                                    address: string): Promise<boolean | null> {
  try {
    const result = await ethCall(env, chainId, token, "0xe47d6060" + pad(address));
    return BigInt(result || "0x0") === 1n;
  } catch {
    return null;
  }
}

/** Is there code at this address? */
export async function isContract(env: Env, chainId: number,
                                 address: string): Promise<boolean | null> {
  try {
    const code = await rpc(env, chainId, "eth_getCode", [address, "latest"]);
    return typeof code === "string" && code !== "0x";
  } catch {
    return null;
  }
}

export interface AddressReport {
  address: string;
  role: string;
  balance: bigint | null;
  blacklisted: boolean | null;
  contract: boolean | null;
  error?: string;
}

/** Everything worth knowing about one address, in a single pass. */
export async function inspect(env: Env, chainId: number, token: string,
                              address: string, role: string): Promise<AddressReport> {
  try {
    const [balance, blacklisted, contract] = await Promise.all([
      tokenBalance(env, chainId, token, address).catch(() => null),
      isBlacklisted(env, chainId, token, address),
      isContract(env, chainId, address),
    ]);
    return { address, role, balance, blacklisted, contract };
  } catch (err) {
    return {
      address, role, balance: null, blacklisted: null, contract: null,
      error: (err as Error).message,
    };
  }
}

export function explorerLink(chainId: number, hash: string): string {
  const base = CHAINS[chainId]?.explorer;
  return base ? `${base}/tx/${hash}` : hash;
}

export function addressLink(chainId: number, address: string): string {
  const base = CHAINS[chainId]?.explorer;
  return base ? `${base}/address/${address}` : address;
}

/** A transaction hash is 32 bytes of hex, and nothing else will do. */
export function txHashProblem(hash: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash.trim())) {
    return "A transaction hash is 0x followed by sixty-four hex characters.";
  }
  return null;
}

/**
 * Did this transaction happen, and did it succeed?
 *
 * A hash somebody typed in is a claim. The receipt is the fact — and a
 * transaction can exist, be mined, and still have reverted, which looks
 * identical from the outside if all you have is the hash.
 */
export async function receipt(env: Env, chainId: number, hash: string): Promise<{
  found: boolean; succeeded: boolean; block: number | null; from: string | null;
} | null> {
  try {
    const r = await rpc(env, chainId, "eth_getTransactionReceipt", [hash]);
    if (!r) return { found: false, succeeded: false, block: null, from: null };
    return {
      found: true,
      succeeded: BigInt(r.status ?? "0x0") === 1n,
      block: r.blockNumber ? Number(BigInt(r.blockNumber)) : null,
      from: r.from ?? null,
    };
  } catch {
    return null;
  }
}
