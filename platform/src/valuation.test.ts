import { test } from "node:test";
import assert from "node:assert/strict";
import { gbpValue } from "./valuation.ts";

const env: any = {};

test("USDT counts in millionths; 25,000,000 USDT is £25,000,000 pound for pound", async () => {
  const v = await gbpValue(env, "USDT", 25_000_000_000_000, 6);
  assert.equal(v!.minor, 2_500_000_000);          // £25,000,000.00 in pence
});

test("GBP is GBP, and a £30m approval covers a 25m USDT transaction", async () => {
  const gbp = await gbpValue(env, "GBP", 3_000_000_000, 2);
  const usdt = await gbpValue(env, "USDT", 25_000_000_000_000, 6);
  assert.equal(gbp!.minor, 3_000_000_000);
  assert.ok(usdt!.minor <= 3_000_000_000);
});

test("an unknown asset cannot be valued and says so", async () => {
  assert.equal(await gbpValue(env, "XYZ", 1, 0), null);
});
