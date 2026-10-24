/**
 * What a transaction is worth in pounds, for comparing with an approval's ceiling.
 *
 * Approvals are given in GBP. Transactions arrive in GBP, EUR, USD, stablecoins
 * or coins, each with its own number of decimal places. Comparing the raw
 * minor units — what this used to do — made a USDT transaction look ten
 * thousand times larger than it is, because USDT counts in millionths.
 *
 * Dollars, euros and dollar stablecoins are counted pound for pound. That
 * overstates their size a little, deliberately: an approval should be read as
 * covering less, never more. Bitcoin and Ether are valued at the live price;
 * if the price cannot be read the answer is null, and the caller treats that
 * as "check by hand", never as "within the ceiling".
 */

import { type Env } from "./db.ts";

const POUND_FOR_POUND: Record<string, number> = { GBP: 1, USD: 1, EUR: 1, USDT: 1, USDC: 1 };
const COINGECKO_ID: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum" };

let priceCache: { at: number; gbp: Record<string, number> } | null = null;

async function coinPriceGbp(symbol: string): Promise<number | null> {
  const cgid = COINGECKO_ID[symbol];
  if (!cgid) return null;
  if (priceCache && Date.now() - priceCache.at < 10 * 60_000 && priceCache.gbp[symbol]) return priceCache.gbp[symbol];
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(COINGECKO_ID).join(",")}&vs_currencies=gbp`);
    if (!res.ok) return null;
    const body: any = await res.json();
    const gbp: Record<string, number> = {};
    for (const [sym, id] of Object.entries(COINGECKO_ID)) {
      const v = Number(body?.[id]?.gbp);
      if (v > 0) gbp[sym] = v;
    }
    priceCache = { at: Date.now(), gbp };
    return gbp[symbol] ?? null;
  } catch { return null; }
}

export interface GbpValue { minor: number; basis: string }

/** Pence, and how it was worked out. Null when it cannot be valued. */
export async function gbpValue(_env: Env, currency: string, minor: number, decimals: number): Promise<GbpValue | null> {
  const cur = String(currency || "").toUpperCase();
  const units = minor / 10 ** decimals;
  if (POUND_FOR_POUND[cur] !== undefined) {
    return { minor: Math.round(units * POUND_FOR_POUND[cur] * 100),
      basis: cur === "GBP" ? "GBP" : `${cur} counted pound for pound` };
  }
  const price = await coinPriceGbp(cur);
  if (!price) return null;
  return { minor: Math.round(units * price * 100), basis: `${cur} at £${price.toLocaleString("en-GB")}` };
}
