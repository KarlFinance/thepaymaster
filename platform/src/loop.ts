/**
 * The return loop.
 *
 * Every party who has been through a distribution is a verified, screened,
 * address-proved person with a clearance on file. That is the asset, and
 * these are the three ways it compounds:
 *
 *   clone      — a sender runs the same distribution again: same recipients,
 *                same shares, addresses and proofs carried over; only the
 *                amount and the fresh checks (screening, locking) remain
 *   startOwn   — a recipient becomes a sender in one click: a draft with them
 *                as sender and a start link straight into the form they know
 *   counterparties — a sender's address book: who they have paid, whether each
 *                is still cleared, the locked address, when last paid
 *
 * What is carried and what is not is deliberate. Identity clearances already
 * live on the party and expire on their own. An address a recipient proved
 * control of is still theirs, so the proof is carried with its date; but it
 * arrives *confirmed*, not locked — staff lock it again after screening,
 * because screening is only good for a week and the lock is our act, not
 * the recipient's.
 */

import { type Env, type Actor, id, nextRef, insert, update, log } from "./db.ts";
import { mint } from "./tokens.ts";
import { staffCloned, staffStartedOwn } from "./notify.ts";

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/**
 * transactions.created_by must name an admin. When a party starts one from
 * their own account the platform is the creator; the audit line names the
 * party. The row exists from migration 0026.
 */
export const SYSTEM_ADMIN = "adm_system";

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export async function cloneTransaction(env: Env, actor: Actor, sourceId: string,
                                       o: { requestedBy: "party" | "admin"; partyId?: string }):
    Promise<{ id: string; ref: string } | { problem: string }> {
  const src = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(sourceId).first<any>();
  if (!src) return { problem: "No such transaction." };
  if (!["settled", "closed"].includes(String(src.status))) {
    return { problem: "Only a completed distribution can be run again." };
  }
  if (o.requestedBy === "party") {
    const sender = await env.DB.prepare(
      "SELECT 1 FROM participations WHERE transaction_id = ? AND party_id = ? AND role = 'sender'")
      .bind(sourceId, o.partyId ?? "").first();
    if (!sender) return { problem: "Only the sender can run a distribution again." };
  }

  const txId = id("tx");
  const ref = await nextRef(env.DB);
  await insert(env.DB, actor, "transaction.created", "transactions", txId, {
    ref, name: `${src.name} — again`, detail: `Repeat of ${src.ref}.${src.detail ? ` ${src.detail}` : ""}`,
    inbound: src.inbound, outbound: src.outbound, converts: src.converts,
    currency_in: src.currency_in, currency_out: src.currency_out,
    decimals_in: src.decimals_in, decimals_out: src.decimals_out,
    fee_bps: src.fee_bps, fee_mode: src.fee_mode, remainder_to: src.remainder_to,
    acting_for: src.acting_for, rail: src.rail, chain_id: src.chain_id,
    token_address: src.token_address, fee_wallet: src.fee_wallet,
    // The amount is the one thing that is almost always different. Left
    // blank, so the gate says so until somebody sets it.
    gross_expected_minor: null,
    status: "draft", created_by: actor.kind === "admin" ? actor.id : SYSTEM_ADMIN,
    // Cloned from a finished transaction by the sender or by staff: the roster
    // is already known, so it is submitted as it is born, ready to release.
    submitted_at: stamp(), submitted_by: `cloned from ${src.ref}`,
  }, { note: `cloned from ${src.ref} by ${o.requestedBy}` });
  await log(env.DB, actor, "transaction.cloned", "transactions", sourceId, { note: `into ${ref}` });

  const { results: parts } = await env.DB.prepare(
    `SELECT p.*, d.kind AS dkind, d.address, d.chain AS dchain, d.account_name, d.account_number, d.sort_code,
            d.iban, d.bic, d.bank_name, d.bank_country, d.proved_at, d.proof_signature, d.status AS dstatus
       FROM participations p LEFT JOIN destinations d ON d.participation_id = p.id
      WHERE p.transaction_id = ?`).bind(sourceId).all<any>();

  for (const p of parts ?? []) {
    const pid = id("par");
    await insert(env.DB, actor, "participation.added", "participations", pid, {
      transaction_id: txId, party_id: p.party_id, role: p.role,
      amount_minor: p.role === "recipient" && src.fee_mode === "grossed_up" ? p.amount_minor : null,
      share_bps: p.share_bps,
    }, { note: `carried from ${src.ref}` });

    // A locked destination from the last run comes across confirmed, with the
    // proof and its date, for staff to screen and lock again.
    if (p.role === "recipient" && p.dkind && p.dstatus === "locked") {
      await insert(env.DB, actor, "destination.saved", "destinations", id("dst"), {
        participation_id: pid, kind: p.dkind,
        account_name: p.account_name, account_number: p.account_number, sort_code: p.sort_code,
        iban: p.iban, bic: p.bic, bank_name: p.bank_name, bank_country: p.bank_country,
        chain: p.dchain, address: p.address,
        status: "confirmed", confirmed_at: stamp(),
        confirmed_via: `carried from ${src.ref}, where it was confirmed and locked`,
        proved_at: p.proved_at, proof_signature: p.proof_signature, proof_nonce: null,
      }, { note: `carried from ${src.ref}${p.proved_at ? `, proved ${String(p.proved_at).slice(0, 10)}` : ""}` });
    }
  }

  const { results: wallets } = await env.DB.prepare(
    "SELECT * FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL").bind(sourceId).all<any>();
  for (const w of wallets ?? []) {
    await insert(env.DB, actor, "sending_wallet.added", "sending_wallets", id("sw"), {
      transaction_id: txId, party_id: w.party_id, chain: w.chain, address: w.address,
      label: w.label ?? null, proved_at: w.proved_at, proof: w.proof, proof_nonce: null,
    }, { note: `carried from ${src.ref}` });
  }

  await staffCloned(env, actor, txId, src.ref, o.requestedBy);
  return { id: txId, ref };
}

