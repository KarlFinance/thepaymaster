/**
 * Nominis, and in particular what it must never do.
 *
 * The dangerous failure for a screening provider is not a wrong flag — that
 * gets looked at. It is a quiet clear: an address nobody has heard of, or a
 * provider that timed out, returning something that reads as approval. Every
 * test here is about that.
 *
 * The two labelled examples come from Nominis's own documentation, so the
 * mapping is checked against their meaning rather than mine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictFor, quickCheck, nominis } from "./walletscreen.ts";

test("their own example of a low-risk exchange clears", () => {
  const v = verdictFor({
    address: "0x05b7013adcc264ad73388563a1e98869aa4301ee",
    name: "Independent Reserve",
    classification: ["cex", "hot wallet"], risk_factors: [], quick_score: "low",
  });
  assert.equal(v.verdict, "clear");
  assert.match(v.findings ?? "", /Independent Reserve/);
});

test("their own example of a sanctioned exchange is refused, not merely flagged", () => {
  const v = verdictFor({
    address: "0x332f3d83b771d0611156eb04308e168e50fd9e30",
    name: "Bitpapa",
    classification: ["cex", "user wallet", "sanctioned", "high risk exchange"],
    risk_factors: [], quick_score: "critical",
  });
  assert.equal(v.verdict, "refused");
});

test("sanctioned overrides a low score", () => {
  // A fact about the address, not a judgement about it. If the two ever
  // disagree, the listing wins.
  const v = verdictFor({ address: "0x1", quick_score: "low",
                         classification: ["sanctioned"] });
  assert.equal(v.verdict, "refused");
});

test("medium, high and critical all stop short of clear", () => {
  for (const score of ["medium", "high", "critical"]) {
    assert.equal(verdictFor({ address: "0x1", quick_score: score }).verdict, "flagged");
  }
});

test("an address they have never heard of is not clear", () => {
  // The whole point. No attribution is an absence of evidence.
  assert.equal(verdictFor(undefined).verdict, "pending");
  assert.equal(verdictFor({ address: "0x1" }).verdict, "pending");
  assert.equal(verdictFor({ address: "0x1", quick_score: "" }).verdict, "pending");
});

test("with no key configured, nothing is claimed", async () => {
  const env = {} as any;
  assert.equal(nominis.active(env), false);
  const out = await quickCheck(env, ["0x1"]);
  assert.equal(out.labels.size, 0);
  assert.match(out.problem ?? "", /configured off/);
  const v = await nominis.check(env, "0x1", 1);
  assert.equal(v.verdict, "pending");
});

test("a chain they do not cover is said so, not silently cleared", async () => {
  // Sepolia. An address there has no history to attribute, and asking would
  // return nothing that could be mistaken for a clean answer.
  const env = { NOMINIS_API_KEY: "x_test" } as any;
  const v = await nominis.check(env, "0x1", 11155111);
  assert.equal(v.verdict, "pending");
  assert.match(v.findings ?? "", /does not cover chain 11155111/);
});

test("an unreachable provider is pending, never clear", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network down"); }) as any;
  try {
    const out = await quickCheck({ NOMINIS_API_KEY: "x" } as any, ["0x1"]);
    assert.equal(out.labels.size, 0);
    assert.match(out.problem ?? "", /network down/);
  } finally { globalThis.fetch = real; }
});

test("a refusal from their API is reported, not treated as an answer", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ status: "fail", error: "quota exceeded", data: [] }),
    { headers: { "Content-Type": "application/json" } })) as any;
  try {
    const out = await quickCheck({ NOMINIS_API_KEY: "x" } as any, ["0x1"]);
    assert.equal(out.labels.size, 0);
    assert.match(out.problem ?? "", /quota exceeded/);
  } finally { globalThis.fetch = real; }
});

test("fifty addresses go in one call, and duplicates collapse", async () => {
  const real = globalThis.fetch;
  let calls = 0, asked = "";
  globalThis.fetch = (async (url: any) => {
    calls++;
    asked = new URL(String(url)).searchParams.get("address") ?? "";
    return new Response(JSON.stringify({ status: "ok", data: [] }),
      { headers: { "Content-Type": "application/json" } });
  }) as any;
  try {
    const many = [...Array(60)].map((_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    await quickCheck({ NOMINIS_API_KEY: "x" } as any, [...many, many[0], many[1]]);
    assert.equal(calls, 1);
    assert.equal(asked.split(",").length, 50, "capped at their documented fifty");
  } finally { globalThis.fetch = real; }
});

test("the key is never put in an error message", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream exploded",
    { status: 500 })) as any;
  try {
    const out = await quickCheck({ NOMINIS_API_KEY: "x_super_secret" } as any, ["0x1"]);
    assert.ok(!(out.problem ?? "").includes("x_super_secret"),
      "the API key travels in the query string; it must not reach a log");
  } finally { globalThis.fetch = real; }
});
