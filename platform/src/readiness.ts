/**
 * The gate.
 *
 * A transaction cannot be marked ready until every one of these is green, and
 * each one says who made it green and when. That is the whole idea: not a
 * button somebody presses when it feels about right, but a list of specific
 * things that are true, attributable, and dated.
 *
 * The checks are computed fresh every time rather than cached on the
 * transaction. A verification that expired yesterday should close the gate
 * today without anybody having to remember to run something.
 */

import { type Env } from "./db.ts";
import { settle, format, type FeeMode } from "./money.ts";
import { standingCheck } from "./screening.ts";

export interface Check {
  key: string;
  label: string;
  met: boolean;
  /** What is true, or what is missing — always specific enough to act on. */
  detail: string;
  /** Set where a person made it true, so the gate shows whose word it is. */
  by?: string | null;
  at?: string | null;
}

export interface Readiness {
  checks: Check[];
  ready: boolean;
  /** The arithmetic, when it can be worked out. */
  settlement?: {
    grossMinor: number;
    feeMinor: number;
    netMinor: number;
    amounts: Record<string, number>;
  };
}

export async function assess(env: Env, transactionId: string): Promise<Readiness> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(transactionId).first<any>();
  if (!t) return { checks: [], ready: false };

  const { results: people } = await env.DB.prepare(
    `SELECT p.id AS participation_id, p.role, p.amount_minor, p.share_bps,
            y.id AS party_id, y.display_name, y.email, y.kyc_submitted_at
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ?`).bind(transactionId).all<any>();
  const parties = people ?? [];
  const senders = parties.filter((p) => p.role === "sender");
  const recipients = parties.filter((p) => p.role === "recipient");

  const checks: Check[] = [];

  // --- who is on it --------------------------------------------------------
  checks.push({
    key: "sender",
    label: "A sender is named",
    met: senders.length === 1,
    detail: senders.length === 1 ? senders[0].display_name
      : senders.length === 0 ? "Nobody is down as the sender"
      : `${senders.length} senders — there can only be one`,
  });

  checks.push({
    key: "recipients",
    label: "At least one recipient",
    met: recipients.length > 0,
    detail: recipients.length
      ? `${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`
      : "Nobody to pay",
  });

  // --- the arithmetic ------------------------------------------------------
  let settlement: Readiness["settlement"];
  let amountsOk = false;
  let amountsDetail = "No amounts set";
  if (recipients.length) {
    const mode = (t.fee_mode as FeeMode) ?? "deducted";
    try {
      const splits = recipients.map((r) => ({
        id: r.participation_id,
        amountMinor: r.amount_minor ?? undefined,
        shareBps: r.share_bps ?? undefined,
      }));
      const result = settle(mode, t.fee_bps ?? 100, splits, {
        grossMinor: t.gross_expected_minor ?? undefined,
        remainderTo: t.remainder_to ?? undefined,
      });
      settlement = result;
      amountsOk = true;
      amountsDetail =
        `${t.currency_in} ${format(result.grossMinor, t.decimals_in)} in, ` +
        `fee ${format(result.feeMinor, t.decimals_in)}, ` +
        `${format(result.netMinor, t.decimals_out)} out`;
    } catch (err) {
      amountsDetail = (err as Error).message;
    }
  }
  checks.push({
    key: "amounts",
    label: "The split adds up",
    met: amountsOk,
    detail: amountsDetail,
  });

  // --- everybody is verified, to a level that covers this ------------------
  const gross = settlement?.grossMinor ?? t.gross_expected_minor ?? null;
  const unverified: string[] = [];
  const underCeiling: string[] = [];
  for (const p of parties) {
    if (p.role === "observer") continue;
    const standing = await standingCheck(env, p.party_id);
    if (!standing) {
      unverified.push(p.display_name);
      continue;
    }
    // A clearance for fifty thousand is not a clearance for five million.
    if (standing.band_ceiling_minor !== null && gross !== null
        && gross > standing.band_ceiling_minor) {
      underCeiling.push(
        `${p.display_name} (cleared to ${format(standing.band_ceiling_minor, 2)})`);
    }
  }
  checks.push({
    key: "verified",
    label: "Everyone is verified",
    met: unverified.length === 0 && underCeiling.length === 0,
    detail: unverified.length ? `Waiting on ${unverified.join(", ")}`
      : underCeiling.length ? `Cleared, but not for this size: ${underCeiling.join(", ")}`
      : `${parties.length} verified and in date`,
  });

  // --- and, for a wallet, that it really is theirs -------------------------
  if (t.outbound === "crypto") {
    const unproved: string[] = [];
    for (const r of recipients) {
      const d = await env.DB.prepare(
        "SELECT address, proved_at FROM destinations WHERE participation_id = ?")
        .bind(r.participation_id).first<any>();
      // A recipient with no wallet at all has certainly not proved one.
      // Skipping them made this line say "all proved" when nobody had.
      if (!d || !d.proved_at) unproved.push(r.display_name);
    }
    checks.push({
      key: "wallets_proved",
      label: "Every recipient has proved their wallet",
      met: recipients.length > 0 && unproved.length === 0,
      detail: unproved.length
        ? `No signature from ${unproved.join(", ")}`
        : recipients.length ? "All proved by signature" : "No recipients",
    });
  }

  // --- where the money goes ------------------------------------------------
  const needs = t.outbound === "fiat" ? "bank details" : "a wallet address";
  const missingDest: string[] = [];
  const unlocked: string[] = [];
  let lastLock: { by: string | null; at: string | null } = { by: null, at: null };
  for (const r of recipients) {
    const d = await env.DB.prepare(
      "SELECT status, kind, locked_at FROM destinations WHERE participation_id = ?")
      .bind(r.participation_id).first<any>();
    if (!d) { missingDest.push(r.display_name); continue; }
    if (d.status !== "locked") {
      unlocked.push(`${r.display_name} (${d.status})`);
    } else if (!lastLock.at || d.locked_at > lastLock.at) {
      lastLock = { by: null, at: d.locked_at };
    }
  }
  checks.push({
    key: "destinations",
    label: `Every recipient's ${needs} is locked`,
    met: recipients.length > 0 && missingDest.length === 0 && unlocked.length === 0,
    detail: missingDest.length ? `Nothing from ${missingDest.join(", ")}`
      : unlocked.length ? `Not locked yet: ${unlocked.join(", ")}`
      : recipients.length ? "All locked" : "No recipients",
    at: lastLock.at,
  });

  // --- the sending side ----------------------------------------------------
  if (t.inbound === "crypto") {
    const row = await env.DB.prepare(
      `SELECT count(*) AS n, sum(proved_at IS NOT NULL) AS proved
         FROM sending_wallets WHERE transaction_id = ?`)
      .bind(transactionId).first<any>();
    const n = row?.n ?? 0, proved = row?.proved ?? 0;
    // Recorded is not enough. On an irreversible transfer the only thing that
    // settles whose wallet this is, is a signature from the key.
    checks.push({
      key: "sending_wallets",
      label: "The sender's wallets are proved",
      met: n > 0 && proved === n,
      detail: n === 0 ? "No sending wallet given"
        : proved === n
          ? `${n} wallet${n === 1 ? "" : "s"}, all proved by signature`
          : `${n} given, only ${proved} proved by signature`,
    });
  }

  // --- the paperwork -------------------------------------------------------
  if (t.inbound === "fiat" || t.outbound === "fiat") {
    checks.push({
      key: "acting_for",
      label: "Which side we act for is recorded",
      met: Boolean(t.acting_for),
      detail: t.acting_for
        ? `The ${t.acting_for}`
        : "Not decided — paragraph 2(b) is only available to an agent acting for one side",
    });
  }

  return { checks, ready: checks.every((c) => c.met), settlement };
}

/** A one-line summary for the pipeline card. */
export function summarise(r: Readiness): string {
  const done = r.checks.filter((c) => c.met).length;
  return `${done} of ${r.checks.length}`;
}