// ---------------------------------------------------------------------------
// A recipient starts their own
// ---------------------------------------------------------------------------

export async function startOwn(env: Env, actor: Actor, partyId: string, base: string):
    Promise<{ url: string; ref: string } | { problem: string }> {
  const party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(partyId).first<any>();
  if (!party) return { problem: "No such party." };

  // Their most recent transaction sets the shape: same rail, same token, same fee wallet.
  const last = await env.DB.prepare(
    `SELECT t.* FROM transactions t JOIN participations p ON p.transaction_id = t.id
      WHERE p.party_id = ? ORDER BY t.created_at DESC LIMIT 1`).bind(partyId).first<any>();

  const txId = id("tx");
  const ref = await nextRef(env.DB);
  await insert(env.DB, actor, "transaction.created", "transactions", txId, {
    ref, name: `${party.display_name}'s distribution`, detail: "Started by the sender from their own account.",
    inbound: last?.inbound ?? "crypto", outbound: last?.outbound ?? "crypto", converts: last?.converts ?? 0,
    currency_in: last?.currency_in ?? "USDT", currency_out: last?.currency_out ?? "USDT",
    decimals_in: last?.decimals_in ?? 6, decimals_out: last?.decimals_out ?? 6,
    fee_bps: last?.fee_bps ?? 100, fee_mode: last?.fee_mode ?? "deducted",
    acting_for: "payer", rail: last?.rail ?? null, chain_id: last?.chain_id ?? null,
    token_address: last?.token_address ?? null, fee_wallet: last?.fee_wallet ?? null,
    status: "draft", created_by: actor.kind === "admin" ? actor.id : SYSTEM_ADMIN,
  }, { note: `started by ${party.display_name} from their account` });

  const { url } = await mint(env, actor, { purpose: "start", email: party.email, base, transactionId: txId });
  await log(env.DB, actor, "transaction.start_link_sent", "transactions", txId, { note: `self-service, to ${party.email}` });
  await staffStartedOwn(env, actor, txId, party.display_name);
  return { url, ref };
}

// ---------------------------------------------------------------------------
// The address book
// ---------------------------------------------------------------------------

