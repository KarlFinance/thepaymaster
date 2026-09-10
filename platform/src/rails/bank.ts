/**
 * The bank rail: a fiat-to-fiat distribution through the client mandated
 * account at HSBC.
 *
 * It answers the same questions the chain rails answer, in the terms a bank
 * account has. An "address" is an account; it is proved by a penny with a
 * code in the reference, not a signature; a "hash" is our payment reference;
 * verification is a statement line that carries it. There is nothing to
 * screen for freezing and no browser wallet, so those answer plainly.
 */

import { type Env } from "../db.ts";
import { type Rail, type AddressReport, type Verification, type Health } from "../rail.ts";
import { problemWith } from "../destinations.ts";

export const BANK_CHAIN_ID = 100100;                    // reserved, off every chain id list

export function bankRail(currency: string, decimals = 2): Rail {
  const symbol = (currency || "GBP").toUpperCase();
  return {
    key: `bank:${symbol.toLowerCase()}`,
    name: `${symbol} by bank transfer`,
    symbol,
    decimals,
    canFreeze: false,
    chainId: BANK_CHAIN_ID,
    explorer: {
      tx: (ref) => `/bank?reference=${encodeURIComponent(ref)}`,
      address: () => `#`,
    },

    normalise(account: string) {
      // "12-34-56 12345678" or an IBAN. Uses the same checks the recipient's form does.
      const s = account.replace(/\s+/g, "").toUpperCase();
      const iban = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s);
      const uk = s.match(/^(\d{6})(\d{8})$/);
      const p = problemWith("bank", iban ? { iban: s } : uk ? { sort_code: uk[1], account_number: uk[2] } : {});
      if (p) return { ok: false, why: p };
      return { ok: true, address: iban ? s : `${uk![1]} ${uk![2]}` };
    },
    hashProblem(reference: string) {
      return /^TPM-\d{4}-\d{4}(-\d{2}|-FEE)?$/.test(reference.trim()) ? null
        : "A payment reference looks like TPM-2026-0002-01.";
    },

    challenge: () => "A bank account is proved by the penny test, not a signed message.",
    provesControl: async () => false,

    balance: async () => 0n,
    nativeBalance: async () => null,
    inspect: async (_env: Env, address: string, role: string): Promise<AddressReport> =>
      ({ address, role, balance: null, frozen: null, contract: false }),
    health: async (): Promise<Health[]> => [{ name: "HSBC client mandated account", ok: true, height: null,
      note: "statement lines are imported by hand until the bank API is wired in" }],

    dustMinor: () => 1,
    async verify(env: Env, reference: string, want: { to: string; amountMinor: number | bigint }): Promise<Verification | null> {
      const line = await env.DB.prepare(
        `SELECT * FROM bank_lines WHERE direction = 'out' AND amount_minor = ?
           AND UPPER(REPLACE(reference, ' ', '')) LIKE ? ORDER BY booked_on DESC LIMIT 1`)
        .bind(Number(want.amountMinor), `%${reference.toUpperCase().replace(/\s/g, "")}%`).first<any>();
      if (!line) return { ok: false, from: null, block: null, sources: 1, agreed: true,
        problem: "No statement line carries that reference for that amount." };
      return { ok: true, from: "client mandated account", block: null, sources: 1, agreed: true };
    },

    browser: { walletHint: "No wallet is involved: payments are made from the client mandated account.", script: "" },
  };
}
