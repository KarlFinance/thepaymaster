/**
 * Tron, the parts the platform needs: addresses and signed messages.
 *
 * A Tron address is an Ethereum-shaped 20-byte key hash with a 0x41 prefix,
 * written in Base58Check — the familiar "T…" of 34 characters. Messages are
 * signed the way Ethereum signs them, with a different prefix (TIP-191,
 * "\x19TRON Signed Message:\n"), and recovered with the same curve. Nothing
 * here talks to the network; that is the rail's job.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const TRON_PREFIX = 0x41;
/** Reserved integers for screening and tests; Tron's own EVM-compatible ids. */
export const TRON_CHAIN_ID = { mainnet: 728126428, nile: 3448148188 } as const;
export type TronNetwork = keyof typeof TRON_CHAIN_ID;

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const unhex = (h: string) => new Uint8Array((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

// --- Base58Check -----------------------------------------------------------------

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return new Uint8Array(out);
}

const checksum = (payload: Uint8Array) => sha256(sha256(payload)).slice(0, 4);

/** 21 payload bytes (0x41 + 20) → "T…". */
export function encodeAddress(payload21: Uint8Array): string {
  const full = new Uint8Array(25); full.set(payload21); full.set(checksum(payload21), 21);
  return base58Encode(full);
}

/** "T…" → the 20 key-hash bytes, or a reason it is not a Tron address. */
export function decodeAddress(text: string): { bytes20: Uint8Array } | { why: string } {
  const s = text.trim();
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) {
    return { why: "A Tron address is 34 characters and starts with T." };
  }
  const raw = base58Decode(s);
  if (!raw || raw.length !== 25) return { why: "That is not a valid Tron address." };
  if (raw[0] !== TRON_PREFIX) return { why: "That is not a Tron mainnet-style address (wrong prefix)." };
  const want = checksum(raw.slice(0, 21)), got = raw.slice(21);
  if (want.some((b, i) => b !== got[i])) return { why: "That is not a valid Tron address — a character is wrong or missing." };
  return { bytes20: raw.slice(1, 21) };
}

/** The 20-byte hash as 0x-less hex, as TronGrid wants it in ABI parameters and logs. */
export function addressHex20(text: string): string | null {
  const d = decodeAddress(text);
  return "why" in d ? null : hex(d.bytes20);
}

/** From a 20-byte (or 21-byte 41-prefixed) hex to "T…". */
export function addressFromHex(h: string): string {
  const b = unhex(h);
  const body = b.length === 21 ? b.slice(1) : b.slice(-20);
  const payload = new Uint8Array(21); payload[0] = TRON_PREFIX; payload.set(body, 1);
  return encodeAddress(payload);
}

export function addressProblem(text: string): string | null {
  const d = decodeAddress(text);
  return "why" in d ? d.why : null;
}

// --- signed messages (TIP-191 v2) ---------------------------------------------------

export function messageHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19TRON Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix); joined.set(body, prefix.length);
  return keccak_256(joined);
}

export function addressOfPublicKey(pub: Uint8Array): string {
  const uncompressed = pub.length === 65 ? pub.slice(1) : secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false).slice(1);
  const payload = new Uint8Array(21); payload[0] = TRON_PREFIX; payload.set(keccak_256(uncompressed).slice(-20), 1);
  return encodeAddress(payload);
}

/** Who signed this message? Null when the signature is malformed. */
export function recover(message: string, signature: string): string | null {
  let bytes: Uint8Array;
  try { bytes = unhex(signature.trim()); } catch { return null; }
  if (bytes.length !== 65) return null;
  let v = bytes[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(bytes.slice(0, 64)).addRecoveryBit(v);
    return addressOfPublicKey(sig.recoverPublicKey(messageHash(message)).toRawBytes(false));
  } catch { return null; }
}

export function proves(message: string, signature: string, address: string): boolean {
  const signer = recover(message, signature);
  return Boolean(signer) && signer === address.trim();
}

/** Sign a message the way TronLink's signMessageV2 does. Used by tests and rehearsals only. */
export function signMessage(message: string, priv: Uint8Array): string {
  const sig = secp256k1.sign(messageHash(message), priv);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes()); out[64] = 27 + sig.recovery!;
  return "0x" + hex(out);
}
