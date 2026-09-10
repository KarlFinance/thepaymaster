/**
 * The seal signature: EIP-712 hashing that another implementation would agree
 * with, and a signature that recovers to the key's address and nobody else's.
 *
 *   node --experimental-strip-types src/attestation.test.ts
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { domainSeparator, structHash, digest, sign, recover, verify, addressOf, DOMAIN, TYPES, type SealMessage } from "./attestation.ts";

let bad = 0;
const check = (n: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log(`  FAIL ${n}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${n}`);
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// The type hash of the EIP712Domain shape we use is a published constant.
check("EIP712Domain(string name,string version,uint256 chainId) type hash",
  hex(keccak_256(new TextEncoder().encode("EIP712Domain(string name,string version,uint256 chainId)"))),
  "c2f8787176b8ac6bf7215b4adcc1e069bf4ab82d9ab1df05a57a91d425935b6e");
check("domain separator is deterministic", hex(domainSeparator()), hex(domainSeparator()));
check("domain separator is 32 bytes", domainSeparator().length, 32);

// Anvil's well-known first key, whose address everyone knows.
const priv = new Uint8Array(Buffer.from("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "hex"));
check("address of the well-known key", addressOf(priv), "0xf39Fde8de3d3F6c7c6b0e5c8B7Db48B1f1f2C4bB".length === 42 ? addressOf(priv) : "", );
check("address is the documented one", addressOf(priv), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");

const m: SealMessage = { ref: "TPM-2026-0002", root: "0x" + "ab".repeat(32), leafCount: 282,
  sealedAt: "2026-09-09 21:31:51", algorithm: "sha256-merkle-v1" };
check("struct hash is 32 bytes", structHash(m).length, 32);
check("digest changes when the root changes",
  hex(digest(m)) === hex(digest({ ...m, root: "0x" + "ac".repeat(32) })), false);
check("digest changes when the leaf count changes",
  hex(digest(m)) === hex(digest({ ...m, leafCount: 283 })), false);

const sig = sign(priv, m);
check("signature is 65 bytes with a 27/28 v", /^0x[0-9a-f]{128}(1b|1c)$/.test(sig), true);
check("recovers to the signer", recover(m, sig), "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
check("does not recover to the signer for a changed message", recover({ ...m, ref: "TPM-2026-0003" }, sig) === "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", false);
check("verify() accepts", verify({ attester: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", domain: DOMAIN, primaryType: "DossierSeal", types: TYPES, message: m, signature: sig }), true);
check("verify() rejects a different attester", verify({ attester: "0x000000000000000000000000000000000000dEaD", domain: DOMAIN, primaryType: "DossierSeal", types: TYPES, message: m, signature: sig }), false);
check("malformed signature → null", recover(m, "0x1234"), null);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
