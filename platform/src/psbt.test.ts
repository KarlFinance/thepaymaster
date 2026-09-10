/**
 * The one-transaction distribution: coin selection, the PSBT's shape, and that
 * what we build reads back as what we meant.
 *
 *   node --experimental-strip-types src/psbt.test.ts
 */
import { parseAddress, toHex, addressFor, wifDecode } from "./btc.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { estimateVbytes, selectCoins, buildPsbt, parsePsbt, paymentsFor, DUST_LIMIT, type Utxo } from "./psbt.ts";

let bad = 0;
const check = (n: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got, (_, v) => typeof v === "bigint" ? v.toString() : v);
  const w = JSON.stringify(want, (_, v) => typeof v === "bigint" ? v.toString() : v);
  if (g !== w) { bad++; console.log(`  FAIL ${n}\n       got  ${g}\n       want ${w}`); }
  else console.log(`  ok   ${n}`);
};
const A = (s: string) => { const a = parseAddress(s, "signet"); if ("why" in a) throw new Error(a.why); return a; };

const from = A("tb1qaz3tjj266t222w04ahmfkh24w9t8h0llcv8a0z");
const r1 = A("tb1q9vza2e8x573nczrlzms0wvx3gsqjx7vaxwd45v");
const r2 = A("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
const feeKey = wifDecode("L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k")!;
const fee = A(addressFor(secp256k1.getPublicKey(feeKey.priv, true), "p2tr", "signet"));  // a taproot fee wallet
const script = (a: any) => new Uint8Array([0x00, 0x14, ...a.program]);

// --- sizes ----------------------------------------------------------------
check("vbytes 1-in 2-out p2wpkh", estimateVbytes(["p2wpkh"], ["p2wpkh", "p2wpkh"]), 141);
check("vbytes 2-in 4-out mixed", estimateVbytes(["p2wpkh", "p2wpkh"], ["p2wpkh", "p2wpkh", "p2tr", "p2wpkh"]), 283);

// --- payments -------------------------------------------------------------
check("paymentsFor refuses a mainnet address on signet",
  (paymentsFor([{ to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", value: 5000n, ref: "r" }], "signet") as any).why.includes("mainnet"), true);
check("paymentsFor refuses dust", (paymentsFor([{ to: r1.text, value: 100n, ref: "r" }], "signet") as any).why.includes("dust"), true);
const payments = paymentsFor([
  { to: r1.text, value: 50_000n, ref: "r1" }, { to: r2.text, value: 30_000n, ref: "r2" }, { to: fee.text, value: 1_000n, ref: "fee" },
], "signet") as any[];
check("three payments parsed", payments.length, 3);

// --- coin selection -------------------------------------------------------
const utxos: Utxo[] = [
  { txid: "11".repeat(32), vout: 0, value: 20_000n, script: script(from) },
  { txid: "22".repeat(32), vout: 1, value: 100_000n, script: script(from) },
  { txid: "33".repeat(32), vout: 0, value: 5_000n, script: script(from) },
];
const sel = selectCoins(utxos, payments, from, 2) as any;
check("largest coin first, one input suffices", sel.inputs.map((u: Utxo) => u.txid.slice(0, 2)), ["22"]);
check("fee = vbytes × rate (1 in, 4 out incl. change)", sel.fee, BigInt(estimateVbytes(["p2wpkh"], ["p2wpkh", "p2wpkh", "p2tr", "p2wpkh"]) * 2));
check("change = in − out − fee", sel.change, 100_000n - 81_000n - sel.fee);
check("short wallet says how short",
  (selectCoins(utxos.slice(2), payments, from, 2) as any).why.includes("short"), true);
const tight = selectCoins([{ txid: "44".repeat(32), vout: 0, value: 81_000n + 400n, script: script(from) }], payments, from, 2) as any;
check("dust change folds into the fee", [tight.change, tight.fee], [0n, 400n]);

// --- the PSBT -------------------------------------------------------------
const built = buildPsbt({ from, payments, selection: sel });
check("magic", toHex(built.psbt.slice(0, 5)), "70736274ff");
check("four outputs: three payments and change last", built.outputs.map((o) => o.change), [false, false, false, true]);
check("base64 round-trips", Buffer.from(built.base64, "base64").equals(Buffer.from(built.psbt)), true);
const back = parsePsbt(built.psbt);
check("parsed: one input, from the chosen coin", back.tx.inputs, [{ txid: "22".repeat(32), vout: 1, sequence: 0xfffffffd }]);
check("parsed: output values", back.tx.outputs.map((o) => o.value), [50_000n, 30_000n, 1_000n, sel.change]);
check("parsed: output scripts are the addresses' scripts", back.tx.outputs.map((o) => toHex(o.script).slice(0, 4)), ["0014", "0014", "5120", "0014"]);
check("parsed: witness utxo carried", back.inputs[0].witnessUtxo, { value: 100_000n, script: script(from) });
check("parsed: no legacy prev tx for segwit", back.inputs[0].nonWitnessUtxo, undefined);
check("version 2, locktime 0", [back.tx.version, back.tx.locktime], [2, 0]);
check("txid is 64 hex", /^[0-9a-f]{64}$/.test(built.txid), true);

// Legacy input carries the previous transaction.
const legacyFrom = A("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn");
const legacyUtxo: Utxo[] = [{ txid: "55".repeat(32), vout: 0, value: 200_000n,
  script: new Uint8Array([0x76, 0xa9, 0x14, ...legacyFrom.program, 0x88, 0xac]), rawTx: new Uint8Array([1, 2, 3]) }];
const lsel = selectCoins(legacyUtxo, payments, legacyFrom, 1) as any;
const lbuilt = buildPsbt({ from: legacyFrom, payments, selection: lsel });
check("legacy: prev tx carried in the PSBT", parsePsbt(lbuilt.psbt).inputs[0].nonWitnessUtxo, new Uint8Array([1, 2, 3]));

check("dust limit is 546", DUST_LIMIT, 546n);
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
