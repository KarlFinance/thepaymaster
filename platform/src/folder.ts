/**
 * One party's folder.
 *
 * The dossier is the whole transaction, for us and for an auditor. A party
 * needs something smaller and sharper: the proof, years from now, of where
 * their crypto came from or where it went. That is this folder:
 *
 *   statement.pdf   — a statement of the transaction as it concerns them,
 *                     drawn from the sealed record: who they are and that we
 *                     verified them, what was paid to which address by whom,
 *                     the chain's transaction, the record's root and seal
 *   record.pdf      — their own entries from the record, each with the hashes
 *                     that prove it belongs to the sealed whole (and nothing
 *                     about anybody else)
 *   record.json     — the same, for a program to check
 *   documents/      — their identity documents and anything we chose to share
 *                     with them (a screening report, an agreement)
 *
 * A party downloads it from their own account; staff can download it for any
 * party to send on; and the main dossier bundle carries one per party, so a
 * compliance file has each person's folder ready-made.
 *
 * What a party gets versus what staff get differs in one respect only: the
 * documents. A party's own uploads are theirs; a document staff uploaded about
 * them is included only when it was marked to share.
 */

import { type Env } from "./db.ts";
import { Pdf } from "./pdf.ts";
import { ownRecord, seals, build, type Seal } from "./dossier.ts";
import { countryName } from "./countries.ts";
import { format } from "./money.ts";
import { railFor } from "./rail.ts";
import { standing as standingAttestation } from "./attest.ts";
import { legs as payoutLegs } from "./settlement.ts";
import { zip } from "./bundle.ts";
import { VERIFY_URL } from "./verify.ts";
import { attestationFor, type Attestation } from "./attestation.ts";

const MUTED = "0.353 0.420 0.502";
const GOOD = "0.106 0.498 0.294";
const WARN = "0.604 0.404 0.000";

const KIND_LABEL: Record<string, string> = {
  passport: "Passport or ID", proof_of_address: "Proof of address", kyc_report: "Screening report",
  address_evidence: "Evidence for an exchange address", company_register: "Company register extract",
  agency_agreement: "Agency agreement", otc_confirmation: "OTC confirmation", bank_statement: "Bank statement",
  incorporation: "Incorporation documents", other: "Document",
};
const labelFor = (a: any) => a.label ?? KIND_LABEL[a.kind] ?? String(a.kind ?? "Document").replace(/_/g, " ");
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._ -]+/g, "_").trim().replace(/\s+/g, "_").slice(0, 60) || "party";
const when = (s: string | null | undefined) => (s ? String(s).replace("T", " ").slice(0, 16) : "—");

export type Audience = "party" | "staff";

// ---------------------------------------------------------------------------
// What the folder is about
// ---------------------------------------------------------------------------

export interface FolderData {
  tx: any;
  party: any;
  role: string;
  participation: any | null;        // with destination columns joined
  verification: any | null;
  attestation: any | null;
  screen: any | null;
  payment: any | null;              // the recipient's leg
  fee: any | null;
  sender: any | null;
  senderWallets: any[];
  recipients: { name: string; address: string | null; amountMinor: number; txHash: string | null; sentAt: string | null }[];
  latestSeal: Seal | null;
  /** The root as the record stands now; equal to the seal's root only if nothing has been added since. */
  currentRoot: string;
  /** The party's source-of-funds narrative, latest version. */
  narrative: any | null;
  /** ThePaymaster's signature over the latest seal, when a key is configured. */
  sealSignature: Attestation | null;
  /** What the certification can say about everyone on the transaction. */
  everyone: { parties: number; unverified: string[]; unscreened: string[]; flagged: string[] };
  documents: any[];
  rail: ReturnType<typeof railFor>;
}

