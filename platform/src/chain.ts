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
export const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
/** The token a rail defaults to on mainnet, by symbol. Other chains must be typed. */
export const DEFAULT_TOKENS: Record<number, Record<string, string>> = {
  1: { usdt: USDT_MAINNET, usdc: USDC_MAINNET },
};

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
  // Base: where the certificates live. Cheap enough to mint one per party.
  8453: {
    name: "Base",
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
  },
  84532: {
    name: "Base Sepolia",
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
};

function pad(address: string): string {
  return address.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

export interface Endpoint { name: string; url: string; }

/**
 * The same key, pointed at a different network.
 *
 * Alchemy and Infura name the network in the hostname and let one key serve
 * all of them, so the testnet endpoint costs nothing extra and the rehearsal
 * stops depending on a public node. A provider we do not recognise is only
 * ever used for the network it was configured for — guessing a hostname is
 * how you end up checking a mainnet payment against a testnet.
 */
function retarget(url: string | undefined, chainId: number): string | undefined {
  if (!url) return undefined;
  const slug: Record<number, { alchemy: string; infura: string }> = {
    1:        { alchemy: "eth-mainnet", infura: "mainnet" },
    11155111: { alchemy: "eth-sepolia", infura: "sepolia" },
  };
  const want = slug[chainId];
  if (!want) return undefined;
  if (/\/\/eth-(mainnet|sepolia)\./.test(url)) {
    return url.replace(/\/\/eth-(mainnet|sepolia)\./, `//${want.alchemy}.`);
  }
  if (/\/\/(mainnet|sepolia)\.infura\.io/.test(url)) {
    return url.replace(/\/\/(mainnet|sepolia)\.infura\.io/, `//${want.infura}.infura.io`);
  }
  // Unrecognised provider: take it at face value, and only for mainnet.
  return chainId === 1 && !/sepolia|goerli|holesky/i.test(url) ? url : undefined;
}

/** Who we will ask, most trusted first. */
export function endpoints(env: Env, chainId: number): Endpoint[] {
  const out: Endpoint[] = [];
  const add = (name: string, url?: string) => {
    if (url && !out.some((e) => e.url === url)) out.push({ name, url });
  };
  add("primary", retarget(env.ETH_RPC_URL, chainId));
  add("secondary", retarget(env.ETH_RPC_URL_2, chainId));
  add("public", CHAINS[chainId]?.rpc);
  return out;
}

async function ask(url: string, method: string, params: unknown[]): Promise<any> {
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

/**
 * An ordinary read: first endpoint that answers wins.
 *
 * Balances and blacklist checks are inputs to a decision a person then makes,
 * so falling through to the next provider is the right behaviour — being
 * unable to read is worse than reading from the second choice. Confirming that
 * money moved is a different question, and is handled by `receipt`.
 */
async function rpc(env: Env, chainId: number, method: string,
                   params: unknown[]): Promise<any> {
  const eps = endpoints(env, chainId);
  if (!eps.length) throw new Error(`no RPC for chain ${chainId}`);
  let last: Error | null = null;
  for (const ep of eps) {
    try { return await ask(ep.url, method, params); }
    catch (err) { last = err as Error; }
  }
  throw last ?? new Error("no endpoint answered");
}

/** A read-only call. Exported so wallet code can ask a contract a question. */
export async function ethCall(env: Env, chainId: number, to: string,
                              data: string): Promise<string> {
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
export interface Confirmation {
  found: boolean;
  succeeded: boolean;
  block: number | null;
  from: string | null;
  /** How many independent endpoints answered. */
  sources: number;
  /** True when every endpoint that answered told the same story. */
  agreed: boolean;
  conflict?: string;
}

/**
 * Did this transaction happen, and did it succeed — according to more than one
 * person?
 *
 * A hash somebody types in is a claim. A receipt is the fact. But a receipt
 * from a single endpoint is only a fact if that endpoint is honest, current,
 * and on the chain it says it is; a node that is lagging, forked, or lying
 * would have us record a payment that did not happen. At this size that is
 * worth a second opinion, so every endpoint we have is asked and they must
 * agree.
 *
 * Disagreement is never resolved by voting. The most cautious answer is
 * returned with `agreed` false, and the caller refuses.
 */
export async function receipt(env: Env, chainId: number,
                              hash: string): Promise<Confirmation | null> {
  const eps = endpoints(env, chainId);
  const answers = await Promise.all(eps.map(async (ep) => {
    try {
      const r = await ask(ep.url, "eth_getTransactionReceipt", [hash]);
      if (!r) return { ep, found: false, succeeded: false, block: null, from: null };
      return {
        ep,
        found: true,
        succeeded: BigInt(r.status ?? "0x0") === 1n,
        block: r.blockNumber ? Number(BigInt(r.blockNumber)) : null,
        from: (r.from ?? null) as string | null,
      };
    } catch {
      return null;   // unreachable is not an answer
    }
  }));

  const heard = answers.filter((a): a is NonNullable<typeof a> => a !== null);
  if (!heard.length) return null;

  const key = (a: typeof heard[number]) => `${a.found}|${a.succeeded}|${a.block}`;
  const distinct = [...new Set(heard.map(key))];
  const best = heard.find((a) => !a.found) ?? heard[0];   // the cautious one

  if (distinct.length > 1) {
    return {
      found: false, succeeded: false, block: null, from: null,
      sources: heard.length, agreed: false,
      conflict: heard.map((a) => `${a.ep.name}: ` +
        (a.found ? `block ${a.block}, ${a.succeeded ? "succeeded" : "reverted"}`
                 : "no such transaction")).join("; "),
    };
  }

  return {
    found: best.found, succeeded: best.succeeded, block: best.block, from: best.from,
    sources: heard.length, agreed: true,
  };
}

/** Which endpoints are answering, and do they see the same chain and head? */
export async function health(env: Env, chainId: number): Promise<Array<{
  name: string; ok: boolean; chainId: number | null; block: number | null; error?: string;
}>> {
  return Promise.all(endpoints(env, chainId).map(async (ep) => {
    try {
      const [cid, blk] = await Promise.all([
        ask(ep.url, "eth_chainId", []),
        ask(ep.url, "eth_blockNumber", []),
      ]);
      return {
        name: ep.name, ok: true,
        chainId: Number(BigInt(cid)), block: Number(BigInt(blk)),
      };
    } catch (err) {
      return { name: ep.name, ok: false, chainId: null, block: null,
               error: (err as Error).message };
    }
  }));
}

/**
 * The transaction as it was sent, rather than only whether it worked.
 *
 * Anchoring needs the calldata, and calldata is the one field an endpoint
 * could alter without the receipt looking wrong — so it is cross-checked the
 * same way, and a disagreement is a refusal rather than a vote.
 */
export async function sentTransaction(env: Env, chainId: number, hash: string): Promise<{
  input: string; from: string; to: string | null; block: number | null;
  sources: number; agreed: boolean; conflict?: string;
} | null> {
  const answers = await Promise.all(endpoints(env, chainId).map(async (ep) => {
    try {
      const t = await ask(ep.url, "eth_getTransactionByHash", [hash]);
      if (!t) return { ep, input: "", from: "", to: null as string | null, block: null as number | null };
      return {
        ep,
        input: String(t.input ?? "").toLowerCase(),
        from: String(t.from ?? "").toLowerCase(),
        to: t.to ? String(t.to).toLowerCase() : null,
        block: t.blockNumber ? Number(BigInt(t.blockNumber)) : null,
      };
    } catch { return null; }
  }));
  const heard = answers.filter((a): a is NonNullable<typeof a> => a !== null);
  if (!heard.length) return null;

  const key = (a: typeof heard[number]) => `${a.input}|${a.from}|${a.to}|${a.block}`;
  if (new Set(heard.map(key)).size > 1) {
    return {
      input: "", from: "", to: null, block: null,
      sources: heard.length, agreed: false,
      conflict: heard.map((a) => `${a.ep.name}: ` +
        (a.input ? `${a.input.slice(0, 18)}… in block ${a.block}` : "no such transaction")).join("; "),
    };
  }
  return { ...heard[0], sources: heard.length, agreed: true };
}

/** When the chain says a block happened. Seconds since the epoch, UTC. */
export async function blockTime(env: Env, chainId: number,
                                block: number): Promise<number | null> {
  try {
    const b = await rpc(env, chainId, "eth_getBlockByNumber",
      ["0x" + block.toString(16), false]);
    return b?.timestamp ? Number(BigInt(b.timestamp)) : null;
  } catch { return null; }
}

/** keccak("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Did this transaction actually move this token, to this address, in this
 * amount?
 *
 * Matching the transaction's calldata would be simpler and would be wrong: it
 * only recognises a payment sent directly from an ordinary wallet. A sender
 * paying from a Safe, through a batch tool, or via any contract produces a
 * transaction whose `to` is that contract and whose calldata is not a
 * transfer — yet the money moves exactly as intended.
 *
 * The event log is the honest test. The token contract itself emits Transfer
 * whenever its balances change, whoever asked and however the call was routed.
 * The recipient is an indexed topic and the amount is the data word.
 *
 * Cross-checked, because this is the check that says money arrived.
 */
export async function transferHappened(env: Env, chainId: number, hash: string, want: {
  token: string; to: string; amountMinor: number | bigint;
}): Promise<{ ok: boolean; from: string | null; block: number | null;
              sources: number; agreed: boolean; problem?: string } | null> {
  const token = want.token.toLowerCase();
  const to = want.to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amount = BigInt(want.amountMinor);

  const answers = await Promise.all(endpoints(env, chainId).map(async (ep) => {
    try {
      const r = await ask(ep.url, "eth_getTransactionReceipt", [hash]);
      if (!r) return { ep, exists: false, ok: false, from: null as string | null,
                       block: null as number | null };
      const succeeded = BigInt(r.status ?? "0x0") === 1n;
      const logs: any[] = Array.isArray(r.logs) ? r.logs : [];
      const hit = logs.some((l) =>
        String(l.address ?? "").toLowerCase() === token &&
        String(l.topics?.[0] ?? "").toLowerCase() === TRANSFER_TOPIC &&
        String(l.topics?.[2] ?? "").toLowerCase().endsWith(to) &&
        BigInt(l.data ?? "0x0") === amount);
      return {
        ep, exists: true, ok: succeeded && hit,
        from: (r.from ?? null) as string | null,
        block: r.blockNumber ? Number(BigInt(r.blockNumber)) : null,
      };
    } catch { return null; }
  }));

  const heard = answers.filter((a): a is NonNullable<typeof a> => a !== null);
  if (!heard.length) return null;

  // A transaction that has been broadcast but not yet included has no receipt,
  // which is indistinguishable from one that never existed if you only ask for
  // receipts. The difference matters enormously to somebody who has just
  // pressed send, so it is asked about separately.
  if (heard.every((a) => !a.exists)) {
    for (const ep of endpoints(env, chainId)) {
      try {
        const t = await ask(ep.url, "eth_getTransactionByHash", [hash]);
        if (t) {
          return { ok: false, from: t.from ?? null, block: null,
                   sources: heard.length, agreed: true, problem: "pending" };
        }
      } catch { /* ask the next one */ }
    }
  }

  const key = (a: typeof heard[number]) => `${a.exists}|${a.ok}|${a.block}`;
  if (new Set(heard.map(key)).size > 1) {
    return { ok: false, from: null, block: null, sources: heard.length, agreed: false,
      problem: heard.map((a) => `${a.ep.name}: ` +
        (a.exists ? (a.ok ? `carries it, block ${a.block}` : "does not carry it")
                  : "no such transaction")).join("; ") };
  }
  const one = heard[0];
  return {
    ok: one.ok, from: one.from, block: one.block,
    sources: heard.length, agreed: true,
    problem: one.exists ? undefined : "no such transaction",
  };
}

/**
 * Did this transaction pay `to` exactly `amountWei` of Ether?
 *
 * Only a plain transfer counts — the transaction's own `to` and `value`.
 * Ether moved inside a contract call (an internal transaction) is not seen
 * here, deliberately: it cannot be checked from a receipt, and a sender who
 * routes through a contract can record the payment by hand with evidence.
 */
export async function etherTransferHappened(env: Env, chainId: number, hash: string, want: {
  to: string; amountWei: number | bigint;
}): Promise<{ ok: boolean; from: string | null; block: number | null;
              sources: number; agreed: boolean; problem?: string } | null> {
  const to = want.to.toLowerCase();
  const amount = BigInt(want.amountWei);
  const answers = await Promise.all(endpoints(env, chainId).map(async (ep) => {
    try {
      const [t, r] = await Promise.all([
        ask(ep.url, "eth_getTransactionByHash", [hash]),
        ask(ep.url, "eth_getTransactionReceipt", [hash]),
      ]);
      if (!t) return { ep, exists: false, pending: false, ok: false, from: null as string | null, block: null as number | null };
      if (!r) return { ep, exists: true, pending: true, ok: false, from: String(t.from ?? "") || null, block: null as number | null };
      const succeeded = BigInt(r.status ?? "0x0") === 1n;
      const hit = String(t.to ?? "").toLowerCase() === to && BigInt(t.value ?? "0x0") === amount;
      return { ep, exists: true, pending: false, ok: succeeded && hit, from: String(t.from ?? "") || null,
               block: r.blockNumber ? Number(BigInt(r.blockNumber)) : null };
    } catch { return null; }
  }));
  const heard = answers.filter((a): a is NonNullable<typeof a> => a !== null);
  if (!heard.length) return null;
  if (heard.every((a) => !a.exists)) return { ok: false, from: null, block: null, sources: heard.length, agreed: true, problem: "no such transaction" };
  if (heard.some((a) => a.pending)) return { ok: false, from: heard.find((a) => a.pending)!.from, block: null, sources: heard.length, agreed: true, problem: "pending" };
  const key = (a: typeof heard[number]) => `${a.exists}|${a.ok}|${a.block}`;
  if (new Set(heard.map(key)).size > 1) {
    return { ok: false, from: null, block: null, sources: heard.length, agreed: false,
      problem: heard.map((a) => `${a.ep.name}: ${a.ok ? `carries it, block ${a.block}` : "does not carry it"}`).join("; ") };
  }
  return { ok: heard[0].ok, from: heard[0].from, block: heard[0].block, sources: heard.length, agreed: true };
}
