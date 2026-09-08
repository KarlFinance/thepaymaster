/**
 * Put the rehearsal contracts on Sepolia and mint the money.
 *
 *   SEPOLIA_KEY=0x… node deploy.js
 *
 * The key stays in your shell. It is read from the environment, used to sign
 * locally, and never sent anywhere — the only thing that leaves this machine
 * is a signed transaction. Do not paste it into a chat, a file in this repo,
 * or anything that keeps history.
 *
 * Everything here is worthless test money on a throwaway account. That is the
 * point: make the mistakes now, where they cost nothing.
 */
import { FeeMarketEIP1559Transaction } from "@ethereumjs/tx";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_ID = 11155111;
const EXPLORER = "https://sepolia.etherscan.io";

const key = (process.env.SEPOLIA_KEY ?? "").replace(/^0x/, "");
if (!/^[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Set SEPOLIA_KEY to the private key of the funded test account.");
  console.error("In MetaMask: account menu → Account details → Show private key.");
  process.exit(1);
}
const priv = Uint8Array.from(key.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const ME = "0x" + hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20));

const common = new Common({ chain: Chain.Sepolia, hardfork: Hardfork.Cancun });

let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function send(label, { to, data, gas }) {
  const nonce = BigInt(await rpc("eth_getTransactionCount", [ME, "pending"]));
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas ?? "0x3b9aca00");
  const tip = 2_000_000_000n;                    // 2 gwei, ample on a testnet

  const tx = FeeMarketEIP1559Transaction.fromTxData({
    chainId: BigInt(CHAIN_ID),
    nonce,
    maxPriorityFeePerGas: tip,
    // Doubling the base fee covers a rise between estimating and landing;
    // unspent gas is refunded, so being generous costs nothing.
    maxFeePerGas: base * 2n + tip,
    gasLimit: BigInt(gas),
    to,
    value: 0n,
    data,
  }, { common }).sign(priv);

  const hash = await rpc("eth_sendRawTransaction", ["0x" + hex(tx.serialize())]);
  process.stdout.write(`  ${label.padEnd(30)} ${hash.slice(0, 12)}…  `);

  // Wait for it, rather than assuming. A transaction can be accepted by a node
  // and still fail when it is executed.
  for (let i = 0; i < 90; i++) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      const ok = BigInt(receipt.status) === 1n;
      console.log(ok ? "ok" : "REVERTED");
      if (!ok) throw new Error(`${label} reverted — ${EXPLORER}/tx/${hash}`);
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} never confirmed — ${EXPLORER}/tx/${hash}`);
}

const sel = (sig) => "0x" + hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const word = (v) => (typeof v === "bigint" ? v.toString(16) : String(v).replace(/^0x/, ""))
  .padStart(64, "0");

// ---------------------------------------------------------------------------

const balance = BigInt(await rpc("eth_getBalance", [ME, "latest"]));
console.log(`\n  account   ${ME}`);
console.log(`  balance   ${(Number(balance) / 1e18).toFixed(4)} SepoliaETH\n`);
if (balance === 0n) {
  console.error("  No test ETH. Use a faucet first.");
  process.exit(1);
}

const usdtArt = JSON.parse(readFileSync("build/MockUSDT.json", "utf8"));
const disbArt = JSON.parse(readFileSync("build/Disburser.json", "utf8"));

const usdt = (await send("deploy mock USDT",
  { to: undefined, data: usdtArt.bytecode, gas: 1_200_000 })).contractAddress;
const disburser = (await send("deploy disburser",
  { to: undefined, data: disbArt.bytecode, gas: 600_000 })).contractAddress;

// 350,000,000 USDT at six decimals, to the account that will play the sender.
const amount = 350_000_000n * 1_000_000n;
await send("mint 350,000,000 USDT", {
  to: usdt,
  data: sel("mint(address,uint256)") + word(ME) + word(amount),
  gas: 100_000,
});

const held = BigInt(await rpc("eth_call",
  [{ to: usdt, data: sel("balanceOf(address)") + word(ME) }, "latest"]));

console.log(`\n  mock USDT   ${usdt}`);
console.log(`              ${EXPLORER}/address/${usdt}`);
console.log(`  disburser   ${disburser}`);
console.log(`              ${EXPLORER}/address/${disburser}`);
console.log(`  sender holds ${(Number(held) / 1e6).toLocaleString()} USDT\n`);
console.log(`  Put these on the transaction in the platform:`);
console.log(`    chain id       ${CHAIN_ID}`);
console.log(`    token address  ${usdt}\n`);
