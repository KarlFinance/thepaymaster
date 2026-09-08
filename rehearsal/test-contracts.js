/**
 * Run the rehearsal contracts on a real EVM, locally.
 *
 * No chain, no faucet, no waiting — but the same bytecode and the same
 * execution rules as Sepolia or mainnet. The point is to prove the awkward
 * parts before spending anyone's time: that the disburser copes with a token
 * returning nothing, that a frozen address blocks the whole distribution
 * rather than just its own leg, and that a partial failure leaves no money
 * moved at all.
 */
import { VM } from "@ethereumjs/vm";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { Address, hexToBytes, bytesToHex, Account } from "@ethereumjs/util";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3";

const usdtArt = JSON.parse(readFileSync("build/MockUSDT.json", "utf8"));
const disbArt = JSON.parse(readFileSync("build/Disburser.json", "utf8"));

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const vm = await VM.create({ common });

const OWNER = new Address(hexToBytes("0x" + "11".repeat(20)));
const SENDER = new Address(hexToBytes("0x" + "22".repeat(20)));
const A = new Address(hexToBytes("0x" + "aa".repeat(20)));
const B = new Address(hexToBytes("0x" + "bb".repeat(20)));
const FEE = new Address(hexToBytes("0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e"));

for (const a of [OWNER, SENDER]) {
  await vm.stateManager.putAccount(a, new Account(0n, 10n ** 20n));
}

const sel = (sig) => bytesToHex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const word = (v) => (typeof v === "bigint" ? v.toString(16) : v.toString().replace(/^0x/, ""))
  .padStart(64, "0");

async function deploy(artifact, from) {
  const r = await vm.evm.runCall({
    caller: from, to: undefined, gasLimit: 10_000_000n,
    data: hexToBytes(artifact.bytecode),
  });
  if (r.execResult.exceptionError) throw new Error("deploy: " + r.execResult.exceptionError.error);
  return r.createdAddress;
}

async function call(to, from, data, expectRevert = false) {
  const r = await vm.evm.runCall({
    caller: from, to, gasLimit: 10_000_000n, data: hexToBytes(data),
  });
  const err = r.execResult.exceptionError;
  if (err && !expectRevert) throw new Error("reverted: " + err.error);
  return { reverted: Boolean(err), out: bytesToHex(r.execResult.returnValue) };
}

let bad = 0;
// BigInt does not serialise, and every amount here is one.
const show = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const check = (n, got, want) => {
  if (show(got) !== show(want)) {
    bad++; console.log(`  FAIL ${n}\n       got  ${show(got)}\n       want ${show(want)}`);
  } else console.log(`  ok   ${n}`);
};

const usdt = await deploy(usdtArt, OWNER);
const disb = await deploy(disbArt, OWNER);
console.log(`  mock USDT at ${usdt}`);
console.log(`  disburser at ${disb}\n`);

const M = 1_000_000n;                       // one USDT, six decimals
const total = 350_000_000n * M;

await call(usdt, OWNER, sel("mint(address,uint256)") + word(SENDER.toString()) + word(total));
const balOf = async (a) =>
  BigInt((await call(usdt, OWNER, sel("balanceOf(address)") + word(a.toString()))).out);

check("sender starts with 350m", await balOf(SENDER), total);

// --- the quirk that breaks naive integrations ------------------------------
const approve = (spender, amount) =>
  sel("approve(address,uint256)") + word(spender.toString()) + word(amount);
await call(usdt, SENDER, approve(disb, total));
check("raising a non-zero allowance is refused",
  (await call(usdt, SENDER, approve(disb, total + 1n), true)).reverted, true);
await call(usdt, SENDER, approve(disb, 0n));
await call(usdt, SENDER, approve(disb, total));
check("zero first, then set, works", true, true);

// --- the distribution ------------------------------------------------------
const fee = 3_535_353_535353n;              // 1% grossed up, from the platform
const toA = 200_000_000n * M;
const toB = 150_000_000n * M - fee;

function disburse(recips, amounts) {
  const n = BigInt(recips.length);
  return sel("disburse(bytes32,address,address[],uint256[])")
    + word("0x" + "de".repeat(32))          // dealId
    + word(usdt.toString())
    + word(0x80n)                            // offset of recipients
    + word(0x80n + 32n + n * 32n)            // offset of amounts
    + word(n) + recips.map((r) => word(r.toString())).join("")
    + word(n) + amounts.map((a) => word(a)).join("");
}

// A frozen recipient must stop everything, not just their own leg.
await call(usdt, OWNER, sel("addBlackList(address)") + word(B.toString()));
const frozen = await call(disb, SENDER, disburse([A, B, FEE], [toA, toB, fee]), true);
check("a frozen recipient reverts the whole thing", frozen.reverted, true);
check("...and nobody was paid", [await balOf(A), await balOf(FEE)], [0n, 0n]);
check("...and the sender still holds it all", await balOf(SENDER), total);
await call(usdt, OWNER, sel("removeBlackList(address)") + word(B.toString()));

// Amounts that exceed the balance must revert as one.
const tooMuch = await call(disb, SENDER, disburse([A, B], [total, 1n * M]), true);
check("over-spending reverts", tooMuch.reverted, true);
check("...and moved nothing", await balOf(SENDER), total);

// The real thing.
await call(disb, SENDER, disburse([A, B, FEE], [toA, toB, fee]));
check("A received exactly", await balOf(A), toA);
check("B received exactly", await balOf(B), toB);
check("our fee arrived", await balOf(FEE), fee);
check("the sender has nothing left", await balOf(SENDER), 0n);
check("nothing stuck in the disburser", await balOf(disb), 0n);
check("it all adds up",
  (await balOf(A)) + (await balOf(B)) + (await balOf(FEE)), total);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
