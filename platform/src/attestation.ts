/**
 * ThePaymaster's signature on a seal.
 *
 * A seal is a root and a date. Anyone can check the root against a record;
 * nobody could, until now, check that *we* made the seal — the verifier's
 * "ThePaymaster sealed this on …" was our database talking. This adds a
 * cryptographic signature from a key only ThePaymaster holds, over the seal's
 * fields, in the EIP-712 typed-data form every Ethereum wallet and library
 * understands. The signing address is published; the signature travels with
 * the record; and a bank's engineer can verify it with any Ethereum library,
 * offline, in one call.
 *
 * It is the off-chain form of an Ethereum attestation (the same shape EAS
 * uses), which costs nothing to make and can be published on chain later.
 * The key lives in the Worker secret ATTEST_KEY and nowhere else.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { type Env } from "./db.ts";
import { toChecksum } from "./wallets.ts";

export const DOMAIN = { name: "ThePaymaster Dossier", version: "1", chainId: 1 };
export const TYPES = {
  DossierSeal: [
    { name: "ref", type: "string" },
    { name: "root", type: "bytes32" },
    { name: "leafCount", type: "uint64" },
    { name: "sealedAt", type: "string" },
    { name: "algorithm", type: "string" },
  ],
};

export interface SealMessage { ref: string; root: string; leafCount: number; sealedAt: string; algorithm: string }

export interface Attestation {
  attester: string;          // checksummed address of the signing key
  domain: typeof DOMAIN;
  primaryType: "DossierSeal";
  types: typeof TYPES;
  message: SealMessage;
  signature: string;         // 0x r s v (65 bytes)
}

// --- EIP-712 hashing, by hand --------------------------------------------------

const enc = new TextEncoder();
const hex = (b: Uint8Array) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new Uint8Array((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));
const word = (b: Uint8Array) => { const w = new Uint8Array(32); w.set(b, 32 - b.length); return w; };
const uintWord = (n: number | bigint) => word(unhex(BigInt(n).toString(16).padStart(64, "0")));
const concat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId)";
const SEAL_TYPE = "DossierSeal(string ref,bytes32 root,uint64 leafCount,string sealedAt,string algorithm)";

export function domainSeparator(): Uint8Array {
  return keccak_256(concat(
    keccak_256(enc.encode(DOMAIN_TYPE)),
    keccak_256(enc.encode(DOMAIN.name)),
    keccak_256(enc.encode(DOMAIN.version)),
    uintWord(DOMAIN.chainId),
  ));
}

export function structHash(m: SealMessage): Uint8Array {
  return keccak_256(concat(
    keccak_256(enc.encode(SEAL_TYPE)),
    keccak_256(enc.encode(m.ref)),
    word(unhex(m.root)),
    uintWord(m.leafCount),
    keccak_256(enc.encode(m.sealedAt)),
    keccak_256(enc.encode(m.algorithm)),
  ));
}

/** The digest a wallet signs for this typed data. */
export function digest(m: SealMessage): Uint8Array {
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domainSeparator(), structHash(m)));
}

// --- the key -------------------------------------------------------------------

function keyOf(env: Env): Uint8Array | null {
  const k = (env as any).ATTEST_KEY as string | undefined;
  if (!k || !/^(0x)?[0-9a-fA-F]{64}$/.test(k.trim())) return null;
  return unhex(k.trim());
}

export function addressOf(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  return toChecksum(hex(keccak_256(pub).slice(-20)));
}

/** The published signing address, or null when no key is configured. */
export function attester(env: Env): string | null {
  const k = keyOf(env);
  return k ? addressOf(k) : null;
}

export function sign(priv: Uint8Array, m: SealMessage): string {
  const sig = secp256k1.sign(digest(m), priv);
  return hex(concat(sig.toCompactRawBytes(), new Uint8Array([27 + sig.recovery!])));
}

/** Who signed this seal message. Null when the signature is malformed. */
export function recover(m: SealMessage, signature: string): string | null {
  try {
    const raw = unhex(signature);
    if (raw.length !== 65) return null;
    const v = raw[64] >= 27 ? raw[64] - 27 : raw[64];
    const point = secp256k1.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(digest(m));
    return toChecksum(hex(keccak_256(point.toRawBytes(false).slice(1)).slice(-20)));
  } catch { return null; }
}

