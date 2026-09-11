import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { decodeAddress, encodeAddress, addressHex20, addressFromHex, addressProblem,
         signMessage, recover, proves, addressOfPublicKey, TRON_PREFIX } from "./tron.ts";

// USDT's TRC-20 contract, the best-known Tron address there is.
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

test("a real address decodes, re-encodes, and round-trips through hex", () => {
  const d = decodeAddress(USDT);
  assert.ok(!("why" in d));
  const payload = new Uint8Array(21); payload[0] = TRON_PREFIX; payload.set((d as any).bytes20, 1);
  assert.equal(encodeAddress(payload), USDT);
  const h = addressHex20(USDT)!;
  assert.equal(h.length, 40);
  assert.equal(addressFromHex(h), USDT);
  assert.equal(addressFromHex("41" + h), USDT);
});

test("a wrong character is caught by the checksum", () => {
  assert.match(addressProblem("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")!, /wrong or missing/);
  assert.match(addressProblem("0xdAC17F958D2ee523a2206206994597C13D831ec7")!, /starts with T/);
  assert.equal(addressProblem(USDT), null);
});

test("a TIP-191 signature recovers to the signer's address, and nobody else's", () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const me = addressOfPublicKey(secp256k1.getPublicKey(priv, false));
  assert.match(me, /^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  const msg = "ThePaymaster — proof of wallet control\n\nNonce: abc";
  const sig = signMessage(msg, priv);
  assert.equal(recover(msg, sig), me);
  assert.ok(proves(msg, sig, me));
  assert.ok(!proves(msg + " ", sig, me));
  assert.ok(!proves(msg, sig, USDT));
  // TronLink may hand back v as 0/1 rather than 27/28.
  const bytes = sig.slice(2); const v = parseInt(bytes.slice(128), 16) - 27;
  assert.ok(proves(msg, "0x" + bytes.slice(0, 128) + v.toString(16).padStart(2, "0"), me));
});
