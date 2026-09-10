/**
 * One Bitcoin transaction that pays everybody.
 *
 * Bitcoin lets a single transaction carry any number of outputs, so a whole
 * distribution — every recipient, our fee, the sender's change — can be one
 * signature and one txid. This builds that transaction as a PSBT (BIP-174):
 * the sender's wallet signs it, we never see a key, and the platform then
 * verifies each leg against the outputs of the one transaction that results.
 *
 * Coin selection is deliberately dull: largest first until the total and the
 * fee are covered. Cleverness here saves a few hundred sats and costs an
 * auditor an afternoon.
 */

import { type Address, type AddressType, type Network, parseAddress, scriptPubKey,
         concat, varint, varstr, u32le, u64le, sha256d, toHex, fromHex } from "./btc.ts";

export interface Utxo {
  txid: string;            // display order (as explorers print it)
  vout: number;
  value: bigint;           // sats
  script: Uint8Array;      // the scriptPubKey it is locked to
  /** The whole previous transaction, needed only for legacy (P2PKH) inputs. */
  rawTx?: Uint8Array;
}

export interface Payment { to: Address; value: bigint; ref?: string }

/** Below this an output is dust; a change output smaller than this joins the fee. */
export const DUST_LIMIT = 546n;

// --- size -----------------------------------------------------------------

const IN_VBYTES: Record<AddressType, number> = { p2pkh: 148, p2sh: 91, p2wpkh: 68, p2wsh: 105, p2tr: 58 };
const OUT_VBYTES: Record<AddressType, number> = { p2pkh: 34, p2sh: 32, p2wpkh: 31, p2wsh: 43, p2tr: 43 };

/** A close-enough virtual size for fee estimation, rounded up. */
export function estimateVbytes(inputs: AddressType[], outputs: AddressType[]): number {
  const base = 10.5 + (inputs.some((t) => t !== "p2pkh") ? 0.5 : 0);
  return Math.ceil(base + inputs.reduce((n, t) => n + IN_VBYTES[t], 0)
                        + outputs.reduce((n, t) => n + OUT_VBYTES[t], 0));
}

// --- coin selection ------------------------------------------------------

export interface Selection { inputs: Utxo[]; fee: bigint; change: bigint }

/**
 * Enough coins to pay `payments` plus a fee at `satsPerVbyte`, with change
 * back to `from`. Returns why not when the wallet cannot cover it.
 */
export function selectCoins(utxos: Utxo[], payments: Payment[], from: Address,
                            satsPerVbyte: number): Selection | { why: string } {
  const target = payments.reduce((n, p) => n + p.value, 0n);
  const outTypes = payments.map((p) => p.to.type);
  const sorted = [...utxos].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const chosen: Utxo[] = [];
  let have = 0n;
  for (const u of sorted) {
    chosen.push(u); have += u.value;
    const inTypes = chosen.map(() => from.type);
    const withChange = BigInt(estimateVbytes(inTypes, [...outTypes, from.type]) * satsPerVbyte);
    const noChange = BigInt(estimateVbytes(inTypes, outTypes) * satsPerVbyte);
    if (have >= target + withChange && have - target - withChange >= DUST_LIMIT) {
      return { inputs: chosen, fee: withChange, change: have - target - withChange };
    }
    // Enough for the payments and a fee, but what is left would be dust as a
    // change output: no change output, and the remainder goes to the miner.
    if (have >= target + noChange) return { inputs: chosen, fee: have - target, change: 0n };
  }
  const short = target - have;
  return { why: `The wallet holds ${have} sats; this needs ${target} plus the fee — about ${short} sats short.` };
}

// --- the transaction and its PSBT -----------------------------------------

const rev = (hex: string) => fromHex(hex).reverse();
const SEQUENCE = 0xfffffffd;   // opt-in RBF, as wallets do

/** The unsigned transaction, serialised without witnesses (BIP-144 legacy form). */
export function unsignedTx(inputs: Utxo[], outputs: { script: Uint8Array; value: bigint }[]): Uint8Array {
  return concat(
    u32le(2),
    varint(inputs.length),
    ...inputs.map((u) => concat(rev(u.txid), u32le(u.vout), varint(0), u32le(SEQUENCE))),
    varint(outputs.length),
    ...outputs.map((o) => concat(u64le(o.value), varstr(o.script))),
    u32le(0),
  );
}

const kv = (type: number, value: Uint8Array, keydata = new Uint8Array(0)) =>
  concat(varstr(concat(new Uint8Array([type]), keydata)), varstr(value));

export interface Built {
  psbt: Uint8Array;
  base64: string;
  hex: string;
  /** The txid the signed transaction will have if nothing changes the inputs/outputs (segwit). */
  txid: string;
  outputs: { to: string; value: bigint; ref?: string; change: boolean }[];
  fee: bigint;
  vbytes: number;
}