export async function folderData(env: Env, txId: string, partyId: string, audience: Audience): Promise<FolderData | null> {
  const q = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<any>()).results ?? [];
  const one = async (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<any>();

  const tx = await one("SELECT * FROM transactions WHERE id = ?", txId);
  const party = await one("SELECT * FROM parties WHERE id = ?", partyId);
  if (!tx || !party) return null;
  const parts = await q(
    `SELECT p.*, d.id AS destination_id, d.address, d.chain AS dest_chain, d.status AS dstatus,
            d.proved_at, d.locked_at, d.confirmed_at
       FROM participations p LEFT JOIN destinations d ON d.participation_id = p.id
      WHERE p.transaction_id = ? AND p.party_id = ?
      ORDER BY CASE p.role WHEN 'sender' THEN 0 ELSE 1 END`, txId, partyId);
  if (!parts.length) return null;
  const participation = parts[0];
  const role = String(participation.role);

  const verification = await one(
    `SELECT * FROM verifications WHERE party_id = ? AND status = 'passed'
      ORDER BY verified_at DESC LIMIT 1`, partyId);
  const attestation = participation.destination_id
    ? await standingAttestation(env, { id: participation.destination_id, address: participation.address }) : null;
  const screen = participation.address ? await one(
    `SELECT verdict, provider, screened_at FROM wallet_screens
      WHERE transaction_id = ? AND lower(address) = lower(?) ORDER BY screened_at DESC LIMIT 1`,
    txId, participation.address) : null;
  const payment = role === "recipient" ? await one(
    `SELECT c.amount_minor, c.currency, c.decimals, c.tx_hash, c.tx_block, c.occurred_at, c.tx_verified_at
       FROM custody_events c JOIN payout_legs l ON l.event_id = c.id
      WHERE l.participation_id = ? AND c.event = 'sent' ORDER BY c.occurred_at DESC LIMIT 1`,
    participation.id) : null;
  const fee = await one(
    `SELECT amount_minor, tx_hash, occurred_at FROM custody_events
      WHERE transaction_id = ? AND event = 'fee_taken' ORDER BY occurred_at DESC LIMIT 1`, txId);
  const sender = await one(
    `SELECT y.id, y.legal_name, y.display_name, y.kind, y.company_no,
            (SELECT verified_at FROM verifications v WHERE v.party_id = y.id AND v.status = 'passed'
              ORDER BY verified_at DESC LIMIT 1) AS verified_at
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ? AND p.role = 'sender' LIMIT 1`, txId);
  const senderWallets = await q(
    "SELECT address, chain, proved_at FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL ORDER BY created_at", txId);

  let recipients: FolderData["recipients"] = [];
  if (role === "sender") {
    const legRows = await payoutLegs(env, txId);
    for (const l of legRows) {
      const d = await one("SELECT address FROM destinations WHERE participation_id = ?", l.participationId);
      recipients.push({ name: l.name, address: d?.address ?? null, amountMinor: l.sentMinor ?? l.expectedMinor,
                        txHash: l.txHash, sentAt: l.sentAt });
    }
  }

  const history = await seals(env, txId);
  const currentRoot = (await build(env, txId)).root;
  const sealSignature = history[0] ? await attestationFor(env, history[0], tx.ref) : null;
  const narrative = await one(
    `SELECT * FROM narratives WHERE party_id = ? AND (transaction_id IS NULL OR transaction_id = ?)
      ORDER BY created_at DESC LIMIT 1`, partyId, txId);

  // The certification speaks for every named party, so it has to know about
  // every named party — not just this one.
  const everyoneRows = await q(
    `SELECT y.id, y.display_name, p.role,
            EXISTS (SELECT 1 FROM verifications v WHERE v.party_id = y.id AND v.status = 'passed'
                      AND (v.expires_at IS NULL OR v.expires_at > datetime('now'))) AS verified,
            (SELECT d.address FROM destinations d WHERE d.participation_id = p.id) AS address
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ?`, txId);
  const addresses: { who: string; address: string }[] = [];
  for (const r of everyoneRows) if (r.address) addresses.push({ who: r.display_name, address: r.address });
  for (const w of senderWallets) addresses.push({ who: sender?.display_name ?? "sender", address: w.address });
  const unscreened: string[] = [], flagged: string[] = [];
  for (const a of addresses) {
    const s = await one(`SELECT verdict FROM wallet_screens WHERE transaction_id = ? AND lower(address) = lower(?)
                          ORDER BY screened_at DESC LIMIT 1`, txId, a.address);
    if (!s) unscreened.push(a.who);
    else if (s.verdict !== "clear") flagged.push(`${a.who} (${s.verdict})`);
  }
  const everyone = {
    parties: everyoneRows.length,
    unverified: everyoneRows.filter((r: any) => !r.verified).map((r: any) => r.display_name),
    unscreened: [...new Set(unscreened)], flagged,
  };
  const docs = await q(
    `SELECT id, kind, label, filename, content_type, bytes, sha256, r2_key, uploaded_at, uploaded_by, shared_with_party
       FROM artefacts WHERE party_id = ? ORDER BY uploaded_at`, partyId);
  const documents = audience === "staff" ? docs
    : docs.filter((a: any) => a.uploaded_by === partyId || Number(a.shared_with_party) === 1);

  return { tx, party, role, participation, verification, attestation, screen, payment, fee, sender,
           senderWallets, recipients, latestSeal: history[0] ?? null, currentRoot, narrative, everyone,
           sealSignature, documents, rail: railFor(tx) };
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

/** Is there anything provisional left? A final statement needs the payment and the seal. */
export function statementStatus(d: FolderData): { final: boolean; why: string } {
  const paid = d.role === "recipient" ? Boolean(d.payment?.tx_hash)
    : d.recipients.length > 0 && d.recipients.every((r) => r.txHash);
  if (!paid) return { final: false, why: d.role === "recipient" ? "your payment has not yet been recorded" : "not every payment has been recorded" };
  if (!d.latestSeal) return { final: false, why: "the record has not yet been sealed" };
  if (d.latestSeal.root !== d.currentRoot) return { final: false, why: "the record has changed since it was sealed and will be sealed again" };
  return { final: true, why: "" };
}

export function statementPdf(d: FolderData, opts: { watermark?: string | null } = {}): Uint8Array {
  const { tx, party, rail } = d;
  const sym = rail.symbol, dec = rail.decimals;
  const money = (minor: number | null | undefined) => minor === null || minor === undefined ? "—" : `${format(Number(minor), dec)} ${sym}`;
  const status = statementStatus(d);
  const who = party.legal_name || party.display_name;
  const ref = `STM-${tx.ref}-${String(party.id).slice(-6).toUpperCase()}`;

  const pdf = new Pdf((p, n) => `ThePaymaster® — Counterparty Certification ${ref} — ${status.final ? "final" : "provisional"} — page ${p} of ${n}`, opts);

  pdf.heading("Counterparty Certification", 22);
  pdf.para(`${d.role === "recipient" ? "Statement of transaction" : "Statement of distribution"} — ${tx.ref}${tx.name ? ` — ${tx.name}` : ""}`,
    { face: "bold", size: 13, after: 2 });
  pdf.para(`Issued to ${who} by ThePaymaster Ltd, 167-169 The Fifth Floor, Great Portland Street, London W1W 5PF. ` +
    `Reference ${ref}. Every statement below is drawn from a record made at the time it happened; the record's ` +
    `root hash is printed at the end so that this document can be checked against it.`, { size: 9, colour: MUTED, after: 8 });
  if (status.final) pdf.status("FINAL — the transaction is complete and the record is sealed.", true);
  else pdf.para(`PROVISIONAL — ${status.why}. This certification will be reissued as final when the transaction is complete.`,
    { face: "bold", size: 10, colour: WARN, after: 8 });

  // --- what is certified -------------------------------------------------------
  const e = d.everyone;
  const clean = !e.unverified.length && !e.unscreened.length && !e.flagged.length;
  pdf.box([
    ["Certification", clean
      ? `ThePaymaster® certifies that all ${e.parties} named parties to ${tx.ref} have passed identity verification ` +
        `(KYC/KYB) and AML screening, and that every address involved has been screened, with no unresolved red flags ` +
        `as at the date of this document. Final acceptance remains at the receiving institution's discretion.`
      : `ThePaymaster® confirms the position as at the date of this document. Still outstanding: ` +
        [e.unverified.length ? `identity verification for ${e.unverified.join(", ")}` : "",
         e.unscreened.length ? `address screening for ${e.unscreened.join(", ")}` : "",
         e.flagged.length ? `screening not clear for ${e.flagged.join(", ")}` : ""].filter(Boolean).join("; ") +
        `. A certification is issued only when nothing is outstanding.`],
    ["Basis", `ThePaymaster® acted exclusively as the sender's agent under a distinct agency appointment for this ` +
      `transaction (Commercial Agent Exemption, paragraph 2(b), Schedule 1, Payment Services Regulations 2017). ` +
      (tx.inbound === "crypto" && tx.outbound === "crypto" && !tx.converts && tx.execution === "client_wallet"
        ? "The digital assets were received from the sender's proved wallet into a client wallet controlled by ThePaymaster Ltd, held on trust for the sender and used for nothing else, and paid from it to each recipient's proved wallet; every receipt and payment is verified on the public ledger by its transaction hash."
        : tx.inbound === "crypto" && tx.outbound === "crypto" && !tx.converts
        ? "The payments were executed by the sender from the sender's own wallet directly to each recipient; at no point were the funds held by ThePaymaster Ltd."
        : tx.inbound === "fiat" && tx.outbound === "fiat" && tx.fiat_payer === "sender"
        ? "The payments were made by the sender from the sender's own bank account directly to each recipient, under references issued by ThePaymaster and reconciled against the sender's bank statement; at no point were the funds held by ThePaymaster Ltd or in any account it operates."
        : "The funds were received into and paid from a client mandated account, segregated from ThePaymaster Ltd's own funds and used exclusively for this authorised distribution.")],
    ...(tx.summary ? [["Executive summary", String(tx.summary)] as [string, string]] : []),
  ], "What this certifies");

  // --- the party ------------------------------------------------------------
  pdf.heading(d.role === "recipient" ? "The recipient" : "The sender", 13);
  pdf.rule("0.106 0.141 0.188", 1);
  pdf.row("Name", who);
  if (party.kind === "company") {
    pdf.row("Registered number", party.company_no ?? "—");
    pdf.row("Incorporated in", party.incorporated_in ?? "—");
  } else {
    pdf.row("Nationality", countryName(party.nationality) || "—");
    pdf.row("Country of residence", countryName(party.residence_country) || "—");
  }
  if (d.verification) {
    pdf.row("Identity verified", `${when(d.verification.verified_at)} by ThePaymaster (${d.verification.provider ?? "staff"})` +
      (d.verification.expires_at ? `, clearance to ${String(d.verification.expires_at).slice(0, 10)}` : ""), { colour: GOOD });
    if (d.verification.notes) pdf.row("Basis", d.verification.notes);
  } else {
    pdf.row("Identity verified", "Not yet", { colour: WARN });
  }
  d.documents.forEach((a: any, i: number) => {
    pdf.row(i === 0 ? "Documents held" : "", `${labelFor(a)} — received ${when(a.uploaded_at)} — sha256 ${String(a.sha256).slice(0, 24)}…`);
  });
  if (d.narrative) {
    pdf.space(4);
    pdf.para("Source of funds and wealth", { face: "bold", size: 10.5, after: 2 });
    pdf.para(String(d.narrative.text), { size: 9.5, after: 2 });
    pdf.para(`Recorded ${when(d.narrative.created_at)} by ThePaymaster; version ${String(d.narrative.id).slice(-6)}.`, { size: 8.5, colour: MUTED, after: 6 });
  }

  // --- the payment ----------------------------------------------------------
  if (d.role === "recipient") {
    pdf.space(4);
    pdf.heading("The payment", 13);
    pdf.rule("0.106 0.141 0.188", 1);
    pdf.row("Asset", rail.name);
    pdf.row("Amount received", money(d.payment?.amount_minor ?? d.participation.amount_minor), { colour: d.payment ? GOOD : undefined });
    pdf.row("To the recipient's address", d.participation.address ?? "—", { mono: true });
    if (d.participation.proved_at) {
      pdf.row("Address proved", `By signature from the address, ${when(d.participation.proved_at)}`);
    } else if (d.attestation) {
      pdf.row("Address accepted", `Without signature — a ${d.attestation.custodian} deposit address, accepted on evidence ${when(d.attestation.granted_at)}`);
    } else {
      pdf.row("Address proved", "Not yet", { colour: WARN });
    }
    pdf.row("Address locked", d.participation.locked_at ? when(d.participation.locked_at) : "Not yet");
    if (d.screen) pdf.row("Address screened", `${d.screen.verdict} — ${d.screen.provider ?? ""} ${when(d.screen.screened_at)}`);
    if (d.payment?.tx_hash) {
      pdf.row("Chain transaction", d.payment.tx_hash, { mono: true });
      pdf.row("Block", d.payment.tx_block ? String(d.payment.tx_block) : "—");
      pdf.row("Confirmed on chain", when(d.payment.tx_verified_at ?? d.payment.occurred_at));
      pdf.row("Explorer", rail.explorer.tx(d.payment.tx_hash));
    } else {
      pdf.row("Chain transaction", "Not yet recorded", { colour: WARN });
    }

    pdf.space(4);
    pdf.heading("Where it came from", 13);
    pdf.rule("0.106 0.141 0.188", 1);
    if (d.sender) {
      pdf.row("Sender", d.sender.legal_name || d.sender.display_name);
      pdf.row("Sender verified", d.sender.verified_at ? `${when(d.sender.verified_at)} by ThePaymaster` : "Not yet", { colour: d.sender.verified_at ? GOOD : WARN });
    }
    for (const w of d.senderWallets) {
      pdf.row("Sending wallet", `${w.address}${w.proved_at ? `  (proved by signature ${when(w.proved_at)})` : "  (not proved)"}`, { mono: true });
    }
    pdf.para(`The funds moved directly from the sender's wallet to the recipient's address in the transaction above. ` +
      `At no point were they held by ThePaymaster Ltd or any other intermediary. The sender's identity and control of the ` +
      `sending wallet, and the recipient's identity and control of the receiving address, were each verified before the ` +
      `payment was made, and the address was tested with a live payment first.`, { size: 9.5, after: 6 });
  } else {
    pdf.space(4);
    pdf.heading("The distribution", 13);
    pdf.rule("0.106 0.141 0.188", 1);
    pdf.row("Asset", rail.name);
    for (const w of d.senderWallets) {
      pdf.row("Sending wallet", `${w.address}${w.proved_at ? `  (proved by signature ${when(w.proved_at)})` : "  (not proved)"}`, { mono: true });
    }
    const total = d.recipients.reduce((n, r) => n + (r.amountMinor || 0), 0) + Number(d.fee?.amount_minor ?? 0);
    pdf.row("Recipients", String(d.recipients.length));
    pdf.row("Total distributed", money(total));
    pdf.space(4);
    for (const r of d.recipients) {
      pdf.row(r.name, `${money(r.amountMinor)} to ${r.address ?? "—"}` + (r.txHash ? `\n${r.txHash}  ${when(r.sentAt)}` : "\nnot yet paid"), { mono: true });
    }
    if (d.fee) pdf.row("ThePaymaster fee", `${money(d.fee.amount_minor)}${d.fee.tx_hash ? `\n${d.fee.tx_hash}  ${when(d.fee.occurred_at)}` : ""}`, { mono: true });
    pdf.para(`Each payment was made by the sender from the wallet above directly to a recipient who had been identified, ` +
      `had proved control of the receiving address, and had been screened. ThePaymaster Ltd held no funds at any point.`, { size: 9.5, after: 6 });
  }

  // --- the record -----------------------------------------------------------
  pdf.space(4);
  pdf.heading("The record this is drawn from", 13);
  pdf.rule("0.106 0.141 0.188", 1);
  if (d.latestSeal) {
    pdf.row("Record root", d.latestSeal.root, { mono: true });
    pdf.row("Sealed", `${when(d.latestSeal.sealed_at)} over ${d.latestSeal.leaf_count} facts`);
    const s: any = d.latestSeal;
    if (s.anchor_tx_hash) {
      pdf.row("Published on Ethereum", s.anchor_tx_hash, { mono: true });
      pdf.row("Anchored", `${when(s.anchored_at)} — the root above appears in that transaction's data, fixing the date of the record`);
    }
    if (d.sealSignature) {
      pdf.row("Signed by ThePaymaster", `EIP-712 signature by ${d.sealSignature.attester} over the seal's reference, root, fact count, date and algorithm. Verifiable with any Ethereum library, or at ${VERIFY_URL}.`);
      pdf.row("Signature", d.sealSignature.signature, { mono: true });
    }
  } else {
    pdf.row("Record root", "The record has not yet been sealed.", { colour: WARN });
  }
  pdf.para(`The holder of this statement also holds record.pdf: their own entries from the record, each with the hash path ` +
    `that ties it to the root above. Anyone can recompute that path with SHA-256 and confirm the entry is part of the sealed ` +
    `record, without access to ThePaymaster or to anyone else's details. The full record is retained by ThePaymaster Ltd.`,
    { size: 9.5, after: 8 });
  pdf.para(`Issued by ThePaymaster Ltd. This document is generated from the record; a copy that has been altered will not ` +
    `agree with the root. Anyone may check this reference, the root, or the holder's record.json at ${VERIFY_URL} ` +
    `without contacting us. Enquiries: info@thepaymaster.co.uk, +44 20 7088 8267, quoting ${ref}.`, { size: 9, colour: MUTED });

  return pdf.bytes();
}

// ---------------------------------------------------------------------------
// The party's own record, as a PDF
// ---------------------------------------------------------------------------

export async function ownRecordPdf(env: Env, d: FolderData, opts: { watermark?: string | null } = {}): Promise<{ pdf: Uint8Array; json: string }> {
  const record = await ownRecord(env, d.tx.id, d.party.id);
  const dec = d.rail.decimals, sym = d.rail.symbol;
  const pdf = new Pdf((p, n) => `ThePaymaster — your record — ${d.tx.ref} — root ${record.root.slice(0, 16)}… — page ${p} of ${n}`, opts);
  pdf.heading("Your record", 22);
  pdf.para(`${d.tx.ref}${d.tx.name ? ` — ${d.tx.name}` : ""} — ${d.party.legal_name || d.party.display_name}`, { face: "bold", size: 12, after: 2 });
  pdf.para(`Your own entries in the record of this transaction, and for each one the hashes that prove it belongs to the ` +
    `sealed whole. ${record.others} other entries on the record concern other parties and are not shown; their existence is ` +
    `what makes the root verifiable.`, { size: 9.5, colour: MUTED, after: 8 });
  pdf.box([
    ["Record root", record.root, true],
    ["Sealed", record.sealedAt ? when(record.sealedAt) : "Not yet sealed — the transaction is still in progress"],
    ...(d.sealSignature && d.latestSeal && d.latestSeal.root === record.root
      ? [["Signed by ThePaymaster", d.sealSignature.attester] as [string, string], ["Signature", d.sealSignature.signature, true] as [string, string, boolean]] : []),
    ["Your entries", String(record.facts.length)],
    ["Other entries (count only)", String(record.others)],
  ], "The record");

  const value = (k: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/_minor$/.test(k) && /^-?\d+$/.test(s)) return `${format(Number(s), dec)} ${sym}  (${s} minor)`;
    return s;
  };
  const looksHex = (s: string) => /^(0x)?[0-9a-fA-F]{20,}$/.test(s) || /^(bc|tb)1[0-9a-z]{20,}$/i.test(s);
  record.facts.forEach((f, i) => {
    pdf.ensure(80);
    pdf.space(4);
    pdf.para(`${i + 1}. ${f.title}`, { face: "bold", size: 10.5, after: 2 });
    for (const [k, v] of Object.entries(f.data)) {
      if (v === null || v === undefined || v === "") continue;
      const text = value(k, v);
      pdf.row(k.replace(/_/g, " "), text, { mono: looksHex(text) });
    }
    pdf.row("leaf", f.leaf, { mono: true, colour: "0.541 0.592 0.659" });
    pdf.row("proof path", f.path.map((s) => `${s.side} ${s.hash}`).join("\n"), { mono: true, colour: "0.541 0.592 0.659" });
    pdf.rule();
  });

  pdf.space(6);
  pdf.heading("How to check an entry yourself", 13);
  pdf.numbered([
    "Take the entry's leaf hash (32 bytes).",
    "Fold in each hash of its proof path in order: where it says left, put it before yours; where it says right, after. Take the SHA-256 of the two 32-byte values joined together, and continue with the result.",
    "When the path is exhausted, the result must equal the record root above.",
    "The leaf itself is the SHA-256 of the entry serialised as JSON with keys sorted, no whitespace, and empty values omitted — so the entry's contents are what the root commits to.",
    `Or paste record.json at ${VERIFY_URL}: it does all of this for you and tells you when ThePaymaster sealed the root and where it is anchored.`,
  ]);

  const json = JSON.stringify({
    transaction: { id: d.tx.id, ref: d.tx.ref, name: d.tx.name },
    party: { id: d.party.id, name: d.party.legal_name || d.party.display_name },
    root: record.root, sealed_at: record.sealedAt, others: record.others,
    attestation: d.sealSignature && d.latestSeal && d.latestSeal.root === record.root ? d.sealSignature : null,
    facts: record.facts,
  }, null, 2);
  return { pdf: pdf.bytes(), json };
}

