/**
 * Bitcoin, the parts the platform needs and nothing more.
 *
 * Addresses in all four shapes and both encodings; the script each one stands
 * for; and two ways a wallet can prove it holds the key behind an address —
 * the legacy "Bitcoin Signed Message" that Electrum, Sparrow and every
 * hardware wallet have done for a decade, and BIP-322, which is what Unisat,
 * Xverse and Leather produce and the only one that works for taproot.
 *
 * No library does this for Workers without dragging in a node polyfill, so
 * it is done here, from the BIPs, against the BIPs' own test vectors
 * (btc.test.ts). Same secp256k1 curve as Ethereum; @noble supplies it and the
 * Schnorr variant taproot needs.
 */

import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";

export type Network = "mainnet" | "signet" | "testnet";

/**
 * The chain ids the rest of the schema files Bitcoin under. `wallet_screens`
 * and `address_tests` carry an integer chain id; Bitcoin has no such number,
 * so it is given one nobody else uses.
 */
export const BTC_CHAIN_ID: Record<Network, number> = { mainnet: 100000, signet: 100001, testnet: 100002 };
export type AddressType = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";

export interface Address {
  type: AddressType;
  network: Network;
  /** The 20- or 32-byte program or hash the script commits to. */
  program: Uint8Array;
  /** The address as it should be written. */
  text: string;
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
export const sha256d = (b: Uint8Array) => sha256(sha256(b));
export const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const u32le = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const u64le = (n: bigint) => {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(8 * i)) & 255n);
  return out;
};
function varint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 255, n >>> 8]);
  return concat(new Uint8Array([0xfe]), u32le(n));
}
const varstr = (b: Uint8Array) => concat(varint(b.length), b);
const utf8 = (s: string) => new TextEncoder().encode(s);
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const reversed = (b: Uint8Array) => Uint8Array.from(b).reverse();

function base64ToBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/\s+/g, ""));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Base58Check
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  let zeros = 0;
  for (const c of s) { if (c === "1") zeros++; else break; }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const x of b) { if (x === 0) out = "1" + out; else break; }
  return out;
}

/** Payload without the checksum, or null when the checksum does not hold. */
export function base58CheckDecode(s: string): Uint8Array | null {
  const raw = base58Decode(s);
  if (!raw || raw.length < 5) return null;
  const body = raw.slice(0, -4), sum = raw.slice(-4);
  return eq(sha256d(body).slice(0, 4), sum) ? body : null;
}

export function base58CheckEncode(payload: Uint8Array): string {
  return base58Encode(concat(payload, sha256d(payload).slice(0, 4)));
}

// ---------------------------------------------------------------------------
// Bech32 / Bech32m (BIP-173, BIP-350)
// ---------------------------------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1, BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >>> from) return null;
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >>> bits) & max); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); }
  else if (bits >= from || (acc << (to - bits)) & max) return null;
  return out;
}

export function bech32Decode(s: string): { hrp: string; words: number[]; m: boolean } | null {
  if (s.length > 90 || s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
  s = s.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos);
  const words: number[] = [];
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    words.push(v);
  }
  const chk = polymod([...hrpExpand(hrp), ...words]);
  if (chk !== BECH32_CONST && chk !== BECH32M_CONST) return null;
  return { hrp, words: words.slice(0, -6), m: chk === BECH32M_CONST };
}

export function bech32Encode(hrp: string, words: number[], m: boolean): string {
  const values = [...hrpExpand(hrp), ...words];
  const mod = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ (m ? BECH32M_CONST : BECH32_CONST);
  const check = [];
  for (let i = 0; i < 6; i++) check.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...check].map((w) => CHARSET[w]).join("");
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const HRP: Record<Network, string> = { mainnet: "bc", signet: "tb", testnet: "tb" };
const P2PKH_VERSION: Record<Network, number> = { mainnet: 0x00, signet: 0x6f, testnet: 0x6f };
const P2SH_VERSION: Record<Network, number> = { mainnet: 0x05, signet: 0xc4, testnet: 0xc4 };

