/**
 * Money, and the fee.
 *
 * Everything here is integer minor units — pence, or whatever the sixth
 * decimal of a USDT is called. No floats touch an amount at any point: a
 * rounding error on a two million pound distribution is a phone call nobody
 * wants to make.
 */

export type FeeMode = "deducted" | "grossed_up";

export interface Split {
  /** participation id */
  id: string;
  /** For grossed_up: what this party must receive. */
  amountMinor?: number;
  /** For deducted: their share of what is left, in basis points. */
  shareBps?: number;
}

export interface Settlement {
  /** What the sender must send. */
  grossMinor: number;
  /** Our cut. */
  feeMinor: number;
  /** What is left to share. */
  netMinor: number;
  /** Final per-party amounts, summing exactly to netMinor. */
  amounts: Record<string, number>;
}

/**
 * Work out who gets what.
 *
 * Two modes, and the difference is which number is nailed down:
 *
 *   deducted   — the sender's figure is fixed. Fee comes out of it, the
 *                recipients share the remainder by their percentages.
 *   grossed_up — the recipients' figures are fixed. The sender has to send
 *                more, and the amount is gross = net / (1 - fee), NOT
 *                net * (1 + fee). The naive version shorts the recipients:
 *                on a two million pound distribution at 1% it leaves them
 *                two hundred pounds light and the split does not reconcile.
 *
 * The remainder is never dropped or spread. Dividing rarely comes out even, so
 * one nominated party absorbs the odd unit and the total always adds up.
 */
export function settle(
  mode: FeeMode,
  feeBps: number,
  splits: Split[],
  opts: { grossMinor?: number; remainderTo?: string },
): Settlement {
  if (splits.length === 0) throw new Error("no recipients");
  if (feeBps < 0 || feeBps >= 10_000) throw new Error("fee out of range");

  // Everything below is BigInt.
  //
  // Grossing up multiplies by ten thousand before dividing, and on a
  // three-hundred-and-fifty-million USDT distribution that intermediate is
  // 3.5e18 — comfortably past 2^53, where JavaScript numbers stop being exact
  // integers. The arithmetic still produced plausible figures, which is the
  // worst way for it to be wrong. There is no rounding to notice and no error
  // thrown; the answer is simply not guaranteed.
  const bps = BigInt(feeBps);
  const TEN_K = 10_000n;
  const asBig = (n: number, what: string): bigint => {
    if (!Number.isSafeInteger(n)) {
      throw new Error(`${what} is too large to be exact as a number: ${n}`);
    }
    return BigInt(n);
  };

  let gross: bigint;
  let fee: bigint;
  let net: bigint;
  const amounts: Record<string, bigint> = {};

  if (mode === "deducted") {
    gross = asBig(opts.grossMinor ?? 0, "gross");
    if (gross <= 0n) throw new Error("gross required when fee is deducted");
    // Fee rounds down to the unit; the recipients get the rest.
    fee = (gross * bps) / TEN_K;
    net = gross - fee;

    const totalBps = splits.reduce((a, s) => a + (s.shareBps ?? 0), 0);
    if (totalBps !== 10_000) throw new Error(`shares total ${totalBps}bps, need 10000`);
    for (const s of splits) {
      amounts[s.id] = (net * BigInt(s.shareBps ?? 0)) / TEN_K;
    }
  } else {
    net = splits.reduce((a, s) => a + asBig(s.amountMinor ?? 0, "an amount"), 0n);
    if (net <= 0n) throw new Error("recipient amounts required when grossing up");
    for (const s of splits) amounts[s.id] = asBig(s.amountMinor ?? 0, "an amount");
    // The smallest whole gross that still leaves at least net after the fee:
    // ceiling division, done exactly.
    const denominator = TEN_K - bps;
    gross = (net * TEN_K + denominator - 1n) / denominator;
    fee = (gross * bps) / TEN_K;
    // The ceiling can leave a unit spare; it belongs to the recipients, not us.
    net = gross - fee;
  }

  // Whatever is unallocated after integer division goes to one named party, so
  // the sum is exact and the dossier can say who absorbed it.
  const allocated = Object.values(amounts).reduce((a, b) => a + b, 0n);
  const remainder = net - allocated;
  if (remainder !== 0n) {
    const target = opts.remainderTo && amounts[opts.remainderTo] !== undefined
      ? opts.remainderTo
      : largest(amounts);
    amounts[target] += remainder;
  }

  const check = Object.values(amounts).reduce((a, b) => a + b, 0n);
  if (check + fee !== gross) {
    throw new Error(`split does not reconcile: ${check} + ${fee} != ${gross}`);
  }

  // Back to numbers at the edge, where the caller and the database both live —
  // but only after checking each one is still exactly representable.
  const out = (v: bigint, what: string): number => {
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `${what} exceeds what can be held exactly (${v}). This currency's ` +
        `smallest unit is too fine for an amount this large.`);
    }
    return Number(v);
  };
  return {
    grossMinor: out(gross, "the gross"),
    feeMinor: out(fee, "the fee"),
    netMinor: out(net, "the net"),
    amounts: Object.fromEntries(
      Object.entries(amounts).map(([k, v]) => [k, out(v, `the amount for ${k}`)])),
  };
}

function largest(amounts: Record<string, bigint>): string {
  return Object.entries(amounts).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))[0][0];
}

/** Minor units to a display string, e.g. 101011 at 2dp -> "1,010.11". */
export function format(minor: number, decimals: number): string {
  const neg = minor < 0;
  const s = Math.abs(minor).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals ? "." + s.slice(s.length - decimals) : "";
  return (neg ? "-" : "") + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + frac;
}

/** "1010.11" at 2dp -> 101011. Rejects anything with too much precision. */
export function parse(input: string, decimals: number): number {
  const m = input.replace(/[, ]/g, "").match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`not an amount: ${input}`);
  const frac = m[3] ?? "";
  if (frac.length > decimals) {
    throw new Error(`${input} is finer than ${decimals} decimal places`);
  }
  const minor = BigInt(m[2]) * BigInt(10 ** decimals)
    + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return Number(m[1] === "-" ? -minor : minor);
}
