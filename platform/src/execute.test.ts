/**
 * The payload handed to the sender's wallet.
 *
 * If this is wrong the money goes to the wrong place, so it is checked against
 * hand-worked values rather than against itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { transferData, gasNeeded } from "./execute.ts";

const TO = "0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e";

test("transfer(address,uint256) is encoded exactly", () => {
  const d = transferData(TO, 1_000_000);
  assert.equal(d.slice(0, 10), "0xa9059cbb");            // the selector
  assert.equal((d.length - 2) / 2, 68);                  // 4 + 32 + 32
  assert.equal(d.slice(10, 34), "0".repeat(24));         // address left-padded
  assert.equal("0x" + d.slice(34, 74), TO.toLowerCase());
  assert.equal(BigInt("0x" + d.slice(74)), 1_000_000n);
});

test("350 million USDT survives the encoding", () => {
  // 3.5e14 minor units is past what a double holds exactly, so this must go
  // through BigInt the whole way.
  const amount = 350_000_000n * 1_000_000n;
  const d = transferData(TO, amount);
  assert.equal(BigInt("0x" + d.slice(74)), amount);
  assert.equal(BigInt("0x" + d.slice(74)).toString(), "350000000000000");
});

test("the encoding does not care how the address was capitalised", () => {
  assert.equal(transferData(TO, 5), transferData(TO.toLowerCase(), 5));
});

test("a zero amount still encodes, so the caller must refuse it", () => {
  // plan() blocks these; the encoder should not silently invent a value.
  assert.equal(BigInt("0x" + transferData(TO, 0).slice(74)), 0n);
});

test("gas is budgeted per outstanding leg, never zero", () => {
  assert.equal(gasNeeded(0), gasNeeded(1));
  assert.equal(gasNeeded(10), gasNeeded(1) * 10n);
});