/** Parse an address on the given network. Returns why not, otherwise the address. */
export function parseAddress(text: string, network: Network): Address | { why: string } {
  const s = text.trim();
  if (!s) return { why: "No address." };

  if (/^(bc|tb|bcrt)1/i.test(s)) {
    const d = bech32Decode(s);
    if (!d) return { why: "That is not a valid bech32 address — a character is wrong or missing." };
    if (d.hrp !== HRP[network]) {
      return { why: network === "mainnet"
        ? "That is a test-network address (tb1…); this transaction is on Bitcoin mainnet (bc1…)."
        : "That is a mainnet address (bc1…); this rehearsal is on a test network (tb1…)." };
    }
    if (!d.words.length) return { why: "Empty address." };
    const version = d.words[0];
    const program = convertBits(d.words.slice(1), 5, 8, false);
    if (!program) return { why: "That is not a valid bech32 address." };
    if (version === 0) {
      if (d.m) return { why: "A bc1q address must use bech32, not bech32m." };
      if (program.length === 20) return { type: "p2wpkh", network, program: new Uint8Array(program), text: s.toLowerCase() };
      if (program.length === 32) return { type: "p2wsh", network, program: new Uint8Array(program), text: s.toLowerCase() };
      return { why: "A version-0 address must carry 20 or 32 bytes." };
    }
    if (version === 1) {
      if (!d.m) return { why: "A bc1p address must use bech32m." };
      if (program.length !== 32) return { why: "A taproot address must carry 32 bytes." };
      return { type: "p2tr", network, program: new Uint8Array(program), text: s.toLowerCase() };
    }
    return { why: `Witness version ${version} is not one we can pay.` };
  }

  const body = base58CheckDecode(s);
  if (!body) return { why: "That is not a valid Bitcoin address — the checksum does not hold." };
  if (body.length !== 21) return { why: "That is not a Bitcoin address." };
  const version = body[0], program = body.slice(1);
  if (version === P2PKH_VERSION[network]) return { type: "p2pkh", network, program, text: s };
  if (version === P2SH_VERSION[network]) return { type: "p2sh", network, program, text: s };
  const other: Network = network === "mainnet" ? "testnet" : "mainnet";
  if (version === P2PKH_VERSION[other] || version === P2SH_VERSION[other]) {
    return { why: network === "mainnet"
      ? "That is a test-network address; this transaction is on Bitcoin mainnet."
      : "That is a mainnet address; this rehearsal is on a test network." };
  }
  return { why: "That is not a Bitcoin address we recognise." };
}

export function scriptPubKey(a: Address): Uint8Array {
  switch (a.type) {
    case "p2pkh": return concat(new Uint8Array([0x76, 0xa9, 0x14]), a.program, new Uint8Array([0x88, 0xac]));
    case "p2sh": return concat(new Uint8Array([0xa9, 0x14]), a.program, new Uint8Array([0x87]));
    case "p2wpkh": return concat(new Uint8Array([0x00, 0x14]), a.program);
    case "p2wsh": return concat(new Uint8Array([0x00, 0x20]), a.program);
    case "p2tr": return concat(new Uint8Array([0x51, 0x20]), a.program);
  }
}

/** The address text for a key, in each shape a wallet might present it. */
export function addressFor(pub: Uint8Array, type: "p2pkh" | "p2wpkh" | "p2sh-p2wpkh" | "p2tr",
                           network: Network): string {
  if (type === "p2pkh") return base58CheckEncode(concat(new Uint8Array([P2PKH_VERSION[network]]), hash160(pub)));
  if (type === "p2sh-p2wpkh") {
    const redeem = concat(new Uint8Array([0x00, 0x14]), hash160(pub));
    return base58CheckEncode(concat(new Uint8Array([P2SH_VERSION[network]]), hash160(redeem)));
  }
  if (type === "p2wpkh") {
    return bech32Encode(HRP[network], [0, ...convertBits([...hash160(pub)], 8, 5, true)!], false);
  }
  // p2tr, BIP-86: the output key is the internal x-only key tweaked with itself.
  return bech32Encode(HRP[network], [1, ...convertBits([...taprootOutputKey(pub)], 8, 5, true)!], true);
}

/** BIP-86 output key for an internal key with no script tree. */
export function taprootOutputKey(pub: Uint8Array): Uint8Array {
  const xonly = pub.length === 32 ? pub : pub.slice(1, 33);
  const t = schnorr.utils.taggedHash("TapTweak", xonly);
  const P = schnorr.utils.lift_x(schnorr.utils.bytesToNumberBE(xonly));
  const Q = P.add(secp256k1.ProjectivePoint.BASE.multiply(schnorr.utils.bytesToNumberBE(t)));
  return Q.toRawBytes(true).slice(1, 33);
}

// ---------------------------------------------------------------------------
// Legacy signed messages ("Bitcoin Signed Message:\n")
// ---------------------------------------------------------------------------

export function messageHash(message: string): Uint8Array {
  return sha256d(concat(varstr(utf8("Bitcoin Signed Message:\n")), varstr(utf8(message))));
}

/** Sign the legacy way. Only the rehearsal needs this; the platform verifies. */
export function signMessageLegacy(message: string, priv: Uint8Array, compressed = true): string {
  const sig = secp256k1.sign(messageHash(message), priv);
  const header = 27 + sig.recovery! + (compressed ? 4 : 0);
  const out = concat(new Uint8Array([header]), sig.toCompactRawBytes());
  return btoa(String.fromCharCode(...out));
}

