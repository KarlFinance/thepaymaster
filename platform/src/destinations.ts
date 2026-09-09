/**
 * Where each recipient's money goes.
 *
 * This is where funds get stolen if they get stolen anywhere. The attack is
 * dull and extremely common: compromise a recipient's mailbox, wait, then
 * change an account number late in the day when everyone is busy. So the
 * lifecycle is deliberate rather than convenient.
 *
 *   draft      the recipient has typed it in and can still change it freely
 *   confirmed  they have read it back and confirmed it deliberately
 *   locked     we have accepted it; changing it now takes two of us and the
 *              sender is told
 *
 * A recipient supplies bank details or a wallet according to the transaction's
 * outbound leg, and never both. Nobody but the recipient enters their own
 * destination — a sender who offers to supply someone else's account details
 * is describing the fraud, not avoiding it.
 */

import { type Env, type Actor, id, log, insert, update } from "./db.ts";
import { addressLocked } from "./notify.ts";
import { esc } from "./views.ts";

export type Kind = "bank" | "wallet";

export interface Destination {
  id: string;
  participation_id: string;
  kind: Kind;
  status: "draft" | "confirmed" | "locked";
  account_name?: string | null;
  account_number?: string | null;
  sort_code?: string | null;
  iban?: string | null;
  bic?: string | null;
  bank_name?: string | null;
  bank_country?: string | null;
  chain?: string | null;
  address?: string | null;
  confirmed_at?: string | null;
  confirmed_via?: string | null;
  locked_at?: string | null;
}

export async function forParticipation(env: Env, participationId: string):
    Promise<Destination | null> {
  return env.DB.prepare("SELECT * FROM destinations WHERE participation_id = ?")
    .bind(participationId).first<Destination>();
}

// ---------------------------------------------------------------------------
// Checking what was typed
// ---------------------------------------------------------------------------

/**
 * Sanity checks only. These catch typing mistakes, not lies — a well-formed
 * IBAN belonging to the wrong person passes every one of them, which is why
 * the confirmation step and the lock exist.
 */
export function problemWith(kind: Kind, d: Partial<Destination>): string | null {
  if (kind === "bank") {
    if (!d.account_name?.trim()) return "We need the name on the account.";
    if (!d.bank_name?.trim()) return "We need the name of the bank.";
    if (!d.bank_country?.trim()) return "We need the country the account is held in.";

    const iban = (d.iban ?? "").replace(/\s/g, "").toUpperCase();
    const acct = (d.account_number ?? "").replace(/\s/g, "");
    const sort = (d.sort_code ?? "").replace(/[\s-]/g, "");

    if (!iban && !acct) {
      return "We need either an IBAN, or an account number and sort code.";
    }
    if (iban) {
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) {
        return "That IBAN does not look right — two letters, two digits, then the account.";
      }
      if (!ibanChecksum(iban)) {
        return "That IBAN fails its own check digits. Worth reading it again.";
      }
    }
    if (acct && !iban) {
      if (!/^\d{6,17}$/.test(acct)) return "An account number should be digits only.";
      if (!/^\d{6}$/.test(sort)) return "A sort code should be six digits.";
    }
    return null;
  }

  const address = (d.address ?? "").trim();
  if (!d.chain?.trim()) return "We need to know which chain.";
  if (!address) return "We need the wallet address.";
  // Only the shape is checked. Whether it is theirs is settled by proof of
  // control, not by pattern matching.
  if (/^0x/i.test(address)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return "An Ethereum-style address is 0x followed by forty hex characters.";
    }
  } else if (address.length < 26 || address.length > 62 || /\s/.test(address)) {
    return "That does not look like a wallet address.";
  }
  return null;
}

/**
 * The IBAN check digits, per ISO 13616: move the first four characters to the
 * end, turn letters into numbers, and the whole thing mod 97 must be 1.
 *
 * It is the one check here that catches a transposed pair of digits, which is
 * the single most common way an account number is got wrong.
 */
export function ibanChecksum(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of part) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** What the recipient reads back before confirming. Never abbreviated. */
export function describe(d: Destination): string {
  if (d.kind === "bank") {
    const lines = [
      `Name on the account: ${d.account_name}`,
      `Bank: ${d.bank_name}, ${d.bank_country}`,
    ];
    if (d.iban) lines.push(`IBAN: ${d.iban}`);
    if (d.account_number) lines.push(`Account: ${d.account_number}`);
    if (d.sort_code) lines.push(`Sort code: ${d.sort_code}`);
    if (d.bic) lines.push(`BIC: ${d.bic}`);
    return lines.join("\n");
  }
  return `Chain: ${d.chain}\nAddress: ${d.address}`;
}

// ---------------------------------------------------------------------------
// Changing it
// ---------------------------------------------------------------------------