// ---------------------------------------------------------------------------
// The folder
// ---------------------------------------------------------------------------

export interface FolderEntry { name: string; data: Uint8Array }

/** Every file in a party's folder, with names relative to the folder. */
export async function folderEntries(env: Env, d: FolderData): Promise<FolderEntry[]> {
  const enc = new TextEncoder();
  const own = await ownRecordPdf(env, d);
  const entries: FolderEntry[] = [
    { name: "certification.pdf", data: statementPdf(d) },
    { name: "record.pdf", data: own.pdf },
    { name: "record.json", data: enc.encode(own.json) },
  ];
  // The sender's folder carries the Client Information Sheet they were given:
  // the company, the regulatory position, and the client account they paid.
  if (d.role === "sender") {
    try {
      const cis = await env.DOCS?.get("papers/client-information-sheet.pdf");
      if (cis) entries.push({ name: "documents/ThePaymaster-Client-Information-Sheet.pdf", data: new Uint8Array(await cis.arrayBuffer()) });
    } catch { /* absent until uploaded */ }
  }
  for (const a of d.documents) {
    try {
      const obj = await env.DOCS?.get(a.r2_key);
      if (!obj) continue;
      const name = `${a.id}-${safeName(a.filename ?? a.kind ?? "document")}`;
      entries.push({ name: `documents/${name}`, data: new Uint8Array(await obj.arrayBuffer()) });
    } catch { /* a missing object is simply absent */ }
  }
  return entries;
}

export async function partyFolder(env: Env, txId: string, partyId: string, audience: Audience):
    Promise<{ name: string; bytes: Uint8Array; final: boolean } | null> {
  const d = await folderData(env, txId, partyId, audience);
  if (!d) return null;
  const entries = await folderEntries(env, d);
  return {
    name: `${d.tx.ref}-${safeName(d.party.legal_name || d.party.display_name)}.zip`,
    bytes: zip(entries), final: statementStatus(d).final,
  };
}

export { safeName as folderName, labelFor as documentLabel };