/** Does a legacy signature over `message` come from the key behind `address`? */
export function verifyMessageLegacy(address: Address, message: string, signature: string): boolean {
  const sig = base64ToBytes(signature);
  if (!sig || sig.length !== 65) return false;
  const header = sig[0];
  if (header < 27 || header > 46) return false;
  const recid = (header - 27) & 3;
  let point;
  try {
    point = secp256k1.Signature.fromCompact(sig.slice(1)).addRecoveryBit(recid)
      .recoverPublicKey(messageHash(message));
  } catch { return false; }
  const compressed = point.toRawBytes(true);
  const uncompressed = point.toRawBytes(false);
  switch (address.type) {
    case "p2pkh":
      return eq(hash160(compressed), address.program) || eq(hash160(uncompressed), address.program);
    case "p2wpkh":
      return eq(hash160(compressed), address.program);
    case "p2sh":
      return eq(hash160(concat(new Uint8Array([0x00, 0x14]), hash160(compressed))), address.program);
    case "p2tr":
      // Some wallets sign a taproot address's message with plain ECDSA over the
      // internal key. Accept it when the BIP-86 tweak lands on the address.
      return eq(taprootOutputKey(compressed), address.program);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// BIP-322, "simple" encoding
// ---------------------------------------------------------------------------

const ZERO32 = new Uint8Array(32);

/** The virtual transaction that "spends" the message. */
export function toSpend(message: string, script: Uint8Array): Uint8Array {
  const tag = schnorr.utils.taggedHash("BIP0322-signed-message", utf8(message));
  return concat(
    u32le(0),                                                   // version
    varint(1), ZERO32, u32le(0xffffffff),                       // one input from nowhere
    varstr(concat(new Uint8Array([0x00, 0x20]), tag)),          // scriptSig: OP_0 PUSH32 <tag>
    u32le(0),                                                   // sequence
    varint(1), u64le(0n), varstr(script),                       // one output of nothing, to the address
    u32le(0),                                                   // locktime
  );
}

export function toSpendTxid(message: string, script: Uint8Array): Uint8Array {
  return sha256d(toSpend(message, script));
}

const TO_SIGN_OUTPUT = concat(u64le(0n), varstr(new Uint8Array([0x6a])));   // 0 sats to OP_RETURN

/** to_sign without its witness, as a txid is computed over. */
export function toSignTxid(spendTxid: Uint8Array): Uint8Array {
  return sha256d(concat(
    u32le(0), varint(1), spendTxid, u32le(0), varint(0), u32le(0),
    varint(1), TO_SIGN_OUTPUT, u32le(0)));
}

function parseWitness(b: Uint8Array): Uint8Array[] | null {
  let o = 0;
  const readVarint = (): number | null => {
    if (o >= b.length) return null;
    const x = b[o++];
    if (x < 0xfd) return x;
    if (x === 0xfd) { const v = b[o] | (b[o + 1] << 8); o += 2; return v; }
    if (x === 0xfe) { const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); o += 4; return v >>> 0; }
    return null;
  };
  const n = readVarint();
  if (n === null) return null;
  const items: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const len = readVarint();
    if (len === null || o + len > b.length) return null;
    items.push(b.slice(o, o + len)); o += len;
  }
  return o === b.length ? items : null;
}

/** BIP-143 sighash of to_sign's only input, spending a P2WPKH output of 0. */
function sighashSegwitV0(spendTxid: Uint8Array, pubkeyHash: Uint8Array, hashType: number): Uint8Array {
  const outpoint = concat(spendTxid, u32le(0));
  const scriptCode = concat(new Uint8Array([0x19, 0x76, 0xa9, 0x14]), pubkeyHash, new Uint8Array([0x88, 0xac]));
  return sha256d(concat(
    u32le(0),                          // version
    sha256d(outpoint),                 // hashPrevouts
    sha256d(u32le(0)),                 // hashSequence
    outpoint,
    scriptCode,
    u64le(0n),                         // amount
    u32le(0),                          // sequence
    sha256d(TO_SIGN_OUTPUT),           // hashOutputs
    u32le(0),                          // locktime
    u32le(hashType),
  ));
}