export async function save(env: Env, actor: Actor, participationId: string,
                           kind: Kind, fields: Partial<Destination>): Promise<string | null> {
  const problem = problemWith(kind, fields);
  if (problem) return problem;

  const existing = await forParticipation(env, participationId);
  if (existing?.status === "locked") {
    return "These details are locked. Ask us to change them — it takes two of us and the sender is told.";
  }

  const row = {
    participation_id: participationId,
    kind,
    account_name: fields.account_name?.trim() || null,
    account_number: (fields.account_number ?? "").replace(/\s/g, "") || null,
    sort_code: (fields.sort_code ?? "").replace(/[\s-]/g, "") || null,
    iban: (fields.iban ?? "").replace(/\s/g, "").toUpperCase() || null,
    bic: (fields.bic ?? "").replace(/\s/g, "").toUpperCase() || null,
    bank_name: fields.bank_name?.trim() || null,
    bank_country: fields.bank_country?.trim() || null,
    chain: fields.chain?.trim() || null,
    address: fields.address?.trim() || null,
    // Any edit drops it back to draft: a confirmation applies to what was
    // confirmed, not to whatever the row says later.
    status: "draft",
    confirmed_at: null,
    confirmed_via: null,

    // And the proof goes with it. A signature proves control of the address
    // that was signed for; carrying it over to a new address would leave the
    // record asserting something nobody ever demonstrated, and would satisfy
    // the readiness gate for a wallet that had never been proved at all. The
    // nonce is cleared too, so the next challenge is a fresh one and an old
    // signature cannot be replayed against it.
    proved_at: null,
    proof_signature: null,
    proof_nonce: null,
    // What they said about the old address is about the old address. Any
    // attestation is keyed to the address text and lapses by itself.
    proof_unavailable_at: null,
    proof_unavailable_note: null,
  };

  if (existing) {
    await update(env.DB, actor, "destination.changed", "destinations", existing.id,
      row, existing as unknown as Record<string, unknown>);
  } else {
    await insert(env.DB, actor, "destination.given", "destinations", id("dst"), row);
  }
  return null;
}

/** The recipient reads it back and says yes. */
export async function confirm(env: Env, actor: Actor, destinationId: string,
                              via: string): Promise<void> {
  const before = await env.DB.prepare("SELECT status, confirmed_at FROM destinations WHERE id = ?")
    .bind(destinationId).first<any>();
  await update(env.DB, actor, "destination.confirmed", "destinations", destinationId, {
    status: "confirmed",
    confirmed_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    confirmed_via: via,
  }, before ?? {}, { note: via });
}

/** We accept it. After this it takes two of us to change. */
export async function lock(env: Env, actor: Actor, destinationId: string): Promise<string | null> {
  const d = await env.DB.prepare("SELECT * FROM destinations WHERE id = ?")
    .bind(destinationId).first<Destination>();
  if (!d) return "No such destination.";
  if (d.status === "draft") {
    return "The recipient has not confirmed these details yet.";
  }
  if (d.status === "locked") return null;
  await update(env.DB, actor, "destination.locked", "destinations", destinationId, {
    status: "locked",
    locked_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  }, { status: d.status, locked_at: d.locked_at ?? null });
  await addressLocked(env, actor, destinationId);
  return null;
}

/**
 * Ask to change a locked destination.
 *
 * Deliberately a request rather than an edit. One person proposes with a
 * reason, a second approves, and the sender is told — because the whole point
 * of locking was that a single compromised account should not be able to
 * redirect money.
 */
export async function requestChange(env: Env, actor: Actor, destinationId: string,
                                    after: Partial<Destination>, reason: string): Promise<string> {
  const before = await env.DB.prepare("SELECT * FROM destinations WHERE id = ?")
    .bind(destinationId).first<any>();
  const changeId = id("chg");
  await insert(env.DB, actor, "destination.change_requested", "destination_changes", changeId, {
    destination_id: destinationId,
    before_json: JSON.stringify(before ?? {}),
    after_json: JSON.stringify(after),
    reason,
    requested_by: actor.id,
  }, { note: reason });
  return changeId;
}

export async function approveChange(env: Env, actor: Actor, changeId: string):
    Promise<string | null> {
  const c = await env.DB.prepare("SELECT * FROM destination_changes WHERE id = ?")
    .bind(changeId).first<any>();
  if (!c) return "No such request.";
  if (c.approved_at) return "That has already been approved.";
  if (c.requested_by === actor.id) {
    return "The person who asked for a change cannot also approve it. That is the point of it.";
  }

  const after = JSON.parse(c.after_json);
  const before = await env.DB.prepare("SELECT * FROM destinations WHERE id = ?")
    .bind(c.destination_id).first<any>();

  await update(env.DB, actor, "destination.changed_after_lock", "destinations",
    c.destination_id, {
      ...after,
      // A changed destination is not a confirmed one. The recipient reads the
      // new details back before it can be locked again.
      status: "draft", confirmed_at: null, confirmed_via: null, locked_at: null,
    }, before ?? {}, { note: `approved change ${changeId}: ${c.reason}` });

  await update(env.DB, actor, "destination.change_approved", "destination_changes",
    changeId, {
      approved_by: actor.id,
      approved_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    }, { approved_by: null, approved_at: null });
  return null;
}

/** Everything on a transaction, with who it belongs to. */
export async function forTransaction(env: Env, transactionId: string) {
  const { results } = await env.DB.prepare(
    `SELECT d.*, p.role, p.amount_minor, y.display_name, y.email,
            p.id AS participation_id
       FROM participations p
       JOIN parties y ON y.id = p.party_id
       LEFT JOIN destinations d ON d.participation_id = p.id
      WHERE p.transaction_id = ? AND p.role = 'recipient'
      ORDER BY y.display_name`).bind(transactionId).all<any>();
  return results ?? [];
}
