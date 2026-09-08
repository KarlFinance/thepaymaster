/**
 * The distribution itself, on Sepolia, at the real size.
 *
 * The amounts are not typed in here — they come from the platform's own fee
 * engine, so what goes on chain is exactly what the transaction page would
 * show a client. If those two ever disagree, this is where it shows up.
 */
import { FeeMarketEIP1559Transaction } from "@ethereumjs/tx";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { settle, format } from "../platform/src/money.ts";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const EXPLORER = "https://sepolia.etherscan.io";
const USDT = process.env.USDT, DISB = process.env.DISBURSER;
const FEE_WALLET = "0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e";

const priv = Uint8Array.from(process.env.SEPOLIA_KEY.replace(/^0x/, "")
  .match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const ME = "0x" + hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20));
const common = new Common({ chain: Chain.Sepolia, hardfork: Hardfork.Cancun });

let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const b = await r.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}
const sel = (s) => "0x" + hex(keccak_256(new TextEncoder().encode(s)).slice(0, 4));
const word = (v) => (typeof v === "bigint" ? v.toString(16) : String(v).replace(/^0x/, ""))
  .padStart(64, "0");

async function send(label, to, data, gas) {
  const nonce = BigInt(await rpc("eth_getTransactionCount", [ME, "pending"]));
  const base = BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).baseFeePerGas);
  const tx = FeeMarketEIP1559Transaction.fromTxData({
    chainId: 11155111n, nonce, maxPriorityFeePerGas: 2_000_000_000n,
    maxFeePerGas: base * 2n + 2_000_000_000n, gasLimit: BigInt(gas), to, value: 0n, data,
  }, { common }).sign(priv);
  const hash = await rpc("eth_sendRawTransaction", ["0x" + hex(tx.serialize())]);
  process.stdout.write(`  ${label.padEnd(34)}`);
  for (let i = 0; i < 90; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) {
      const ok = BigInt(r.status) === 1n;
      console.log(`${ok ? "ok" : "REVERTED"}  gas ${Number(BigInt(r.gasUsed)).toLocaleString()}`);
      if (!ok) throw new Error(`${label} reverted — ${EXPLORER}/tx/${hash}`);
      return { hash, receipt: r };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("never confirmed");
}
const balOf = async (a) => BigInt(await rpc("eth_call",
  [{ to: USDT, data: sel("balanceOf(address)") + word(a) }, "latest"]));

// --- the split, worked out by the platform ---------------------------------
const RECIPIENTS = [
  { id: "alpha", address: "0x1111111111111111111111111111111111111111", shareBps: 6000 },
  { id: "bravo", address: "0x2222222222222222222222222222222222222222", shareBps: 2500 },
  { id: "charlie", address: "0x3333333333333333333333333333333333333333", shareBps: 1500 },
];
const gross = 350_000_000 * 1_000_000;
const plan = settle("deducted", 100, RECIPIENTS, { grossMinor: gross, remainderTo: "alpha" });

console.log(`\n  sender      ${ME}`);
console.log(`  holds       ${format(Number(await balOf(ME)), 6)} USDT\n`);
console.log(`  the platform's figures:`);
console.log(`    gross     ${format(plan.grossMinor, 6)}`);
console.log(`    our fee   ${format(plan.feeMinor, 6)}  ->  ${FEE_WALLET}`);
for (const r of RECIPIENTS) {
  console.log(`    ${r.id.padEnd(9)} ${format(plan.amounts[r.id], 6)}  ->  ${r.address}`);
}
const check = Object.values(plan.amounts).reduce((a, b) => a + b, 0) + plan.feeMinor;
console.log(`    reconciles ${check === plan.grossMinor ? "yes" : "NO"}\n`);

// --- approve, minding USDT's refusal to raise a live allowance -------------
const allowance = BigInt(await rpc("eth_call", [{ to: USDT,
  data: sel("allowance(address,address)") + word(ME) + word(DISB) }, "latest"]));
if (allowance !== 0n) {
  await send("zero the allowance first", USDT,
    sel("approve(address,uint256)") + word(DISB) + word(0n), 80_000);
}
await send("approve the exact amount", USDT,
  sel("approve(address,uint256)") + word(DISB) + word(BigInt(plan.grossMinor)), 80_000);

// --- one transaction, four legs, all or nothing ----------------------------
const to = [...RECIPIENTS.map((r) => r.address), FEE_WALLET];
const amounts = [...RECIPIENTS.map((r) => BigInt(plan.amounts[r.id])), BigInt(plan.feeMinor)];
const n = BigInt(to.length);
const data = sel("disburse(bytes32,address,address[],uint256[])")
  + word("0x" + hex(keccak_256(new TextEncoder().encode("TPM-2026-REHEARSAL"))))
  + word(USDT) + word(0x80n) + word(0x80n + 32n + n * 32n)
  + word(n) + to.map((a) => word(a)).join("")
  + word(n) + amounts.map((a) => word(a)).join("");

const { hash } = await send(`disburse to ${to.length} addresses`, DISB, data, 400_000);

console.log(`\n  ${EXPLORER}/tx/${hash}\n`);
console.log("  where it all ended up:");
for (const r of RECIPIENTS) {
  const got = await balOf(r.address);
  console.log(`    ${r.id.padEnd(9)} ${format(Number(got), 6).padStart(18)}` +
    `   ${Number(got) === plan.amounts[r.id] ? "exact" : "WRONG"}`);
}
const feeGot = await balOf(FEE_WALLET);
console.log(`    our fee   ${format(Number(feeGot), 6).padStart(18)}` +
  `   ${Number(feeGot) === plan.feeMinor ? "exact" : "WRONG"}`);
console.log(`    sender    ${format(Number(await balOf(ME)), 6).padStart(18)}`);
console.log(`    disburser ${format(Number(await balOf(DISB)), 6).padStart(18)}   ` +
  `${(await balOf(DISB)) === 0n ? "nothing stuck" : "SOMETHING IS STUCK"}`);
