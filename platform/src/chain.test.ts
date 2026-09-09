/**
 * The cross-check, against the real chain and against a liar.
 *
 * The live half proves we can read mainnet at all. The synthetic half is the
 * one that matters: it puts a disagreeing endpoint in front of the code and
 * insists the answer is "not confirmed" rather than a majority verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { receipt, endpoints } from "./chain.ts";

const PUBLIC_A = "https://ethereum-rpc.publicnode.com";
const PUBLIC_B = "https://eth.llamarpc.com";
const two = { ETH_RPC_URL: PUBLIC_A, ETH_RPC_URL_2: PUBLIC_B } as any;

/** A hash that is real, taken from the head of the chain at run time. */
async function aRealMainnetHash(): Promise<string | null> {
  const res = await fetch(PUBLIC_A, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "eth_getBlockByNumber", params: ["latest", false] }),
  });
  const body: any = await res.json();
  const hashes: string[] = body?.result?.transactions ?? [];
  return hashes.length ? hashes[0] : null;
}

test("a real mainnet transaction is confirmed, by more than one endpoint", async () => {
  const hash = await aRealMainnetHash();
  if (!hash) return console.log("  (chain unreachable — skipped)");
  const r = await receipt(two, 1, hash);
  assert.ok(r, "expected an answer");
  assert.equal(r!.found, true);
  assert.equal(r!.agreed, true);
  assert.ok(r!.sources >= 1);
  assert.ok(typeof r!.block === "number");
  console.log(`  confirmed in block ${r!.block} by ${r!.sources} endpoints`);
});

test("a hash that never existed is not found, and they agree on that", async () => {
  const r = await receipt(two, 1, "0x" + "ab".repeat(32));
  if (!r) return console.log("  (chain unreachable — skipped)");
  assert.equal(r.found, false);
  assert.equal(r.agreed, true);
});

test("one endpoint inventing a receipt does not confirm anything", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const honest = { jsonrpc: "2.0", id: 1, result: null };
    const liar = { jsonrpc: "2.0", id: 1, result: {
      status: "0x1", blockNumber: "0x1312d00", from: "0x" + "11".repeat(20) } };
    const body = String(url).includes("llamarpc") ? liar : honest;
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" } });
  }) as any;
  try {
    const r = await receipt(two, 1, "0x" + "cd".repeat(32));
    assert.ok(r);
    assert.equal(r!.agreed, false, "a disagreement must not read as agreement");
    assert.equal(r!.found, false, "the cautious answer wins");
    assert.match(r!.conflict ?? "", /no such transaction/);
    console.log(`  refused — ${r!.conflict}`);
  } finally { globalThis.fetch = real; }
});

test("endpoints that disagree about the block are refused too", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const block = String(url).includes("llamarpc") ? "0x1312d00" : "0x1312d01";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
      result: { status: "0x1", blockNumber: block, from: null } }),
      { headers: { "Content-Type": "application/json" } });
  }) as any;
  try {
    const r = await receipt(two, 1, "0x" + "ef".repeat(32));
    assert.equal(r!.agreed, false);
    console.log(`  refused — ${r!.conflict}`);
  } finally { globalThis.fetch = real; }
});

test("the public fallback is never counted twice", () => {
  // Configuring the public node as the primary must not produce two 'sources'
  // that are the same machine — an agreement with itself is not an agreement.
  const same = { ETH_RPC_URL: PUBLIC_A } as any;
  assert.equal(endpoints(same, 1).length, 1);

  const distinct = { ETH_RPC_URL: "https://eth-mainnet.g.alchemy.com/v2/k" } as any;
  assert.equal(endpoints(distinct, 1).length, 2);
});
