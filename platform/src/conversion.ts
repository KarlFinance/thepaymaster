/**
 * The desk stage.
 *
 * Two of the five transaction types convert between fiat and a digital asset.
 * The conversion itself happens outside the platform — a member of staff
 * instructs the OTC desk, the desk executes on its own terms and charges its
 * own fee at source — so what the platform does is bracket that step: record
 * the instruction so every party knows we have stepped out, record the
 * execution when the desk confirms (rate, fee, quantity, confirmation), and
 * carry the result into the rest of the record so the recipients' amounts,
 * the custody trail and the certification all follow from it.
 *
 *   buy   fiat in → digital asset out. Proceeds land in our client wallet,
 *         verified by hash; then the Mode C distribution pays recipients.
 *   sell  digital asset in → fiat out. Proceeds land in the HSBC client
 *         account, evidenced by the desk's confirmation; then the manual
 *         fiat flow pays recipients.
 */

import { type Env, type Actor, id, insert, update } from "./db.ts";
import { format } from "./money.ts";
import { record as recordCustody } from "./settlement.ts";
import { assess } from "./readiness.ts";
import { railFor } from "./rail.ts";
import { store, DocumentProblem } from "./documents.ts";
import { conversionInstructed, conversionExecuted } from "./notify.ts";

/** The desk, as named in the Client Information Sheet, and what it charges at source. */
export const DESK = {
  name: "MAS Digital",
  describe: "MAS Digital, the digital-asset desk of the MAS Group (Multi Asset Solutions), on its own terms of business and its own regulatory footing",
  feeBps: 250,
};

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export interface Conversion {
  id: string; transaction_id: string; direction: "buy" | "sell"; desk: string; desk_ref: string | null;
  from_currency: string; from_decimals: number; from_minor: number; desk_fee_bps: number; desk_fee_minor: number | null;
  rate: string | null; to_currency: string; to_decimals: number; to_minor: number | null;
  instructed_at: string; instructed_by: string | null; executed_at: string | null; recorded_by: string | null;
  evidence_id: string | null; custody_event_id: string | null; note: string | null; cancelled_at: string | null;
}

export const converts = (t: { converts: number }) => Boolean(t.converts);
export const directionFor = (t: { inbound: string; outbound: string }): "buy" | "sell" =>
  t.inbound === "fiat" && t.outbound === "crypto" ? "buy" : "sell";

export async function latest(env: Env, txId: string): Promise<Conversion | null> {
  return env.DB.prepare(
    "SELECT * FROM conversions WHERE transaction_id = ? AND cancelled_at IS NULL ORDER BY instructed_at DESC, rowid DESC LIMIT 1")
    .bind(txId).first<Conversion>();
}

/** What we would hand the desk: the gross less our fee (buy), or everything received (sell). */
export async function amountToConvert(env: Env, txId: string): Promise<{ minor: number; currency: string; decimals: number } | null> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!t || !t.converts) return null;
  if (directionFor(t) === "buy") {
    const s = await assess(env, txId, { agreements: false });
    if (!s.settlement) return null;
    return { minor: s.settlement.netMinor, currency: t.currency_in, decimals: t.decimals_in };
  }
  const got = await env.DB.prepare(
    "SELECT coalesce(sum(amount_minor), 0) AS n FROM custody_events WHERE transaction_id = ? AND event = 'received'").bind(txId).first<any>();
  return { minor: Number(got?.n ?? 0), currency: t.currency_in, decimals: t.decimals_in };
}

/** Staff have instructed the desk. Everyone is told we have stepped out. */
export async function instruct(env: Env, actor: Actor, txId: string, o: { fromMinor: number; deskRef?: string; note?: string }): Promise<string | { problem: string }> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!t) return { problem: "No such transaction." };
  if (!t.converts) return { problem: "This transaction has no conversion." };
  if (await latest(env, txId)) return { problem: "A conversion is already instructed or done on this transaction. Cancel it first if it was wrong." };
  if (o.fromMinor <= 0) return { problem: "Nothing to convert." };
  const direction = directionFor(t);
  if (direction === "sell") {
    const got = await env.DB.prepare(
      "SELECT coalesce(sum(amount_minor), 0) AS n FROM custody_events WHERE transaction_id = ? AND event = 'received'").bind(txId).first<any>();
    if (!(Number(got?.n) >= o.fromMinor)) return { problem: "The sender's digital assets have not been recorded as received into the client wallet, or not enough of them." };
  } else {
    const got = await env.DB.prepare(
      "SELECT coalesce(sum(amount_minor), 0) AS n FROM custody_events WHERE transaction_id = ? AND event = 'received'").bind(txId).first<any>();
    if (!(Number(got?.n) > 0)) return { problem: "The sender's funds have not been recorded as received into the client account." };
  }
  const rowId = id("cnv");
  await insert(env.DB, actor, "conversion.instructed", "conversions", rowId, {
    transaction_id: txId, direction, desk: DESK.name, desk_ref: o.deskRef?.trim() || null,
    from_currency: t.currency_in, from_decimals: t.decimals_in, from_minor: o.fromMinor,
    desk_fee_bps: DESK.feeBps, to_currency: t.currency_out, to_decimals: t.decimals_out,
    instructed_by: actor.id, note: o.note?.trim() || null,
  }, { note: `${direction} — ${t.currency_in} ${format(o.fromMinor, t.decimals_in)} handed to ${DESK.name}` });
  await conversionInstructed(env, actor, txId, rowId);
  return rowId;
}