export interface Counterparty {
  partyId: string; name: string; email: string;
  transactions: number; lastRef: string; lastPaidAt: string | null; lastAmountMinor: number | null;
  currency: string | null; decimals: number;
  cleared: boolean; clearedUntil: string | null;
  address: string | null; addressProved: boolean;
}

/** Everyone this party has paid, across every distribution they have sent. */
export async function counterparties(env: Env, senderPartyId: string): Promise<Counterparty[]> {
  const { results } = await env.DB.prepare(
    `SELECT y.id AS party_id, y.display_name, y.email,
            count(DISTINCT r.transaction_id) AS transactions,
            (SELECT t.ref FROM transactions t JOIN participations rr ON rr.transaction_id = t.id
              WHERE rr.party_id = y.id AND rr.role = 'recipient'
                AND t.id IN (SELECT transaction_id FROM participations WHERE party_id = ? AND role = 'sender')
              ORDER BY t.created_at DESC LIMIT 1) AS last_ref,
            (SELECT c.occurred_at FROM custody_events c JOIN payout_legs l ON l.event_id = c.id
              JOIN participations rr ON rr.id = l.participation_id
              WHERE rr.party_id = y.id AND c.event = 'sent'
                AND c.transaction_id IN (SELECT transaction_id FROM participations WHERE party_id = ? AND role = 'sender')
              ORDER BY c.occurred_at DESC LIMIT 1) AS last_paid_at,
            (SELECT c.amount_minor FROM custody_events c JOIN payout_legs l ON l.event_id = c.id
              JOIN participations rr ON rr.id = l.participation_id
              WHERE rr.party_id = y.id AND c.event = 'sent'
                AND c.transaction_id IN (SELECT transaction_id FROM participations WHERE party_id = ? AND role = 'sender')
              ORDER BY c.occurred_at DESC LIMIT 1) AS last_amount,
            (SELECT t.currency_out FROM transactions t JOIN participations rr ON rr.transaction_id = t.id
              WHERE rr.party_id = y.id AND rr.role = 'recipient' ORDER BY t.created_at DESC LIMIT 1) AS currency,
            (SELECT t.decimals_out FROM transactions t JOIN participations rr ON rr.transaction_id = t.id
              WHERE rr.party_id = y.id AND rr.role = 'recipient' ORDER BY t.created_at DESC LIMIT 1) AS decimals,
            (SELECT v.expires_at FROM verifications v WHERE v.party_id = y.id AND v.status = 'passed'
              ORDER BY v.verified_at DESC LIMIT 1) AS cleared_until,
            (SELECT d.address FROM destinations d JOIN participations rr ON rr.id = d.participation_id
              WHERE rr.party_id = y.id AND d.status = 'locked' ORDER BY d.locked_at DESC LIMIT 1) AS address,
            (SELECT d.proved_at IS NOT NULL FROM destinations d JOIN participations rr ON rr.id = d.participation_id
              WHERE rr.party_id = y.id AND d.status = 'locked' ORDER BY d.locked_at DESC LIMIT 1) AS proved
       FROM participations r
       JOIN parties y ON y.id = r.party_id
      WHERE r.role = 'recipient'
        AND r.transaction_id IN (SELECT transaction_id FROM participations WHERE party_id = ? AND role = 'sender')
      GROUP BY y.id ORDER BY y.display_name`)
    .bind(senderPartyId, senderPartyId, senderPartyId, senderPartyId).all<any>();
  const now = stamp();
  return (results ?? []).map((r: any) => ({
    partyId: r.party_id, name: r.display_name, email: r.email,
    transactions: Number(r.transactions), lastRef: r.last_ref ?? "", lastPaidAt: r.last_paid_at ?? null,
    lastAmountMinor: r.last_amount ?? null, currency: r.currency ?? null, decimals: Number(r.decimals ?? 2),
    cleared: Boolean(r.cleared_until) && (r.cleared_until === null || String(r.cleared_until) > now),
    clearedUntil: r.cleared_until ?? null,
    address: r.address ?? null, addressProved: Boolean(r.proved),
  }));
}
