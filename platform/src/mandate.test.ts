/**
 * The authority to act for a sender.
 *
 * What matters is that it cannot be signed by the wrong person, cannot be
 * signed twice, and says plainly what it does not permit — because the whole
 * value of the thing is what it rules out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { wording, resembles } from "./mandate.ts";

const text = wording({
  senderName: "Marina Vasquez", ref: "TPM-2026-0042", company: "ThePaymaster Ltd",
});

test("the wording names the signer and the transaction", () => {
  assert.match(text, /I am Marina Vasquez/);
  assert.match(text, /TPM-2026-0042/);
});

test("the wording rules out the things it must rule out", () => {
  // If any of these ever fall out of the text, a sender could be told they
  // signed something they did not.
  for (const limit of [
    /may not[\s\S]*move, hold or take custody/,
    /send any payment/,
    /prove control of any wallet/,
    /complete identity checks/,
  ]) assert.match(text, limit);
});

test("it says the sender can withdraw it", () => {
  assert.match(text, /withdraw this authority at any time/);
});

test("a name is matched on the surname, not on exact form", () => {
  assert.equal(resembles("Marina Vasquez", "Marina Vasquez"), true);
  assert.equal(resembles("M Vasquez", "Marina Vasquez"), true);
  assert.equal(resembles("  marina   VASQUEZ ", "Marina Vasquez"), true);
  assert.equal(resembles("Vasquez, Marina", "Marina Vasquez"), true);
  assert.equal(resembles("Marina Vasquez-Smith", "Marina Vasquez"), true);
});

test("somebody else's name is not a signature", () => {
  assert.equal(resembles("Someone Else", "Marina Vasquez"), false);
  assert.equal(resembles("Marina", "Marina Vasquez"), false);
  assert.equal(resembles("", "Marina Vasquez"), false);
  assert.equal(resembles("x", "Marina Vasquez"), false);
  assert.equal(resembles("Marina Vasquez", ""), false);
});

test("initials alone are not enough", () => {
  // "M V" would otherwise pass on a one-letter token; short words are dropped.
  assert.equal(resembles("M V", "Marina Vasquez"), false);
});
