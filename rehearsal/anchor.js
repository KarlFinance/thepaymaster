/**
 * Publish a dossier root on Sepolia.
 *
 * Rehearsal of the real thing: a zero-value transaction to oneself whose only
 * payload is the root. No contract, nothing spent but gas. On mainnet a person
 * does this from their own wallet — this script exists so the platform's
 * verification can be tested against a transaction that genuinely exists.
 *
 *   ROOT=<64 hex> node anchor.js
 */
import { FeeMarketEIP1559Transaction } from "@ethereumjs/tx";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const root = (process.env.ROOT ?? "").toLowerCase().replace(/^0x/, "");
if (!/^[0-9a-f]{64}$/.test(root)) { console.error("ROOT must be 64 hex chars"); process.exit(1); }

// The file is KEY=value lines, as the deploy script writes it.
const key = (readFileSync(".rehearsal-key", "utf8")
  .match(/^SEPOLIA_KEY=(?:0x)?([0-9a-fA-F]{64})$/m) ?? [])[1];
if (!key) { console.error("No SEPOLIA_KEY in .rehearsal-key"); process.exit(1); }
const priv = Uint8Array.from(key.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const ME = "0x" + hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20));

const TAG = hex(new TextEncoder().encode("TPM-DOSSIER-1:"));
const data = "0x" + TAG + root;

let n = 0;
const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
  const b = await r.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
};

const block = await rpc("eth_getBlockByNumber", ["latest", false]);
const base = BigInt(block.baseFeePerGas ?? "0x3b9aca00");
const tx = FeeMarketEIP1559Transaction.fromTxData({
  chainId: 11155111n,
  nonce: BigInt(await rpc("eth_getTransactionCount", [ME, "pending"])),
  maxPriorityFeePerGas: 2_000_000_000n,
  maxFeePerGas: base * 2n + 2_000_000_000n,
  gasLimit: 40_000n,
  to: ME,                       // itself: the recipient is irrelevant
  value: 0n,
  data,
}, { common: new Common({ chain: Chain.Sepolia, hardfork: Hardfork.Cancun }) }).sign(priv);

const hash = await rpc("eth_sendRawTransaction", ["0x" + hex(tx.serialize())]);
console.log(`  from    ${ME}`);
console.log(`  data    ${data}`);
console.log(`  hash    ${hash}`);
for (let i = 0; i < 60; i++) {
  const r = await rpc("eth_getTransactionReceipt", [hash]);
  if (r) {
    console.log(`  block   ${Number(BigInt(r.blockNumber))}  status ${BigInt(r.status) === 1n ? "ok" : "FAILED"}`);
    console.log(`  gas     ${Number(BigInt(r.gasUsed))}`);
    console.log(`\n  ${hash}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error("  never confirmed");
