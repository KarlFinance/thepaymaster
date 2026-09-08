/**
 * Money arriving, the fee coming off, and money going out — each one recorded
 * with what proves it happened.
 *
 * Four of the five transaction types are settled by hand, through the HSBC
 * account or the OTC desk, and will be for a long time. So the manual path is
 * not an afterthought here: it is the main path, and it has to produce a record
 * as good as an on-chain one. An admin says what moved and attaches the MT103
 * or the trade confirmation; the file is hashed as it arrives and the event is
 * timestamped against the person who recorded it.
 *
 * Two rules that matter more than they look:
 *
 * Nothing is inferred. The system does not decide that money arrived because
 * the expected date passed, and does not mark a payout done because the others
 * were. Somebody says so, and their name is on it.
 *
 * A variance is never absorbed quietly. If what arrived is not what was
 * expected, the transaction stops and a person decides what to do, and that
 * decision is part of the record. Silently distributing a short amount is how
 * a clean audit trail becomes a disputed one.
 */

import { type Env, type Actor, id, log, insert, update } from "./db.ts";
import { format } from "./money.ts";
import { assess } from "./readiness.ts";
import { store, DocumentProblem } from "./documents.ts";

export type Holder = "client" | "thepaymaster_hsbc" | "otc_desk" | "none";
export type Event = "received" | "converted" | "sent" | "fee_taken" | "returned";

export interface Leg {
  participationId: string;
  partyId: string;
  name: string;
  expectedMinor: number;
  sentMinor: number | null;
  sentAt: string | null;
  evidenceId: string | null;
}

/** Where funds sit for each type, so the record says which was actually used. */
export function holderFor(t: { inbound: string; outbound: string; converts: number }): Holder {
  if (t.inbound === "crypto" && t.outbound === "crypto" && !t.converts) return "none";
  if (t.inbound === "fiat") return "thepaymaster_hsbc";
  return "otc_desk";
}

export async function events(env: Env, transactionId: string) {
  const { results } = await env.DB.prepare(
    `SELECT c.*, a.filename, a.sha256, a.id AS artefact
       FROM custody_events c LEFT JOIN artefacts a ON a.id = c.evidence_id
      WHERE c.transaction_id = ? ORDER BY c.occurred_at, c.created_at`)
    .bind(transactionId).all<any>();
  return results ?? [];
}

/**
 * Record an event, with its evidence.
 *
 * Evidence is not optional in spirit. It can be absent — sometimes a payment
 * genuinely has no document yet — but then the note has to say why, and the
 * gap is visible in the dossier rather than invisible.
 */
export async function record(env: Env, actor: Actor, transactionId: string, opts: {
  holder: Holder;
  event: Event;
  amountMinor: number;
  currency: string;
  decimals: number;
  occurredAt: string;
  note?: string;
  file?: File | null;
  evidenceKind?: string;
}): Promise<string | { problem: string }> {
  let evidenceId: string | null = null;
  if (opts.file && opts.file.size > 0) {
    try {
      const stored = await store(env, actor, opts.file, {
        kind: opts.evidenceKind ?? "settlement_evidence",
        label: `${opts.event} — ${opts.currency} ${format(opts.amountMinor, opts.decimals)}`,
        transactionId,
      });
      evidenceId = stored.artefactId;
    } catch (err) {
      if (err instanceof DocumentProblem) return { problem: err.message };
      throw err;
    }
  }

  const eventId = id("cus");
  await insert(env.DB, actor, `custody.${opts.event}`, "custody_events", eventId, {
    transaction_id: transactionId,
    holder: opts.holder,
    event: opts.event,
    amount_minor: opts.amountMinor,
    currency: opts.currency,
    decimals: opts.decimals,
    occurred_at: opts.occurredAt,
    evidence_id: evidenceId,
    recorded_by: actor.id,
  }, { note: opts.note ?? `${opts.currency} ${format(opts.amountMinor, opts.decimals)}` });
  return eventId;
}

/**
 * What arrived, against what was supposed to.
 *
 * Gross-up mode asks a sender for an odd figure — 1,010.11 rather than 1,010 —
 * and people round. So a variance here is expected often enough that it needs
 * a proper answer rather than an exception.
 */
export interface Arrival {
  expectedMinor: number | null;
  receivedMinor: number;
  varianceMinor: number;
  ok: boolean;
}

export async function arrival(env: Env, transactionId: string): Promise<Arrival | null> {
  const t = await env.DB.prepare(
    "SELECT gross_expected_minor, gross_received_minor FROM transactions WHERE id = ?")
    .bind(transactionId).first<any>();
  if (!t) return null;

  const row = await env.DB.prepare(
    `SELECT coalesce(sum(amount_minor), 0) AS total FROM custody_events
      WHERE transaction_id = ? AND event = 'received'`).bind(transactionId).first<any>();
  const received = row?.total ?? 0;
  const expected = t.gross_expected_minor ?? null;
  return {
    expectedMinor: expected,
    receivedMinor: received,
    varianceMinor: expected === null ? 0 : received - expected,
    ok: expected === null ? received > 0 : received === expected,
  };
}