export function buildPsbt(o: {
  from: Address; payments: Payment[]; selection: Selection;
}): Built {
  const outs = [
    ...o.payments.map((p) => ({ script: scriptPubKey(p.to), value: p.value, to: p.to.text, ref: p.ref, change: false })),
    ...(o.selection.change > 0n
      ? [{ script: scriptPubKey(o.from), value: o.selection.change, to: o.from.text, ref: undefined, change: true }]
      : []),
  ];
  const tx = unsignedTx(o.selection.inputs, outs);

  const psbt = concat(
    new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]),          // magic
    kv(0x00, tx),                                             // PSBT_GLOBAL_UNSIGNED_TX
    new Uint8Array([0x00]),
    ...o.selection.inputs.map((u) => concat(
      // Every input carries the output it spends; a legacy input carries the
      // whole previous transaction as well, because legacy signing hashes it.
      u.rawTx ? kv(0x00, u.rawTx) : new Uint8Array(0),        // PSBT_IN_NON_WITNESS_UTXO
      kv(0x01, concat(u64le(u.value), varstr(u.script))),     // PSBT_IN_WITNESS_UTXO
      new Uint8Array([0x00]),
    )),
    ...outs.map(() => new Uint8Array([0x00])),
  );

  const txidBytes = sha256d(tx).reverse();
  return {
    psbt, base64: btoa(String.fromCharCode(...psbt)), hex: toHex(psbt),
    txid: toHex(txidBytes),
    outputs: outs.map(({ to, value, ref, change }) => ({ to, value, ref, change })),
    fee: o.selection.fee,
    vbytes: estimateVbytes(o.selection.inputs.map(() => o.from.type), outs.map(() => o.from.type)),
  };
}

// --- reading one back (tests, and the rehearsal signer) -------------------

export interface ParsedPsbt {
  tx: { version: number; inputs: { txid: string; vout: number; sequence: number }[];
        outputs: { value: bigint; script: Uint8Array }[]; locktime: number };
  inputs: { witnessUtxo?: { value: bigint; script: Uint8Array }; nonWitnessUtxo?: Uint8Array }[];
}

export function parsePsbt(bytes: Uint8Array): ParsedPsbt {
  let o = 0;
  const u8 = () => bytes[o++];
  const readVarint = (): number => {
    const x = u8();
    if (x < 0xfd) return x;
    if (x === 0xfd) { const v = bytes[o] | (bytes[o + 1] << 8); o += 2; return v; }
    if (x === 0xfe) { const v = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0; o += 4; return v; }
    throw new Error("varint too large");
  };
  const readBytes = (n: number) => { const b = bytes.slice(o, o + n); o += n; return b; };
  const readMap = (): Map<string, Uint8Array> => {
    const m = new Map<string, Uint8Array>();
    for (;;) {
      const klen = readVarint();
      if (klen === 0) return m;
      const key = readBytes(klen);
      const vlen = readVarint();
      m.set(toHex(key), readBytes(vlen));
    }
  };
  if (toHex(readBytes(5)) !== "70736274ff") throw new Error("not a PSBT");
  const global = readMap();
  const raw = global.get("00");
  if (!raw) throw new Error("no unsigned transaction");

  // The unsigned transaction.
  let t = 0;
  const tu8 = () => raw[t++];
  const tvarint = (): number => { const x = tu8(); if (x < 0xfd) return x; if (x === 0xfd) { const v = raw[t] | (raw[t + 1] << 8); t += 2; return v; } const v = (raw[t] | (raw[t + 1] << 8) | (raw[t + 2] << 16) | (raw[t + 3] << 24)) >>> 0; t += 4; return v; };
  const tbytes = (n: number) => { const b = raw.slice(t, t + n); t += n; return b; };
  const t32 = () => { const b = tbytes(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
  const t64 = () => { const b = tbytes(8); let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
  const version = t32();
  const nIn = tvarint();
  const inputs = [];
  for (let i = 0; i < nIn; i++) {
    const txid = toHex(tbytes(32).reverse()); const vout = t32(); tbytes(tvarint()); const sequence = t32();
    inputs.push({ txid, vout, sequence });
  }
  const nOut = tvarint();
  const outputs = [];
  for (let i = 0; i < nOut; i++) { const value = t64(); const script = tbytes(tvarint()); outputs.push({ value, script }); }
  const locktime = t32();

  const inMaps = inputs.map(() => readMap());
  return {
    tx: { version, inputs, outputs, locktime },
    inputs: inMaps.map((m) => {
      const w = m.get("01");
      let witnessUtxo;
      if (w) {
        let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(w[i]);
        const slen = w[8]; witnessUtxo = { value: v, script: w.slice(9, 9 + slen) };
      }
      return { witnessUtxo, nonWitnessUtxo: m.get("00") };
    }),
  };
}

/** Parse a list of addresses into payments, refusing the first bad one. */
export function paymentsFor(legs: { to: string; value: bigint; ref?: string }[], network: Network):
    Payment[] | { why: string } {
  const out: Payment[] = [];
  for (const l of legs) {
    const a = parseAddress(l.to, network);
    if ("why" in a) return { why: `${l.ref ?? l.to}: ${a.why}` };
    if (l.value < DUST_LIMIT) return { why: `${l.ref ?? l.to}: ${l.value} sats is below the dust limit.` };
    out.push({ to: a, value: l.value, ref: l.ref });
  }
  return out;
}
