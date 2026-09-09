/**
 * Accepting an address without a signature.
 *
 * The rule everywhere else is that a wallet is paid only once its key has
 * signed for it. An exchange deposit address has no key the recipient can
 * use, so the rule as written excludes everyone who wants paying straight
 * into Binance or Kraken — which is a lot of recipients.
 *
 * The alternative is a person. A member of staff looks at evidence that the
 * address belongs to the recipient's account at a named custodian — a
 * screenshot of the deposit page with the account holder's name on it, a
 * letter from the exchange — and records that they did, with the evidence
 * attached and their name on the record. The dossier says, in plain words,
 * that this address was accepted on that basis and not by signature.
 *
 * What it does not change: the dust test still goes first, screening still
 * has to be clean, the destination still has to be confirmed and locked, and
 * a changed address voids the attestation as it voids a signature.
 */

import { type Env, type Actor, id, insert, update } from "./db.ts";
import { store, DocumentProblem } from "./documents.ts";
import { staffCannotSign, addressAttested } from "./notify.ts";

export interface Attestation {
  id: string;
  destination_id: string;
  address: string;
  custodian: string;
  basis: string;
  evidence_artefact: string | null;
  granted_by: string;
  granted_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** The attestation that currently covers this destination's address, if any. */
export async function standing(env: Env, dest: { id: string; address: string | null }):
    Promise<Attestation | null> {
  if (!dest.address) return null;
  return env.DB.prepare(
    `SELECT * FROM address_attestations
      WHERE destination_id = ? AND revoked_at IS NULL AND lower(address) = lower(?)
      ORDER BY granted_at DESC LIMIT 1`).bind(dest.id, dest.address).first<Attestation>();
}

/**
 * Whether a destination counts as proved — by its key, or by a person.
 *
 * The one definition, used by the gate, the send plan, the journey and the
 * dossier, so they cannot disagree about it.
 */
export async function proved(env: Env, dest: { id: string; address: string | null; proved_at: string | null } | null):
    Promise<{ ok: boolean; how: "signature" | "attested" | null; attestation: Attestation | null }> {
  if (!dest) return { ok: false, how: null, attestation: null };
  if (dest.proved_at) return { ok: true, how: "signature", attestation: null };
  const a = await standing(env, dest);
  return a ? { ok: true, how: "attested", attestation: a } : { ok: false, how: null, attestation: null };
}

/** The recipient says they cannot sign from this address. Staff are told. */
export async function cannotSign(env: Env, actor: Actor, destinationId: string,
                                 note: string): Promise<string | null> {
  const d = await env.DB.prepare("SELECT * FROM destinations WHERE id = ?")
    .bind(destinationId).first<any>();
  if (!d) return "No such destination.";
  if (d.kind !== "wallet" || !d.address) return "There is no wallet address to speak of yet.";
  if (d.proved_at) return "This address has already been proved by signature.";
  const clean = note.trim().slice(0, 500);
  await update(env.DB, actor, "destination.proof_unavailable", "destinations", destinationId, {
    proof_unavailable_at: stamp(),
    proof_unavailable_note: clean || null,
  }, { proof_unavailable_at: d.proof_unavailable_at ?? null,
       proof_unavailable_note: d.proof_unavailable_note ?? null },
     { note: clean || "cannot sign" });
  await staffCannotSign(env, actor, destinationId, clean);
  return null;
}

/**
 * A member of staff accepts the address on evidence.
 *
 * Evidence is required, not optional: an attestation with nothing behind it
 * is a person's say-so, and the point of the dossier is that nothing in it is
 * anyone's say-so.
 */
export async function grant(env: Env, actor: Actor, opts: {
  destinationId: string; custodian: string; basis: string; evidence: File | null;
}): Promise<string | null> {
  const d = await env.DB.prepare(
    `SELECT d.*, p.transaction_id, p.party_id FROM destinations d
       JOIN participations p ON p.id = d.participation_id WHERE d.id = ?`)
    .bind(opts.destinationId).first<any>();
  if (!d) return "No such destination.";
  if (d.kind !== "wallet" || !d.address) return "There is no wallet address to attest to.";
  if (d.proved_at) return "This address is already proved by signature; nothing to attest.";
  if (d.status === "draft") return "The recipient has not confirmed this address yet. Attest to what they have confirmed, not what they have typed.";
  if (!actor.id) return "Only a signed-in member of staff can do this.";
  const custodian = opts.custodian.trim().slice(0, 80);
  const basis = opts.basis.trim().slice(0, 1000);
  if (!custodian) return "Name the custodian — the exchange or service that holds the key.";
  if (basis.length < 20) return "Say what you saw, in a sentence: what the evidence is and how it ties the address to this recipient.";
  if (await standing(env, d)) return "This address is already attested.";

  let evidence: string | null = null;
  try {
    const stored = await store(env, actor, opts.evidence as File, {
      kind: "address_evidence",
      label: `Evidence for ${d.address} at ${custodian}`,
      transactionId: d.transaction_id,
    });
    evidence = stored.artefactId;
  } catch (err) {
    if (err instanceof DocumentProblem) return `Evidence is required. ${err.message}`;
    throw err;
  }

  const attId = id("att");
  await insert(env.DB, actor, "address.attested", "address_attestations", attId, {
    destination_id: d.id,
    address: d.address,
    custodian,
    basis,
    evidence_artefact: evidence,
    granted_by: actor.id,
    granted_at: stamp(),
  }, { note: `${custodian} — ${d.address}` });
  await addressAttested(env, actor, attId);
  return null;
}

/** Withdraw it. The attestation stays in the record, marked revoked. */
export async function revoke(env: Env, actor: Actor, attestationId: string,
                             reason: string): Promise<string | null> {
  const a = await env.DB.prepare("SELECT * FROM address_attestations WHERE id = ?")
    .bind(attestationId).first<Attestation>();
  if (!a) return "No such attestation.";
  if (a.revoked_at) return "Already revoked.";
  if (!actor.id) return "Only a signed-in member of staff can do this.";
  const why = reason.trim().slice(0, 500);
  if (!why) return "Say why it is being withdrawn.";
  await update(env.DB, actor, "address.attestation_revoked", "address_attestations", attestationId, {
    revoked_by: actor.id, revoked_at: stamp(), revoke_reason: why,
  }, { revoked_by: null, revoked_at: null, revoke_reason: null }, { note: why });
  return null;
}

/** Every attestation on a transaction, for the admin page and the dossier. */
export async function forTransaction(env: Env, txId: string): Promise<Attestation[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.* FROM address_attestations a
       JOIN destinations d ON d.id = a.destination_id
       JOIN participations p ON p.id = d.participation_id
      WHERE p.transaction_id = ? ORDER BY a.granted_at`).bind(txId).all<Attestation>();
  return results ?? [];
}
