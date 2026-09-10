/**
 * The Bitcoin side of the rehearsal, on signet.
 *
 *   node btc.mjs address              the throwaway wallet's address (fund it from a signet faucet)
 *   node btc.mjs balance [addr]       confirmed sats
 *   node btc.mjs send <to> <sats>     pay an address; prints the txid once broadcast
 *   node btc.mjs sign "<message>"     a BIP-322 signature the platform's proof step accepts
 *   node btc.mjs wait <txid>          block until confirmed
 *
 * The key lives in .rehearsal-key-btc (hex), generated on first use. It is a
 * signet key and has never touched real money; nothing here is reused on
 * mainnet. Sends are single-address P2WPKH, signed per BIP-143, with change
 * back to ourselves — the same shape a wallet produces, so the platform meets
 * exactly what it will meet from a real sender.
 *
 * Signet faucets: https://signetfaucet.com , https://alt.signetfaucet.com
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { randomBytes } from "node:crypto";
import { signMessageBip322P2wpkh, addressFor, parseAddress, scriptPubKey, toHex, fromHex }
  from "../platform/src/btc.ts";

const API = process.env.SIGNET_API ?? "https://mempool.space/signet/api";

// --- key --------------------------------------------------------------------
const keyFile = new URL(".rehearsal-key-btc", import.meta.url);
if (!existsSync(keyFile)) {
  writeFileSync(keyFile, toHex(randomBytes(32)) + "\n", { mode: 0o600 });
  console.error("made a new signet key in .rehearsal-key-btc");
}
const priv = fromHex(readFileSync(keyFile, "utf8").trim());
const pub = secp256k1.getPublicKey(priv, true);
const ME = addressFor(pub, "p2wpkh", "signet");
const myScript = scriptPubKey(parseAddress(ME, "signet"));

// --- bytes ------------------------------------------------------------------
const concat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const sha256d = (b) => sha256(sha256(b));
const hash160 = (b) => ripemd160(sha256(b));
const u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const u64 = (n) => { const o = new Uint8Array(8); let v = BigInt(n); for (let i = 0; i < 8; i++) { o[i] = Number(v & 255n); v >>= 8n; } return o; };
const varint = (n) => n < 0xfd ? new Uint8Array([n]) : n <= 0xffff ? new Uint8Array([0xfd, n & 255, n >>> 8]) : concat(new Uint8Array([0xfe]), u32(n));
const varstr = (b) => concat(varint(b.length), b);
const rev = (h) => fromHex(h).reverse();

async function get(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

// --- a P2WPKH spend ---------------------------------------------------------
async function send(toText, sats) {
  const to = parseAddress(toText, "signet");
  if ("why" in to) throw new Error(to.why);
  const utxos = (await get(`/address/${ME}/utxo`)).filter((u) => u.status.confirmed);
  if (!utxos.length) throw new Error(`no confirmed coins at ${ME} — fund it from a signet faucet`);
  const feeRate = Math.max(1, Math.ceil((await get("/v1/fees/recommended")).halfHourFee ?? 1));

  // Enough inputs for amount + fee; fee for a P2WPKH tx ≈ 11 + 68/in + 31/out vbytes.
  utxos.sort((a, b) => b.value - a.value);
  const ins = []; let have = 0, fee = 0;
  for (const u of utxos) {
    ins.push(u); have += u.value;
    fee = feeRate * (11 + 68 * ins.length + 31 * 2);
    if (have >= sats + fee) break;
  }
  if (have < sats + fee) throw new Error(`have ${have} sats, need ${sats + fee}`);
  const change = have - sats - fee;
  const outs = [{ script: scriptPubKey(to), value: sats }];
  if (change >= 500) outs.push({ script: myScript, value: change });   // else it joins the fee

  const version = u32(2), locktime = u32(0), sequence = u32(0xfffffffd);
  const outpoints = concat(...ins.map((u) => concat(rev(u.txid), u32(u.vout))));
  const hashPrevouts = sha256d(outpoints);
  const hashSequence = sha256d(concat(...ins.map(() => sequence)));
  const outBytes = concat(...outs.map((o) => concat(u64(o.value), varstr(o.script))));
  const hashOutputs = sha256d(outBytes);
  const scriptCode = concat(new Uint8Array([0x19, 0x76, 0xa9, 0x14]), hash160(pub), new Uint8Array([0x88, 0xac]));

  const witnesses = ins.map((u) => {
    const preimage = concat(version, hashPrevouts, hashSequence, rev(u.txid), u32(u.vout),
      scriptCode, u64(u.value), sequence, hashOutputs, locktime, u32(1));
    const sig = concat(secp256k1.sign(sha256d(preimage), priv).toDERRawBytes(), new Uint8Array([1]));
    return concat(varint(2), varstr(sig), varstr(pub));
  });

  const tx = concat(
    version, new Uint8Array([0x00, 0x01]),                       // segwit marker + flag
    varint(ins.length), ...ins.map((u) => concat(rev(u.txid), u32(u.vout), varint(0), sequence)),
    varint(outs.length), outBytes,
    ...witnesses, locktime);

  const r = await fetch(`${API}/tx`, { method: "POST", body: toHex(tx) });
  const body = await r.text();
  if (!r.ok) throw new Error(`broadcast refused: ${body}`);
  return body.trim();   // the txid
}

// --- commands ---------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "address") {
    console.log(ME);
  } else if (cmd === "balance") {
    const a = await get(`/address/${rest[0] ?? ME}`);
    console.log(a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum);
  } else if (cmd === "send") {
    console.log(await send(rest[0], Number(rest[1])));
  } else if (cmd === "sign") {
    console.log(signMessageBip322P2wpkh(rest.join(" "), priv));
  } else if (cmd === "wait") {
    for (let i = 0; i < 90; i++) {
      const s = await get(`/tx/${rest[0]}/status`);
      if (s.confirmed) { console.log(`confirmed in block ${s.block_height}`); process.exit(0); }
      await new Promise((f) => setTimeout(f, 20000));
    }
    console.error("not confirmed after 30 minutes"); process.exit(1);
  } else {
    console.error("address | balance [addr] | send <to> <sats> | sign <message> | wait <txid>");
    process.exit(1);
  }
} catch (err) {
  console.error(err.message); process.exit(1);
}
