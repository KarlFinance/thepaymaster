import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { toChecksum, addressProblem, recover, proves, challenge } from "./wallets.ts";

let bad = 0;
const check = (n: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++; console.log(`  FAIL ${n}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${n}`);
};

// --- EIP-55, against the addresses published in the EIP itself -------------
check("checksum 0x5aAeb6...", toChecksum("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"),
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
check("checksum 0xfB6916...", toChecksum("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359"),
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
check("checksum 0xdbF03B...", toChecksum("0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb"),
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB");

check("all-lowercase accepted (no checksum to fail)",
  addressProblem("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), null);
check("correct mixed case accepted",
  addressProblem("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), null);
check("altered mixed case refused",
  (addressProblem("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD") ?? "").includes("checksum"), true);
check("too short refused",
  (addressProblem("0x5aAeb6") ?? "").includes("forty hex"), true);

// --- signing and recovery, with a key we generate here ----------------------
const key = secp256k1.utils.randomPrivateKey();
const pub = secp256k1.getPublicKey(key, false).slice(1);
const address = toChecksum("0x" + [...keccak_256(pub).slice(-20)]
  .map((b) => b.toString(16).padStart(2, "0")).join(""));

function sign(message: string): string {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0); joined.set(body, prefix.length);
  const sig = secp256k1.sign(keccak_256(joined), key);
  const bytes = new Uint8Array(65);
  bytes.set(sig.toCompactRawBytes(), 0);
  bytes[64] = sig.recovery + 27;                    // as a wallet emits it
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const msg = challenge({ ref: "TPM-2026-0042", address, role: "sender", nonce: "abc123" });
const signature = sign(msg);

check("recovers the signer", recover(msg, signature), address);
check("proves control", proves(msg, signature, address), true);
check("case in the address does not matter",
  proves(msg, signature, address.toLowerCase()), true);

// --- the attacks it has to refuse ------------------------------------------
check("a different message is not proved",
  proves(msg + " ", signature, address), false);
check("a signature over another challenge does not transfer",
  proves(challenge({ ref: "TPM-2026-0043", address, role: "sender", nonce: "abc123" }),
    signature, address), false);
check("a different nonce does not transfer",
  proves(challenge({ ref: "TPM-2026-0042", address, role: "sender", nonce: "zzz999" }),
    signature, address), false);
check("somebody else's address is not proved",
  proves(msg, signature, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), false);
check("a tampered signature is refused",
  proves(msg, signature.slice(0, -2) + (signature.slice(-2) === "1b" ? "1c" : "1b"), address), false);
check("rubbish is refused", proves(msg, "0xdeadbeef", address), false);
check("empty is refused", proves(msg, "", address), false);

// A wallet that emits v as 0 or 1 rather than 27 or 28 must still work.
const lowV = signature.slice(0, -2) +
  (signature.slice(-2) === "1b" ? "00" : "01");
check("v of 0 or 1 is handled", proves(msg, lowV, address), true);

// The message must name the transaction, or a proof for one deal would be a
// proof for every deal that party is on.
check("the challenge names the transaction", msg.includes("TPM-2026-0042"), true);
check("the challenge names the wallet", msg.includes(address), true);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");

// ---------------------------------------------------------------------------
// A proof belongs to the address it was made for
// ---------------------------------------------------------------------------

check("a signature for one address does not prove another",
  proves(challenge({ ref: "TPM-2026-0002", address,
                     role: "recipient", nonce: "abc123" }),
         signature, "0x4eD60b74A1Bd407e1E7004F469a00286E65E452E"),
  false);