export function verify(a: Attestation): boolean {
  const who = recover(a.message, a.signature);
  return who !== null && who === toChecksum(a.attester);
}

// --- seals in the database -------------------------------------------------------

export function messageFor(seal: { root: string; leaf_count: number; sealed_at: string; algorithm?: string }, ref: string): SealMessage {
  return { ref, root: seal.root.startsWith("0x") ? seal.root : "0x" + seal.root, leafCount: Number(seal.leaf_count),
           sealedAt: String(seal.sealed_at), algorithm: seal.algorithm ?? "sha256-merkle-v1" };
}

/**
 * The attestation for a seal, made and stored the first time it is asked for.
 * Seals made before the key existed get theirs the first time anyone looks.
 */
export async function attestationFor(env: Env, seal: any, ref: string): Promise<Attestation | null> {
  const k = keyOf(env);
  if (!k) return null;
  const message = messageFor(seal, ref);
  let signature: string | null = seal.attestation ?? null;
  let who: string | null = seal.attester ?? null;
  const mine = addressOf(k);
  if (!signature || who !== mine || recover(message, signature) !== mine) {
    signature = sign(k, message);
    who = mine;
    await env.DB.prepare("UPDATE dossier_seals SET attester = ?, attestation = ? WHERE id = ?")
      .bind(who, signature, seal.id).run();
  }
  return { attester: who!, domain: DOMAIN, primaryType: "DossierSeal", types: TYPES, message, signature: signature! };
}


// --- the annual statement --------------------------------------------------------

const ANNUAL_TYPE = "AnnualStatement(string party,uint16 year,bytes32 digest,string issuedAt)";
export const ANNUAL_TYPES = {
  AnnualStatement: [
    { name: "party", type: "string" }, { name: "year", type: "uint16" },
    { name: "digest", type: "bytes32" }, { name: "issuedAt", type: "string" },
  ],
};
export interface AnnualMessage { party: string; year: number; digest: string; issuedAt: string }
export interface AnnualAttestation {
  attester: string; domain: typeof DOMAIN; primaryType: "AnnualStatement";
  types: typeof ANNUAL_TYPES; message: AnnualMessage; signature: string;
}

export function annualStructHash(m: AnnualMessage): Uint8Array {
  return keccak_256(concat(
    keccak_256(enc.encode(ANNUAL_TYPE)),
    keccak_256(enc.encode(m.party)),
    uintWord(m.year),
    word(unhex(m.digest)),
    keccak_256(enc.encode(m.issuedAt)),
  ));
}
export function annualDigest(m: AnnualMessage): Uint8Array {
  return keccak_256(concat(new Uint8Array([0x19, 0x01]), domainSeparator(), annualStructHash(m)));
}
export function signAnnual(priv: Uint8Array, m: AnnualMessage): string {
  const sig = secp256k1.sign(annualDigest(m), priv);
  return hex(concat(sig.toCompactRawBytes(), new Uint8Array([27 + sig.recovery!])));
}
export function recoverAnnual(m: AnnualMessage, signature: string): string | null {
  try {
    const raw = unhex(signature);
    if (raw.length !== 65) return null;
    const v = raw[64] >= 27 ? raw[64] - 27 : raw[64];
    const point = secp256k1.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(annualDigest(m));
    return toChecksum(hex(keccak_256(point.toRawBytes(false).slice(1)).slice(-20)));
  } catch { return null; }
}
export function verifyAnnual(a: AnnualAttestation): boolean {
  const who = recoverAnnual(a.message, a.signature);
  return who !== null && who === toChecksum(a.attester);
}
/** Signed fresh each time it is issued; the digest is what ties it to its contents. */
export async function attestAnnual(env: Env, m: AnnualMessage): Promise<AnnualAttestation | null> {
  const k = keyOf(env);
  if (!k) return null;
  return { attester: addressOf(k), domain: DOMAIN, primaryType: "AnnualStatement", types: ANNUAL_TYPES, message: m, signature: signAnnual(k, m) };
}