/** What each recipient is owed, and what has actually gone to them. */
export async function legs(env: Env, transactionId: string): Promise<Leg[]> {
  const state = await assess(env, transactionId);
  const { results } = await env.DB.prepare(
    `SELECT p.id AS participation_id, p.party_id, y.display_name
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ? AND p.role = 'recipient'
      ORDER BY y.display_name`).bind(transactionId).all<any>();

  const out: Leg[] = [];
  for (const r of results ?? []) {
    const sent = await env.DB.prepare(
      `SELECT c.id, c.amount_minor, c.occurred_at, c.evidence_id
         FROM custody_events c
        WHERE c.transaction_id = ? AND c.event = 'sent'
          AND c.id IN (SELECT event_id FROM payout_legs WHERE participation_id = ?)
        ORDER BY c.occurred_at DESC LIMIT 1`)
      .bind(transactionId, r.participation_id).first<any>();
    out.push({
      participationId: r.participation_id,
      partyId: r.party_id,
      name: r.display_name,
      expectedMinor: state.settlement?.amounts[r.participation_id] ?? 0,
      sentMinor: sent?.amount_minor ?? null,
      sentAt: sent?.occurred_at ?? null,
      evidenceId: sent?.evidence_id ?? null,
    });
  }
  return out;
}

/** Everything that must be true before a transaction can be called settled. */
export async function settlementChecks(env: Env, transactionId: string): Promise<{
  checks: { label: string; met: boolean; detail: string }[];
  complete: boolean;
}> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(transactionId).first<any>();
  const got = await arrival(env, transactionId);
  const all = await legs(env, transactionId);
  const feeRow = await env.DB.prepare(
    `SELECT coalesce(sum(amount_minor), 0) AS total FROM custody_events
      WHERE transaction_id = ? AND event = 'fee_taken'`).bind(transactionId).first<any>();
  const state = await assess(env, transactionId);

  // A variance that has been looked at, decided and attributed is not an
  // outstanding problem — it is a recorded fact. Leaving this red once it has
  // been dealt with would mean a legitimately resolved discrepancy could never
  // be closed, which is a good rule turned into an obstruction.
  const varianceSettled = Boolean(t.variance_note);

  const checks = [
    {
      label: "The funds arrived",
      met: Boolean(got && got.receivedMinor > 0 && (got.ok || varianceSettled)),
      detail: !got || got.receivedMinor === 0
        ? "Nothing recorded as received"
        : got.ok
          ? `${t.currency_in} ${format(got.receivedMinor, t.decimals_in)}, as expected`
          : varianceSettled
            ? `${t.currency_in} ${format(got.receivedMinor, t.decimals_in)}, ` +
              `${got.varianceMinor > 0 ? "over" : "short"} by ` +
              `${format(Math.abs(got.varianceMinor), t.decimals_in)} — decided ` +
              `${(t.variance_decided_at ?? "").slice(0, 10)}: ${t.variance_note}`
            : `${t.currency_in} ${format(got.receivedMinor, t.decimals_in)} against ` +
              `${format(got.expectedMinor ?? 0, t.decimals_in)} expected — ` +
              `${got.varianceMinor > 0 ? "over" : "short"} by ` +
              `${format(Math.abs(got.varianceMinor), t.decimals_in)}, and nobody has ` +
              `said what we are doing about it`,
    },
    {
      label: "Our fee is recorded",
      met: (feeRow?.total ?? 0) > 0,
      detail: (feeRow?.total ?? 0) > 0
        ? `${t.currency_in} ${format(feeRow.total, t.decimals_in)}`
        : state.settlement
          ? `Not yet — should be ${t.currency_in} ${format(state.settlement.feeMinor, t.decimals_in)}`
          : "Not yet",
    },
    {
      label: "Every recipient has been paid",
      met: all.length > 0 && all.every((l) => l.sentMinor !== null),
      detail: all.length === 0 ? "No recipients"
        : all.every((l) => l.sentMinor !== null)
          ? `${all.length} paid`
          : `Outstanding: ${all.filter((l) => l.sentMinor === null).map((l) => l.name).join(", ")}`,
    },
    {
      label: "Every payment has evidence",
      met: all.length > 0 && all.every((l) => l.sentMinor === null || l.evidenceId),
      detail: all.some((l) => l.sentMinor !== null && !l.evidenceId)
        ? `No document against: ${all.filter((l) => l.sentMinor !== null && !l.evidenceId)
            .map((l) => l.name).join(", ")}`
        : "All accounted for",
    },
  ];

  return { checks, complete: checks.every((c) => c.met) };
}
