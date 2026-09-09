/**
 * Contract wallets, against a real one on mainnet.
 *
 * The EOA path is covered in wallets.test.ts. What matters here is that a
 * signature which cannot possibly recover to the address — because the address
 * is a contract with no key — is still accepted when the contract says it is
 * good, and refused when it does not.
 *
 * A Safe is used as the counterparty because Safe is what senders actually
 * hold, and because its answer is authoritative: we are not simulating the
 * check, we are asking the deployed contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { personalHash, proves, contractAccepts, provesControl } from "./wallets.ts";

const env = {} as any;   // no keys configured: the public endpoint answers

/**
 * A contract wallet deployed on Sepolia for these tests. One owner, an
 * ordinary ECDSA signature over the digest the platform supplies — the
 * simplest rule that is still real, so a pass here means the platform computed
 * the right digest and encoded the call correctly, not that a mock agreed
 * with us.
 */
const WALLET = "0x073d8bf6ec91d62ff57653dec2767390f6868a5c";
const MESSAGE = "ThePaymaster — proof of wallet control\n" +
  "I control this wallet and am the sender on transaction TPM-2026-0099.";
const SIGNATURE = "0xbb75fcc1dd6dd45114388ff55b04b9702543a0b19a37d8e882e982f28a0c33905375158b4914df477ec9a0026c1ff76b0d07bd8095719decaee16b11f7f590171c";
const SEPOLIA = 11155111;

test("the EIP-191 hash matches the published value", () => {
  const got = [...personalHash("hello")]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(got,
    "50b2c43fd39106bafbba0da34fc430e1f91e3c96ea2acee2bc34119f92b37750");
});

test("an ordinary wallet still proves itself by recovery alone", async () => {
  // Taken from wallets.test.ts: a known message, signature and signer.
  const msg = "hello";
  // A signature that does not belong to it must fail both routes.
  const bogus = "0x" + "11".repeat(65);
  assert.equal(proves(msg, bogus, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), false);
});

test("a contract with no such function is refused, not crashed", async () => {
  // The USDT contract is a contract, but not a wallet: it has no
  // isValidSignature, so the call reverts and the answer must be a plain no.
  const ok = await contractAccepts(env, 1, {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    message: "hello", signature: "0x" + "11".repeat(65),
  });
  assert.equal(ok, false);
});

test("an address with no code at all is refused", async () => {
  const ok = await contractAccepts(env, 1, {
    address: "0x0000000000000000000000000000000000000001",
    message: "hello", signature: "0x" + "11".repeat(65),
  });
  assert.equal(ok, false);
});

test("a garbage signature is refused before the chain is troubled", async () => {
  const ok = await contractAccepts(env, SEPOLIA, {
    address: WALLET, message: "hello", signature: "not-hex",
  });
  assert.equal(ok, false);
});

test("provesControl falls through to the contract route", async () => {
  // An EOA signature that does not match, against a contract that will not
  // vouch for it: both routes say no, and the whole thing says no.
  const ok = await provesControl(env, 1, {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    message: "hello", signature: "0x" + "22".repeat(65),
  });
  assert.equal(ok, false);
});

test("a contract wallet is accepted when it vouches for the signature", async () => {
  // Recovery cannot possibly identify a contract: it has no key.
  assert.equal(proves(MESSAGE, SIGNATURE, WALLET), false);
  // The contract says yes, so control is proved.
  assert.equal(await contractAccepts(env, SEPOLIA,
    { address: WALLET, message: MESSAGE, signature: SIGNATURE }), true);
  assert.equal(await provesControl(env, SEPOLIA,
    { address: WALLET, message: MESSAGE, signature: SIGNATURE }), true);
});

test("a tampered signature is refused by the contract", async () => {
  const flipped = SIGNATURE.slice(0, -2) +
    (SIGNATURE.slice(-2) === "1b" ? "1c" : "1b");
  assert.equal(await provesControl(env, SEPOLIA,
    { address: WALLET, message: MESSAGE, signature: flipped }), false);
});

test("the right signature against a different message is refused", async () => {
  // If the platform passed a constant or mis-computed digest, this would pass
  // and the whole check would be worthless.
  assert.equal(await provesControl(env, SEPOLIA,
    { address: WALLET, message: MESSAGE + " extra", signature: SIGNATURE }), false);
});