/** BIP-341 key-path sighash of to_sign's only input. */
function sighashTaproot(spendTxid: Uint8Array, spentScript: Uint8Array, hashType: number): Uint8Array {
  const outpoint = concat(spendTxid, u32le(0));
  const msg = concat(
    new Uint8Array([0x00]),            // epoch
    new Uint8Array([hashType]),
    u32le(0), u32le(0),                // version, locktime
    sha256(outpoint),                  // sha_prevouts
    sha256(u64le(0n)),                 // sha_amounts
    sha256(varstr(spentScript)),       // sha_scriptpubkeys
    sha256(u32le(0)),                  // sha_sequences
    ...(((hashType & 3) !== 2 && (hashType & 3) !== 3) ? [sha256(TO_SIGN_OUTPUT)] : []),  // sha_outputs
    new Uint8Array([0x00]),            // spend_type: key path, no annex
    u32le(0),                          // input index
  );
  return schnorr.utils.taggedHash("TapSighash", msg);
}

/** Does a BIP-322 simple signature over `message` come from the key behind `address`? */
export function verifyMessageBip322(address: Address, message: string, signature: string): boolean {
  const raw = base64ToBytes(signature);
  if (!raw) return false;
  const witness = parseWitness(raw);
  if (!witness) return false;
  const script = scriptPubKey(address);
  const spendTxid = toSpendTxid(message, script);

  try {
    if (address.type === "p2wpkh" || address.type === "p2sh") {
      // p2sh is accepted as wrapped p2wpkh: the witness is the same, the
      // redeem script is implied by the address.
      if (witness.length !== 2) return false;
      const [sigWithType, pub] = witness;
      if (pub.length !== 33) return false;
      const keyHash = hash160(pub);
      const commits = address.type === "p2wpkh"
        ? eq(keyHash, address.program)
        : eq(hash160(concat(new Uint8Array([0x00, 0x14]), keyHash)), address.program);
      if (!commits) return false;
      const hashType = sigWithType[sigWithType.length - 1];
      const der = sigWithType.slice(0, -1);
      const digest = sighashSegwitV0(spendTxid, keyHash, hashType);
      const sig = secp256k1.Signature.fromDER(der);
      return secp256k1.verify(sig.toCompactRawBytes(), digest, pub, { lowS: false });
    }
    if (address.type === "p2tr") {
      if (witness.length !== 1) return false;
      const w = witness[0];
      const hashType = w.length === 65 ? w[64] : 0;
      if (w.length !== 64 && w.length !== 65) return false;
      const digest = sighashTaproot(spendTxid, script, hashType);
      return schnorr.verify(w.slice(0, 64), digest, address.program);
    }
  } catch { return false; }
  return false;
}

/** Either proof the wallet may have produced. */
export function verifyMessage(address: Address, message: string, signature: string): boolean {
  const s = signature.trim();
  if (!s) return false;
  return verifyMessageBip322(address, message, s) || verifyMessageLegacy(address, message, s);
}

// ---------------------------------------------------------------------------
// Signing, for the rehearsal only
// ---------------------------------------------------------------------------

/** BIP-322 simple signature for a P2WPKH address. */
export function signMessageBip322P2wpkh(message: string, priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, true);
  const address: Address = { type: "p2wpkh", network: "mainnet", program: hash160(pub), text: "" };
  const digest = sighashSegwitV0(toSpendTxid(message, scriptPubKey(address)), hash160(pub), 1);
  const der = secp256k1.sign(digest, priv).toDERRawBytes();
  const witness = concat(varint(2), varstr(concat(der, new Uint8Array([1]))), varstr(pub));
  return btoa(String.fromCharCode(...witness));
}

/** BIP-322 simple signature for a BIP-86 taproot address. */
export function signMessageBip322P2tr(message: string, priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, true);
  const xonly = pub.slice(1, 33);
  // Tweak the private key to match the output key (negating if the point is odd).
  const P = secp256k1.ProjectivePoint.fromPrivateKey(priv);
  let d = secp256k1.utils.normPrivateKeyToScalar(priv);
  if (P.toAffine().y % 2n === 1n) d = secp256k1.CURVE.n - d;
  const t = schnorr.utils.bytesToNumberBE(schnorr.utils.taggedHash("TapTweak", xonly));
  const tweaked = (d + t) % secp256k1.CURVE.n;
  const tweakedBytes = fromHex(tweaked.toString(16).padStart(64, "0"));
  const address: Address = { type: "p2tr", network: "mainnet", program: taprootOutputKey(pub), text: "" };
  const script = scriptPubKey(address);
  const digest = sighashTaproot(toSpendTxid(message, script), script, 0);
  const sig = schnorr.sign(digest, tweakedBytes);
  return btoa(String.fromCharCode(...concat(varint(1), varstr(sig))));
}

/** Decode a WIF private key. Returns the 32-byte key and whether it was flagged compressed. */
export function wifDecode(wif: string): { priv: Uint8Array; compressed: boolean } | null {
  const body = base58CheckDecode(wif);
  if (!body || (body.length !== 33 && body.length !== 34)) return null;
  return { priv: body.slice(1, 33), compressed: body.length === 34 };
}

export { reversed as txidDisplay };
