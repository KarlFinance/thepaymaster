/**
 * Bitcoin primitives against the BIPs' own vectors.
 *
 *   node --experimental-strip-types src/btc.test.ts
 *
 * The BIP-322 vectors are the ones published in the BIP for the key
 * L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k. If those pass, the
 * transaction serialisation, the sighash and the witness parsing are right,
 * because a single wrong byte anywhere changes the digest.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { parseAddress, scriptPubKey, addressFor, toHex, toSpendTxid, toSignTxid, txidDisplay,
         verifyMessageBip322, verifyMessageLegacy, verifyMessage, signMessageLegacy,
         signMessageBip322P2wpkh, signMessageBip322P2tr, wifDecode, base58CheckDecode,
         bech32Decode } from "./btc.ts";

let bad = 0;
const check = (n: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++; console.log(`  FAIL ${n}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  } else console.log(`  ok   ${n}`);
};
const addr = (s: string, net: "mainnet" | "signet" = "mainnet") => {
  const a = parseAddress(s, net);
  if ("why" in a) throw new Error(`${s}: ${a.why}`);
  return a;
};

// --- addresses ---------------------------------------------------------------
check("p2pkh mainnet", parseAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "mainnet").hasOwnProperty("type"), true);
check("p2sh mainnet", (parseAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "mainnet") as any).type, "p2sh");
check("p2wpkh (BIP-173 vector)", (parseAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "mainnet") as any).type, "p2wpkh");
check("p2wsh (BIP-173 vector)", (parseAddress("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", "mainnet") as any).type, "p2wsh");
check("p2tr (BIP-350 vector)", (parseAddress("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "mainnet") as any).type, "p2tr");
check("p2tr with bech32 (not m) refused", "why" in parseAddress("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "mainnet"), true);
check("bad checksum refused", "why" in parseAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "mainnet"), true);
check("testnet on mainnet refused", (parseAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "mainnet") as any).why.includes("test-network"), true);
check("signet tb1 accepted", (parseAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "signet") as any).type, "p2wpkh");
check("legacy testnet on mainnet refused", "why" in parseAddress("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "mainnet"), true);
check("ethereum address refused", "why" in parseAddress("0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e", "mainnet"), true);
check("scriptPubKey p2wpkh", toHex(scriptPubKey(addr("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"))),
  "0014751e76e8199196d454941c45d1b3a323f1433bd6");
check("scriptPubKey p2pkh", toHex(scriptPubKey(addr("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"))),
  "76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac");

// --- BIP-322 published vectors -----------------------------------------------
const wif = wifDecode("L3VFeEujGtevx9w18HD1fhRbCH67Az2dpCymeRE1SoPK6XQtaN2k")!;
const pub = secp256k1.getPublicKey(wif.priv, true);
check("key → bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l", addressFor(pub, "p2wpkh", "mainnet"),
  "bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l");
const A = addr("bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l");
const s = scriptPubKey(A);
check("to_spend txid, empty message",
  toHex(txidDisplay(toSpendTxid("", s))), "c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7");
check("to_spend txid, Hello World",
  toHex(txidDisplay(toSpendTxid("Hello World", s))), "b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b");
check("to_sign txid, empty message",
  toHex(txidDisplay(toSignTxid(toSpendTxid("", s)))), "1e9654e951a5ba44c8604c4de6c67fd78a27e81dcadcfe1edf638ba3aaebaed6");
check("to_sign txid, Hello World",
  toHex(txidDisplay(toSignTxid(toSpendTxid("Hello World", s)))), "88737ae86f2077145f93cc4b153ae9a1cb8d56afa511988c149c5c8c9d93bddf");

check("BIP-322 vector: empty message", verifyMessageBip322(A, "",
  "AkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI="), true);
check("BIP-322 vector: Hello World", verifyMessageBip322(A, "Hello World",
  "AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI="), true);
check("BIP-322 vector: Hello World, alternative signature", verifyMessageBip322(A, "Hello World",
  "AkgwRQIhAOzyynlqt93lOKJr+wmmxIens//zPzl9tqIOua93wO6MAiBi5n5EyAcPScOjf1lAqIUIQtr3zKNeavYabHyR8eGhowEhAsfxIAMZZEKUPYWI4BruhAQjzFT8FSFSajuFwrDL1Yhy"), true);
check("BIP-322 vector fails for a different message", verifyMessageBip322(A, "Hello World!",
  "AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI="), false);
check("BIP-322 vector fails for a different address", verifyMessageBip322(
  addr("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), "Hello World",
  "AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI="), false);

// Taproot: the same key's BIP-86 address, with the published signature.
check("key → bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3", addressFor(pub, "p2tr", "mainnet"),
  "bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3");
const T = addr("bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3");
check("BIP-322 taproot published vector", verifyMessageBip322(T, "Hello World",
  "AUHd69PrJQEv+oKTfZ8l+WROBHuy9HKrbFCJu7U1iK2iiEy1vMU5EfMtjc+VSHM7aU0SDbak5IUZRVno2P5mjSafAQ=="), true);

// --- our own signers round-trip (the rehearsal uses them) --------------------
const ours = signMessageBip322P2wpkh("ThePaymaster proof", wif.priv);
check("own p2wpkh BIP-322 verifies", verifyMessageBip322(A, "ThePaymaster proof", ours), true);
check("own p2wpkh BIP-322 fails on other text", verifyMessageBip322(A, "ThePaymaster proof.", ours), false);
const oursT = signMessageBip322P2tr("ThePaymaster proof", wif.priv);
check("own taproot BIP-322 verifies", verifyMessageBip322(T, "ThePaymaster proof", oursT), true);

// --- legacy signed messages --------------------------------------------------
// The classic uncompressed key 5KYZdUEo39z3FPrtuX2QbbwGnNP5zTd7yyr2SC1j299sBCnWjss
// is 1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN; header bytes 27–30 mark uncompressed.
const old = wifDecode("5KYZdUEo39z3FPrtuX2QbbwGnNP5zTd7yyr2SC1j299sBCnWjss")!;
check("uncompressed WIF → 1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN",
  addressFor(secp256k1.getPublicKey(old.priv, false), "p2pkh", "mainnet"), "1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN");
const L = addr("1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN");
const oldSig = signMessageLegacy("This is an example of a signed message.", old.priv, false);
check("uncompressed legacy signature verifies", verifyMessageLegacy(L, "This is an example of a signed message.", oldSig), true);
check("legacy vector fails on other text", verifyMessageLegacy(L, "This is an example of a signed message", oldSig), false);

const legacySig = signMessageLegacy("hello", wif.priv, true);
check("own legacy sig verifies for p2pkh", verifyMessageLegacy(addr(addressFor(pub, "p2pkh", "mainnet")), "hello", legacySig), true);
check("own legacy sig verifies for p2wpkh (Electrum/Sparrow style)", verifyMessageLegacy(A, "hello", legacySig), true);
check("own legacy sig verifies for p2sh-p2wpkh", verifyMessageLegacy(addr(addressFor(pub, "p2sh-p2wpkh", "mainnet")), "hello", legacySig), true);
check("own legacy sig verifies for taproot via BIP-86 tweak", verifyMessageLegacy(T, "hello", legacySig), true);
check("legacy sig for a different key fails", verifyMessageLegacy(L, "hello", legacySig), false);

// --- the combined check the rail uses ----------------------------------------
check("verifyMessage: BIP-322", verifyMessage(A, "Hello World",
  "AkcwRAIgZRfIY3p7/DoVTty6YZbWS71bc5Vct9p9Fia83eRmw2QCICK/ENGfwLtptFluMGs2KsqoNSk89pO7F29zJLUx9a/sASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI="), true);
check("verifyMessage: legacy", verifyMessage(A, "hello", legacySig), true);
check("verifyMessage: garbage", verifyMessage(A, "hello", "not a signature"), false);
check("verifyMessage: empty", verifyMessage(A, "hello", ""), false);

// --- encodings on their own --------------------------------------------------
check("base58check rejects a flipped char", base58CheckDecode("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3"), null);
check("bech32 rejects mixed case", bech32Decode("bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), null);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
