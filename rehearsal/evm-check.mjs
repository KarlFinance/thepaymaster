// Does the platform's hand-rolled EIP-1559 signing agree with @ethereumjs/tx, byte for byte?
import { FeeMarketEIP1559Transaction } from "@ethereumjs/tx";
import { Common, Hardfork } from "@ethereumjs/common";
import { signTx, unsignedTx, rlp, beBytes, abiAddress, abiUint, abiString, selector, addressOf, hex } from "../platform/src/evm.ts";

const priv = Uint8Array.from(Buffer.from("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "hex"));
const cases = [
  { chainId: 8453, nonce: 0, maxPriorityFeePerGas: 1000000n, maxFeePerGas: 20000000n, gasLimit: 120000n, to: "0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e", value: 0n, data: new Uint8Array([0x12, 0x34]) },
  { chainId: 84532, nonce: 7, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 21000n, to: "0x0000000000000000000000000000000000000001", value: 1n, data: new Uint8Array(0) },
  { chainId: 1, nonce: 255, maxPriorityFeePerGas: 1500000000n, maxFeePerGas: 30000000000n, gasLimit: 500000n, to: null, value: 0n, data: Uint8Array.from(Buffer.from("6080604052", "hex")) },
];
let bad = 0;
for (const c of cases) {
  const common = Common.custom({ chainId: c.chainId }, { hardfork: Hardfork.Cancun });
  const ref = FeeMarketEIP1559Transaction.fromTxData({
    chainId: BigInt(c.chainId), nonce: BigInt(c.nonce), maxPriorityFeePerGas: c.maxPriorityFeePerGas, maxFeePerGas: c.maxFeePerGas,
    gasLimit: c.gasLimit, to: c.to ?? undefined, value: c.value, data: c.data,
  }, { common }).sign(priv);
  const ours = signTx(c, priv);
  const same = Buffer.from(ours.raw).equals(Buffer.from(ref.serialize()));
  const sameHash = ours.hash === "0x" + Buffer.from(ref.hash()).toString("hex");
  console.log(`  ${same && sameHash ? "ok  " : "FAIL"} chain ${c.chainId} nonce ${c.nonce}${c.to ? "" : " (create)"} — raw ${same}, hash ${sameHash}`);
  if (!(same && sameHash)) bad++;
}
console.log(`  ${addressOf(priv) === "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" ? "ok  " : "FAIL"} address of the well-known key`);
console.log(`  ${hex(rlp([beBytes(1), beBytes(0), new Uint8Array(0)])) === "0xc3018080" ? "ok  " : "FAIL"} rlp of [1, 0, ""]`);
console.log(`  ${hex(selector("mint(address,uint256)")) === "0x40c10f19" ? "ok  " : "FAIL"} selector mint(address,uint256)`);
console.log(`  ${hex(abiString("ab")).length === 2 + 64 * 3 ? "ok  " : "FAIL"} abiString is three words`);
console.log(bad ? `\n${bad} FAILED` : "\nall agree");
process.exit(bad ? 1 : 0);