/**
 * The desk has executed. What came back is recorded as a custody event held
 * where it now sits: our client wallet (buy, verified by hash) or the client
 * account (sell, evidenced by the desk's confirmation).
 */
export async function execute(env: Env, actor: Actor, convId: string, o: {
  toMinor: number; deskFeeMinor: number | null; rate: string | null; deskRef: string | null;
  executedOn: string; txHash: string | null; file: File | null; note?: string;
}): Promise<string | null> {
  const c = await env.DB.prepare("SELECT * FROM conversions WHERE id = ?").bind(convId).first<Conversion>();
  if (!c) return "No such conversion.";
  if (c.executed_at) return "That conversion is already recorded as executed.";
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(c.transaction_id).first<any>();
  if (o.toMinor <= 0) return "Enter what came back from the desk.";

  let preVerified: { block: number | null; sources: number } | null = null;
  let holder: "thepaymaster_wallet" | "thepaymaster_hsbc";
  if (c.direction === "buy") {
    holder = "thepaymaster_wallet";
    if (!t.client_wallet) return "No client wallet is set on this transaction; choose one under Chain settings so the desk has somewhere to deliver.";
    if (!o.txHash) return "For a purchase, the hash of the desk's delivery into our client wallet is required.";
    const rail = railFor(t);
    const shape = rail.hashProblem(o.txHash);
    if (shape) return shape;
    const moved = await rail.verify(env, o.txHash, { to: t.client_wallet, amountMinor: o.toMinor });
    if (!moved) return "Could not reach the chain to check that hash. Try again.";
    if (!moved.ok) return moved.problem === "pending" ? "That transaction has not been included in a block yet. Wait and try again."
      : `That transaction does not deliver ${format(o.toMinor, t.decimals_out)} ${t.currency_out} to the client wallet${moved.problem ? ` (${moved.problem})` : ""}.`;
    preVerified = { block: moved.block, sources: moved.sources };
  } else {
    holder = "thepaymaster_hsbc";
    if (!o.file || o.file.size === 0) return "For a sale, attach the desk's confirmation or the bank advice showing the fiat proceeds arriving.";
  }

  const ev = await recordCustody(env, actor, c.transaction_id, {
    holder, event: "converted", amountMinor: o.toMinor, currency: c.to_currency, decimals: c.to_decimals,
    occurredAt: `${o.executedOn} 00:00:00`,
    txHash: o.txHash, chainId: t.chain_id, preVerified,
    file: o.file, evidenceKind: "otc_confirmation",
    note: `${c.direction === "buy" ? "bought" : "sold"} via ${c.desk}: ${c.from_currency} ${format(c.from_minor, c.from_decimals)} → ${c.to_currency} ${format(o.toMinor, c.to_decimals)}` +
      (o.rate ? ` at ${o.rate}` : "") + (o.deskFeeMinor != null ? `; desk fee ${c.from_currency} ${format(o.deskFeeMinor, c.from_decimals)} at source` : ""),
  });
  if (typeof ev === "object") return ev.problem;

  await update(env.DB, actor, "conversion.executed", "conversions", convId, {
    to_minor: o.toMinor, desk_fee_minor: o.deskFeeMinor, rate: o.rate, desk_ref: o.deskRef ?? c.desk_ref,
    executed_at: `${o.executedOn} 00:00:00`, recorded_by: actor.id, custody_event_id: ev,
    note: [c.note, o.note?.trim()].filter(Boolean).join(" — ") || null,
  }, { executed_at: null, to_minor: null }, { note: `${c.to_currency} ${format(o.toMinor, c.to_decimals)} came back` });
  await conversionExecuted(env, actor, c.transaction_id, convId);
  return null;
}

export async function cancel(env: Env, actor: Actor, convId: string, reason: string): Promise<string | null> {
  const c = await env.DB.prepare("SELECT * FROM conversions WHERE id = ?").bind(convId).first<Conversion>();
  if (!c) return "No such conversion.";
  if (c.executed_at) return "An executed conversion cannot be cancelled; it is on the record.";
  if (reason.trim().length < 5) return "Say why.";
  await update(env.DB, actor, "conversion.cancelled", "conversions", convId,
    { cancelled_at: stamp(), cancelled_reason: reason.trim() }, { cancelled_at: null }, { note: reason.trim() });
  return null;
}

/**
 * Each recipient's amount in the outgoing asset.
 *
 * Without a conversion the split arithmetic already answers in the outgoing
 * currency. With one, each recipient's share of the incoming amount becomes
 * the same share of what the desk returned, the odd unit going where the
 * transaction says the remainder goes. Before the desk has executed there is
 * nothing to share out, and the answer is empty rather than a guess.
 */
export async function deliveredAmounts(env: Env, txId: string): Promise<Record<string, number> | null> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!t?.converts) return null;
  const c = await latest(env, txId);
  if (!c?.executed_at || !c.to_minor) return {};
  const s = await assess(env, txId, { agreements: false });
  const shares = s.settlement?.amounts ?? {};
  const total = Object.values(shares).reduce((a, b) => a + b, 0);
  if (!total) return {};
  const out: Record<string, number> = {};
  let given = 0;
  const ids = Object.keys(shares);
  for (const pid of ids) { out[pid] = Math.floor(c.to_minor * shares[pid] / total); given += out[pid]; }
  const remainder = c.to_minor - given;
  if (remainder > 0 && ids.length) {
    const target = t.remainder_to && ids.find((pid) => pid === t.remainder_to) ? t.remainder_to
      : ids.reduce((a, b) => (shares[a] >= shares[b] ? a : b));
    out[target] += remainder;
  }
  return out;
}
