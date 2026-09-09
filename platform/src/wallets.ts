/**
 * Proving a wallet belongs to the person claiming it.
 *
 * On an irreversible transfer this is the single most valuable check there is.
 * Validating the shape of an address catches a mangled paste; it does not
 * catch a plausible address belonging to somebody else, which is what a
 * compromised mailbox produces. The only thing that settles it is a signature
 * from the key that controls the address.
 *
 * The mechanism is EIP-191 personal_sign, the same one already in use in
 * VerifiedWallet: the holder signs a message we composed, we recover the
 * signer from the signature, and compare. Nothing is trusted from the client
 * except the signature itself, and the message is rebuilt here rather than
 * accepted from them — otherwise somebody could have a signature over a
 * message of their own choosing and we would happily verify it.
 *
 * Recovery uses @noble/curves, which is audited and has no dependencies. This
 * is not a place to write one's own elliptic curve arithmetic.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { type Env } from "./db.ts";
import { ethCall } from "./chain.ts";

const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function unhex(s: string): Uint8Array {
  const clean = s.startsWith("0x") ? s.slice(2) : s;
  if (clean.length % 2) throw new Error("odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("not hex");
    out[i] = byte;
  }
  return out;
}

/**
 * EIP-55: capitalise a hex digit where the corresponding nibble of the address
 * hash is 8 or above. It turns an address into its own checksum, so a single
 * altered character is visible to anything that checks.
 */
export function toChecksum(address: string): string {
  const body = address.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Error("not an address");
  const h = hex(keccak_256(new TextEncoder().encode(body)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(h[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

/**
 * Is this an address, and if it is mixed-case, does it check out?
 *
 * An all-lowercase or all-uppercase address is accepted — plenty of tools emit
 * those and they carry no checksum to fail. A mixed-case one is claiming to be
 * checksummed, and if it is wrong that is a corrupted address, not a style.
 */
export function addressProblem(address: string): string | null {
  const raw = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return "An address is 0x followed by forty hex characters.";
  }
  const body = raw.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && toChecksum(raw) !== raw) {
    return "That address fails its own checksum — a character has been altered. " +
           "Copy and paste it again rather than retyping.";
  }
  return null;
}

/**
 * The exact words the holder is asked to sign.
 *
 * It names the transaction, the address and a nonce, so a signature obtained
 * for one purpose cannot be replayed for another — and it is written to be
 * read by a person in a wallet pop-up, because a message nobody can read is a
 * message everybody approves.
 */
export function challenge(opts: {
  ref: string;
  address: string;
  role: "sender" | "recipient";
  nonce: string;
}): string {
  return [
    `ThePaymaster — proof of wallet control`,
    ``,
    `I control this wallet and am the ${opts.role} on transaction ${opts.ref}.`,
    ``,
    `Wallet: ${opts.address}`,
    `Reference: ${opts.ref}`,
    `Nonce: ${opts.nonce}`,
    ``,
    `Signing this proves you hold the key. It does not move anything and`,
    `costs nothing.`,
  ].join("\n");
}

/** The digest personal_sign actually signs. */
export function personalHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(
    `\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  return keccak_256(joined);
}

/** Recover the address that produced a signature over this message. */
export function recover(message: string, signature: string): string | null {
  let bytes: Uint8Array;
  try { bytes = unhex(signature.trim()); } catch { return null; }
  if (bytes.length !== 65) return null;

  // The recovery byte is 27 or 28 in most wallets, 0 or 1 in a few, and
  // 35-plus where a chain id has been folded in by an older EIP-155 signer.
  let v = bytes[64];
  if (v >= 35) v = (v - 35) % 2;
  else if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;

  try {
    const sig = secp256k1.Signature
      .fromCompact(bytes.slice(0, 64))
      .addRecoveryBit(v);
    const point = sig.recoverPublicKey(personalHash(message));
    const uncompressed = point.toRawBytes(false).slice(1);   // drop the 0x04
    return toChecksum("0x" + hex(keccak_256(uncompressed).slice(-20)));
  } catch {
    return null;
  }
}

/**
 * Does this signature prove control of this address?
 *
 * Comparison is on the checksummed form of both, so case can never make a
 * match look like a mismatch.
 */
export function proves(message: string, signature: string, address: string): boolean {
  const signer = recover(message, signature);
  if (!signer) return false;
  try {
    return signer === toChecksum(address);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Contract wallets
// ---------------------------------------------------------------------------

/** isValidSignature(bytes32,bytes) — the current EIP-1271 selector and answer. */
const EIP1271 = "0x1626ba7e";
/** isValidSignature(bytes,bytes) — the older form, still used by Safe v1.0.0. */
const EIP1271_LEGACY = "0x20c13b0b";

const word = (n: number) => n.toString(16).padStart(64, "0");

/**
 * Does this address accept this signature as its own?
 *
 * A Safe, or any other smart-contract wallet, has no private key — there is
 * nothing to recover a signer from, so the ordinary check can only ever fail.
 * EIP-1271 turns the question around: instead of working out who signed, ask
 * the contract whether it considers the signature valid, and let it apply
 * whatever rule it likes about owners and thresholds.
 *
 * Both selectors are tried. Safe v1.0.0 answers the older one, and a sender
 * with an old Safe is exactly the sender who will not want to migrate it in
 * the middle of a transaction.
 */
export async function contractAccepts(env: Env, chainId: number, opts: {
  address: string; message: string; signature: string;
}): Promise<boolean> {
  let sig: Uint8Array;
  try { sig = unhex(opts.signature.trim()); } catch { return false; }

  const digest = hex(personalHash(opts.message));
  const padded = Math.ceil(sig.length / 32) * 32;
  const tail = hex(sig) + "0".repeat((padded - sig.length) * 2);

  // (bytes32 hash, bytes signature): the second argument is dynamic, so the
  // head holds its offset and the tail holds length then contents.
  const modern = EIP1271 + digest + word(0x40) + word(sig.length) + tail;
  // (bytes data, bytes signature): both dynamic.
  const dataLen = personalHash(opts.message).length;
  const legacy = EIP1271_LEGACY + word(0x40) + word(0x40 + 32 + dataLen) +
    word(dataLen) + digest + word(sig.length) + tail;

  for (const [data, expect] of [[modern, EIP1271], [legacy, EIP1271_LEGACY]]) {
    try {
      const result = await ethCall(env, chainId, opts.address, data);
      if (typeof result === "string" && result.slice(0, 10).toLowerCase() === expect) {
        return true;
      }
    } catch { /* not this shape; try the other */ }
  }
  return false;
}

/**
 * Control of an address, however that address is built.
 *
 * An ordinary wallet is proved by recovering the signing key. A contract
 * wallet is proved by asking the contract. The caller does not need to know
 * which it is holding.
 */
export async function provesControl(env: Env, chainId: number, opts: {
  address: string; message: string; signature: string;
}): Promise<boolean> {
  if (proves(opts.message, opts.signature, opts.address)) return true;
  return contractAccepts(env, chainId, opts);
}
