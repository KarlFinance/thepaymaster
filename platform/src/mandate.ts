/**
 * Authority to act for a sender.
 *
 * The sender remains the one who sends the money — that never moves. What a
 * mandate covers is the paperwork around it: naming the transaction, listing
 * who is to be paid and how much, and correcting those while it is being put
 * together. A sender who finds the setup daunting can talk it through with us
 * and have us enter it, which is a normal way to work and should be supported
 * properly rather than done quietly.
 *
 * Three things make it a record rather than a courtesy:
 *
 *   The sender is shown the exact words and signs them. Not a reference to
 *   terms held elsewhere, not a checkbox against a summary — the wording that
 *   goes into the dossier is the wording they read.
 *
 *   The limits are explicit, and enforced. A mandate cannot authorise moving
 *   funds, because nothing we hold could move them; it cannot authorise
 *   proving control of a wallet, because that would defeat the point of the
 *   proof; and it cannot authorise KYC on somebody's behalf.
 *
 *   It can be withdrawn at any moment, by them or by us, and the withdrawal is
 *   as permanent a part of the record as the signing was.
 */

import { type Env, type Actor, id, insert, update, log } from "./db.ts";

export type Scope = "prepare";

export interface Mandate {
  id: string;
  transaction_id: string;
  party_id: string;
  wording: string;
  scope: string;
  requested_at: string;
  method: string | null;
  signed_name: string | null;
  signed_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

/**
 * What the sender is asked to agree to.
 *
 * Written to be read by the person signing it, not by a lawyer defending it
 * afterwards — though it should survive that too. The limits are stated as
 * plainly as the permission, because a mandate that only lists what we may do
 * invites the reader to assume the rest.
 */
export function wording(opts: {
  senderName: string; ref: string; company: string;
}): string {
  return [
    `Authority to prepare transaction ${opts.ref}`,
    ``,
    `I am ${opts.senderName}, the sender on transaction ${opts.ref}.`,
    ``,
    `I ask ThePaymaster Ltd to prepare this transaction for me. That means`,
    `they may, on my instruction:`,
    ``,
    `  - name the transaction and record what it is for;`,
    `  - enter the recipients, their contact details and the amount each is`,
    `    to receive;`,
    `  - correct any of the above while the transaction is being prepared.`,
    ``,
    `I understand that they may not, under this authority:`,
    ``,
    `  - move, hold or take custody of my funds at any point;`,
    `  - send any payment — every transfer is made by me, from my own wallet,`,
    `    and signed by me;`,
    `  - prove control of any wallet on my behalf;`,
    `  - complete identity checks in my name, or in anyone else's.`,
    ``,
    `I will review the finished transaction and every recipient and amount in`,
    `it before I send anything. Nothing is sent unless I send it.`,
    ``,
    `I may withdraw this authority at any time, in my account or by telling`,
    `${opts.company} in writing. Withdrawing it does not undo anything already`,
    `done, but they will stop acting for me at once.`,
  ].join("\n");
}

/** Ask a sender for authority. Nothing is granted until they sign it. */
export async function request(env: Env, actor: Actor, opts: {
  transactionId: string; partyId: string; senderName: string; ref: string;
}): Promise<string> {
  const rowId = id("man");
  await insert(env.DB, actor, "mandate.requested", "mandates", rowId, {
    transaction_id: opts.transactionId,
    party_id: opts.partyId,
    wording: wording({
      senderName: opts.senderName, ref: opts.ref, company: "ThePaymaster Ltd",
    }),
    scope: "prepare",
    requested_by: actor.id,
  }, { note: `authority to prepare ${opts.ref} asked of ${opts.senderName}` });
  return rowId;
}

/**
 * The sender signs.
 *
 * The typed name is checked against the name on their record, loosely — people
 * type "R Lovell" for "Ray Lovell" — but it has to be theirs. A blank or a
 * stranger's name is refused, because a signature nobody can attribute is not
 * a signature.
 */
export async function sign(env: Env, actor: Actor, mandateId: string, opts: {
  typedName: string; ip?: string; agent?: string;
}): Promise<string | null> {
  const m = await env.DB.prepare("SELECT * FROM mandates WHERE id = ?")
    .bind(mandateId).first<any>();
  if (!m) return "No such authority.";
  if (m.signed_at) return "That authority has already been signed.";
  if (m.revoked_at) return "That authority has been withdrawn.";

  const party = await env.DB.prepare("SELECT display_name FROM parties WHERE id = ?")
    .bind(m.party_id).first<any>();
  const typed = opts.typedName.trim();
  if (typed.length < 3) return "Please type your full name to sign.";
  if (!resembles(typed, String(party?.display_name ?? ""))) {
    return `Please sign with your own name, as we hold it: ${party?.display_name}.`;
  }

  await update(env.DB, actor, "mandate.signed", "mandates", mandateId, {
    method: "typed",
    signed_name: typed,
    signed_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    signed_ip: opts.ip ?? null,
    signed_agent: (opts.agent ?? "").slice(0, 200) || null,
  }, { signed_at: null }, { note: `signed by ${typed}` });
  return null;
}

/**
 * Is this typed name plausibly the party's own?
 *
 * Deliberately forgiving about form and strict about identity: initials,
 * middle names and different orderings pass; a different surname does not.
 */
export function resembles(typed: string, onRecord: string): boolean {
  // Hyphens separate as well as join: somebody recorded as Vasquez who signs
  // Vasquez-Smith is still the same person, and a married name should not be
  // a reason to refuse a signature.
  const words = (s: string) => s.toLowerCase()
    .replace(/[^a-z\s'-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 1);
  const a = words(typed), b = words(onRecord);
  if (!a.length || !b.length) return false;
  // The last word on the record — usually the surname — must be present.
  return a.includes(b[b.length - 1]);
}

/** The authority that currently stands, if any. */
export async function standing(env: Env, transactionId: string): Promise<Mandate | null> {
  return env.DB.prepare(
    `SELECT * FROM mandates
      WHERE transaction_id = ? AND signed_at IS NOT NULL AND revoked_at IS NULL
      ORDER BY signed_at DESC, rowid DESC LIMIT 1`)
    .bind(transactionId).first<Mandate>();
}

/** Everything ever asked for or granted on this transaction. */
export async function history(env: Env, transactionId: string): Promise<Mandate[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM mandates WHERE transaction_id = ? ORDER BY rowid DESC")
    .bind(transactionId).all<any>();
  return (results ?? []) as Mandate[];
}

/** Withdrawn — by the sender, or by us. */
export async function revoke(env: Env, actor: Actor, mandateId: string,
                             reason: string): Promise<string | null> {
  const m = await env.DB.prepare("SELECT signed_at, revoked_at FROM mandates WHERE id = ?")
    .bind(mandateId).first<any>();
  if (!m) return "No such authority.";
  if (m.revoked_at) return null;   // already withdrawn; nothing to do
  await update(env.DB, actor, "mandate.withdrawn", "mandates", mandateId, {
    revoked_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    revoked_by: actor.id,
    revoked_reason: reason.trim() || null,
  }, { revoked_at: null }, { note: reason.trim() || "withdrawn" });
  return null;
}

/**
 * Record that staff did something under a mandate.
 *
 * The ordinary audit entry already says which admin acted. This says who they
 * were acting for, which is the part a reader will want and cannot infer.
 */
export async function actedUnder(env: Env, actor: Actor, m: Mandate,
                                 what: string): Promise<void> {
  await log(env.DB, actor, "mandate.acted", "mandates", m.id,
    { note: `${what} — acting for the sender under authority signed ${m.signed_at}` });
}
