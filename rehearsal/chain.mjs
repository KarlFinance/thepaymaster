/**
 * The chain side of the rehearsal: deploy the mock token, fund the sender,
 * and make the transfers a sender would make from their own wallet.
 *
 * The key is a throwaway on a test network, read from .rehearsal-key and never
 * printed. It stands in for the sender's MetaMask — in production nothing here
 * exists, because the sender signs in their own browser and this software
 * never holds a key at all.
 *
 *   node chain.mjs deploy                       → token address
 *   node chain.mjs mint <token> <to> <minor>
 *   node chain.mjs transfer <token> <to> <minor> → transaction hash
 *   node chain.mjs address
 */
import { FeeMarketEIP1559Transaction } from "@ethereumjs/tx";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const key = (readFileSync(new URL(".rehearsal-key", import.meta.url), "utf8")
  .match(/^SEPOLIA_KEY=(?:0x)?([0-9a-fA-F]{64})$/m) ?? [])[1];
if (!key) { console.error("no SEPOLIA_KEY in .rehearsal-key"); process.exit(1); }

const priv = Uint8Array.from(key.match(/../g).map((b) => parseInt(b, 16)));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const ME = "0x" + hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20));
const common = new Common({ chain: Chain.Sepolia, hardfork: Hardfork.Cancun });

let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function send({ to, data, gas }) {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas ?? "0x3b9aca00");
  const tx = FeeMarketEIP1559Transaction.fromTxData({
    chainId: 11155111n,
    nonce: BigInt(await rpc("eth_getTransactionCount", [ME, "pending"])),
    maxPriorityFeePerGas: 1_500_000_000n,
    maxFeePerGas: base * 2n + 1_500_000_000n,
    gasLimit: BigInt(gas), to, value: 0n, data,
  }, { common }).sign(priv);

  const hash = await rpc("eth_sendRawTransaction", ["0x" + hex(tx.serialize())]);
  for (let i = 0; i < 90; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) {
      if (BigInt(r.status) !== 1n) throw new Error(`reverted: ${hash}`);
      return { hash, receipt: r };
    }
    await new Promise((f) => setTimeout(f, 2000));
  }
  throw new Error(`never confirmed: ${hash}`);
}

const sel = (sig) => "0x" + hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const word = (v) => (typeof v === "bigint" ? v.toString(16)
  : String(v).replace(/^0x/, "")).padStart(64, "0");

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "address") {
  console.log(ME);

} else if (cmd === "deploy") {
  const art = JSON.parse(readFileSync(new URL("build/MockUSDT.json", import.meta.url), "utf8"));
  const { receipt } = await send({ to: undefined, data: art.bytecode, gas: 1_200_000 });
  console.log(receipt.contractAddress);

} else if (cmd === "deploy1271") {
  // A contract wallet whose only owner is this throwaway account.
  const art = JSON.parse(readFileSync(new URL("build/Signer1271.json", import.meta.url), "utf8"));
  const { receipt } = await send({ to: undefined, gas: 500_000,
    data: art.bytecode + word(rest[0] ?? ME) });
  console.log(receipt.contractAddress);

} else if (cmd === "fund") {
  // A little native currency, so a fresh account can pay for gas.
  const [to, eth] = rest;
  const wei = BigInt(Math.round(Number(eth) * 1e18));
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const base = BigInt(block.baseFeePerGas ?? "0x3b9aca00");
  const tx = FeeMarketEIP1559Transaction.fromTxData({
    chainId: 11155111n,
    nonce: BigInt(await rpc("eth_getTransactionCount", [ME, "pending"])),
    maxPriorityFeePerGas: 1_500_000_000n,
    maxFeePerGas: base * 2n + 1_500_000_000n,
    gasLimit: 21_000n, to, value: wei, data: "0x",
  }, { common }).sign(priv);
  const hash = await rpc("eth_sendRawTransaction", ["0x" + hex(tx.serialize())]);
  for (let i = 0; i < 60; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) { console.log(hash); process.exit(0); }
    await new Promise((f) => setTimeout(f, 2000));
  }
  console.error("not confirmed"); process.exit(1);

} else if (cmd === "mint") {
  const [token, to, minor] = rest;
  const { hash } = await send({ to: token, gas: 120_000,
    data: sel("mint(address,uint256)") + word(to) + word(BigInt(minor)) });
  console.log(hash);

} else if (cmd === "transfer") {
  const [token, to, minor] = rest;
  // The same call the platform composes for the sender's wallet.
  const { hash } = await send({ to: token, gas: 120_000,
    data: sel("transfer(address,uint256)") + word(to) + word(BigInt(minor)) });
  console.log(hash);

} else if (cmd === "balance") {
  const [token, who] = rest;
  const r = await rpc("eth_call", [{ to: token,
    data: sel("balanceOf(address)") + word(who ?? ME) }, "latest"]);
  console.log(BigInt(r).toString());

} else {
  console.error("deploy | mint | transfer | balance | address");
  process.exit(1);
}
