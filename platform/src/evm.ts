/**
 * Sending a transaction from the platform's own key.
 *
 * Everything else the platform does on a chain is reading, or asking a
 * person's wallet to sign. Minting a certificate is the one thing the
 * platform signs itself, with the attestation key, and pays for. So: RLP,
 * an EIP-1559 transaction, a signature, and eth_sendRawTransaction — by hand,
 * so there is no wallet library between the key and the wire.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { type Env } from "./db.ts";
import { endpoints, receipt as confirmReceipt } from "./chain.ts";

// --- bytes and RLP ----------------------------------------------------------------

export const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h: string) => new Uint8Array((h.replace(/^0x/, "").padStart(Math.ceil(h.replace(/^0x/, "").length / 2) * 2, "0").match(/../g) ?? []).map((x) => parseInt(x, 16)));
const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** A bigint as the shortest big-endian byte string (empty for zero), as RLP wants. */
export function beBytes(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  if (v === 0n) return new Uint8Array(0);
  const out: number[] = [];
  while (v > 0n) { out.unshift(Number(v & 255n)); v >>= 8n; }
  return new Uint8Array(out);
}

function rlpLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([offset + len]);
  const lb = beBytes(len);
  return concat(new Uint8Array([offset + 55 + lb.length]), lb);
}

export type Rlp = Uint8Array | Rlp[];
export function rlp(item: Rlp): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat(rlpLength(item.length, 0x80), item);
  }
  const body = concat(...item.map(rlp));
  return concat(rlpLength(body.length, 0xc0), body);
}

// --- ABI encoding, the little we need -----------------------------------------------

const word32 = (b: Uint8Array) => { const w = new Uint8Array(32); w.set(b, 32 - b.length); return w; };
export const abiAddress = (a: string) => word32(unhex(a));
export const abiUint = (n: bigint | number) => word32(beBytes(n));
/** A single dynamic string argument: offset, length, padded bytes. */
export function abiString(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32); padded.set(b);
  return concat(abiUint(32), abiUint(b.length), padded);
}
export const selector = (sig: string) => keccak_256(new TextEncoder().encode(sig)).slice(0, 4);

// --- the transaction --------------------------------------------------------------------

export interface Tx1559 {
  chainId: number; nonce: number; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint;
  gasLimit: bigint; to: string | null; value: bigint; data: Uint8Array;
}

/** The unsigned payload the signature covers: 0x02 || rlp([...fields, accessList]). */
export function unsignedTx(t: Tx1559): Uint8Array {
  return concat(new Uint8Array([0x02]), rlp([
    beBytes(t.chainId), beBytes(t.nonce), beBytes(t.maxPriorityFeePerGas), beBytes(t.maxFeePerGas),
    beBytes(t.gasLimit), t.to ? unhex(t.to) : new Uint8Array(0), beBytes(t.value), t.data, [],
  ]));
}

/** The signed, serialised transaction and its hash. */
export function signTx(t: Tx1559, priv: Uint8Array): { raw: Uint8Array; hash: string } {
  const sig = secp256k1.sign(keccak_256(unsignedTx(t)), priv);
  const raw = concat(new Uint8Array([0x02]), rlp([
    beBytes(t.chainId), beBytes(t.nonce), beBytes(t.maxPriorityFeePerGas), beBytes(t.maxFeePerGas),
    beBytes(t.gasLimit), t.to ? unhex(t.to) : new Uint8Array(0), beBytes(t.value), t.data, [],
    beBytes(sig.recovery!), beBytes(sig.r), beBytes(sig.s),
  ]));
  return { raw, hash: hex(keccak_256(raw)) };
}

export function addressOf(priv: Uint8Array): string {
  return hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20));
}

// --- talking to the chain ------------------------------------------------------------------

async function ask(env: Env, chainId: number, method: string, params: unknown[]): Promise<any> {
  let last: Error | null = null;
  for (const ep of endpoints(env, chainId)) {
    try {
      const res = await fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const body = await res.json<any>();
      if (body.error) throw new Error(body.error.message ?? "RPC error");
      return body.result;
    } catch (err) { last = err as Error; }
  }
  throw last ?? new Error(`no endpoint for chain ${chainId}`);
}

export async function nativeBalance(env: Env, chainId: number, address: string): Promise<bigint> {
  return BigInt(await ask(env, chainId, "eth_getBalance", [address, "latest"]));
}

/** Fees from the chain: the base fee doubled, plus a modest tip. */
export async function fees(env: Env, chainId: number): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await ask(env, chainId, "eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block?.baseFeePerGas ?? "0x3b9aca00");
  let tip = 1_000_000n;                                    // 0.001 gwei — Base is cheap
  try { tip = BigInt(await ask(env, chainId, "eth_maxPriorityFeePerGas", [])); } catch { /* default */ }
  if (tip < 1_000_000n) tip = 1_000_000n;
  return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
}

/** Sign, send, and wait for the receipt (cross-checked as every other receipt is). */
export async function sendTx(env: Env, priv: Uint8Array, t: Omit<Tx1559, "nonce" | "maxFeePerGas" | "maxPriorityFeePerGas"> & Partial<Tx1559>):
    Promise<{ hash: string; contractAddress: string | null; status: boolean; block: number | null }> {
  const from = addressOf(priv);
  const nonce = t.nonce ?? Number(BigInt(await ask(env, t.chainId, "eth_getTransactionCount", [from, "pending"])));
  const f = await fees(env, t.chainId);
  const full: Tx1559 = { ...t, nonce, maxFeePerGas: t.maxFeePerGas ?? f.maxFeePerGas,
    maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? f.maxPriorityFeePerGas } as Tx1559;
  const { raw, hash } = signTx(full, priv);
  const sent = await ask(env, t.chainId, "eth_sendRawTransaction", [hex(raw)]);
  if (String(sent).toLowerCase() !== hash.toLowerCase()) throw new Error("the node returned a different hash");

  // Base blocks are two seconds; give it a minute, then report what we have.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const rec = await ask(env, t.chainId, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (rec) {
      return { hash, contractAddress: rec.contractAddress ?? null, status: BigInt(rec.status ?? "0x0") === 1n,
               block: rec.blockNumber ? Number(BigInt(rec.blockNumber)) : null };
    }
  }
  return { hash, contractAddress: null, status: false, block: null };
}

/** A view call. */
export async function call(env: Env, chainId: number, to: string, data: Uint8Array): Promise<string> {
  return ask(env, chainId, "eth_call", [{ to, data: hex(data) }, "latest"]);
}

export { confirmReceipt };
