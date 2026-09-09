// Sign an EIP-191 personal_sign message with a throwaway key.
//
// Stands in for a recipient opening MetaMask and pressing Sign. The keys are
// generated here and thrown away; they hold nothing and never will.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function keyFor(seed) {
  // Deterministic from a label, so a rerun uses the same addresses.
  return keccak_256(new TextEncoder().encode("thepaymaster-rehearsal:" + seed));
}

export function addressOf(priv) {
  return "0x" + hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20));
}

export function sign(priv, message) {
  const bytes = new TextEncoder().encode(message);
  const prefixed = new TextEncoder().encode("\x19Ethereum Signed Message:\n" + bytes.length);
  const digest = keccak_256(new Uint8Array([...prefixed, ...bytes]));
  const sig = secp256k1.sign(digest, priv, { prehash: false });
  return "0x" + hex(sig.toCompactRawBytes()) + (27 + sig.recovery).toString(16).padStart(2, "0");
}

// The sender is the throwaway Sepolia account, because it must actually pay
// gas. Recipients only sign, so theirs are generated from a label.
function realKey() {
  const { readFileSync } = require("node:fs");
  const text = readFileSync(new URL("../../rehearsal/.rehearsal-key", import.meta.url), "utf8");
  const k = (text.match(/^SEPOLIA_KEY=(?:0x)?([0-9a-fA-F]{64})$/m) ?? [])[1];
  if (!k) throw new Error("no SEPOLIA_KEY");
  return Uint8Array.from(k.match(/../g).map((b) => parseInt(b, 16)));
}

function keyOrSeed(seed) {
  return seed === "@sender" ? realKey() : keyFor(seed);
}

if (process.argv[2] === "address") {
  console.log(addressOf(keyOrSeed(process.argv[3])));
} else if (process.argv[2] === "sign") {
  const message = await new Response(process.stdin).text();
  console.log(sign(keyOrSeed(process.argv[3]), message));
}
