import { settle, format, parse } from "./money.ts";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failures++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
  else console.log(`  ok   ${name}`);
}

// --- the worked example from the conversation ------------------------------
const splits = [
  { id: "alice", amountMinor: 80000 },
  { id: "bob",   amountMinor: 10000 },
  { id: "carol", amountMinor: 10000 },
];

const up = settle("grossed_up", 100, splits, { remainderTo: "carol" });
check("grossed up: sender sends 1010.11", up.grossMinor, 101011);
check("grossed up: fee is 10.10", up.feeMinor, 1010);
check("grossed up: recipients get at least their number",
  [up.amounts.alice >= 80000, up.amounts.bob >= 10000, up.amounts.carol >= 10000],
  [true, true, true]);
check("grossed up: reconciles",
  Object.values(up.amounts).reduce((a, b) => a + b, 0) + up.feeMinor, up.grossMinor);

// The naive gross-up would be 101000, leaving 999.90 — ten pence short.
check("grossed up beats naive x1.01", up.grossMinor > 101000, true);

// --- at scale, where the naive version costs real money --------------------
const big = settle("grossed_up", 100, [{ id: "a", amountMinor: 200_000_000 }], {});
check("2m: sender sends 2,020,202.03", big.grossMinor, 202020203);
check("2m: recipient is not short", big.amounts.a >= 200_000_000, true);
const naiveShortfall = 200_000_000 - (202_000_000 - Math.floor(202_000_000 / 100));
check("2m: naive would short by 200.00 (20000p)", naiveShortfall, 20000);

// --- deducted --------------------------------------------------------------
const down = settle("deducted", 100,
  [{ id: "alice", shareBps: 8000 }, { id: "bob", shareBps: 1000 }, { id: "carol", shareBps: 1000 }],
  { grossMinor: 100000, remainderTo: "carol" });
check("deducted: fee is 10.00", down.feeMinor, 1000);
check("deducted: net is 990.00", down.netMinor, 99000);
check("deducted: alice gets 792.00", down.amounts.alice, 79200);
check("deducted: reconciles",
  Object.values(down.amounts).reduce((a, b) => a + b, 0) + down.feeMinor, down.grossMinor);

// --- the remainder has to go somewhere, always -----------------------------
const odd = settle("deducted", 100,
  [{ id: "a", shareBps: 3333 }, { id: "b", shareBps: 3333 }, { id: "c", shareBps: 3334 }],
  { grossMinor: 10001, remainderTo: "a" });
check("odd split reconciles exactly",
  Object.values(odd.amounts).reduce((a, b) => a + b, 0) + odd.feeMinor, odd.grossMinor);

// --- USDT at 6dp -----------------------------------------------------------
const usdt = settle("grossed_up", 100, [{ id: "x", amountMinor: 1_000_000_000 }], {});
check("usdt reconciles",
  Object.values(usdt.amounts).reduce((a, b) => a + b, 0) + usdt.feeMinor, usdt.grossMinor);

// --- guards ----------------------------------------------------------------
function throws(fn: () => unknown) { try { fn(); return false; } catch { return true; } }
check("shares must total 100%", throws(() =>
  settle("deducted", 100, [{ id: "a", shareBps: 5000 }], { grossMinor: 1000 })), true);
check("no recipients is an error", throws(() => settle("deducted", 100, [], {})), true);

// --- formatting and parsing ------------------------------------------------
check("format 101011 @2", format(101011, 2), "1,010.11");
check("format 1000000 @6", format(1000000, 6), "1.000000");
check("parse 1,010.11 @2", parse("1,010.11", 2), 101011);
check("parse rejects excess precision", throws(() => parse("1.005", 2)), true);
check("round trip", format(parse("2,020,202.03", 2), 2), "2,020,202.03");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
