/**
 * The annual statement.
 *
 * Once a year — or whenever asked — a party gets one document covering every
 * payment they sent or received through ThePaymaster in a calendar year: date,
 * transaction, counterparty, amount, the chain transaction, and the sealed
 * record each one sits in, with totals per asset. It is the thing an
 * accountant asks for in January and the thing that brings a client back to
 * their account to fetch it.
 *
 * Like the certification, it is drawn from the record and signed: the
 * statement's lines are hashed, and ThePaymaster's attestation key signs the
 * party, the year and that digest, so the PDF and the JSON can be checked at
 * the verifier and any altered line shows.
 */

import { type Env } from "./db.ts";
import { Pdf } from "./pdf.ts";
import { format } from "./money.ts";
import { railFor } from "./rail.ts";
import { canonical } from "./dossier.ts";
import { attestAnnual, type AnnualAttestation } from "./attestation.ts";
import { countryName } from "./countries.ts";
import { VERIFY_URL } from "./verify.ts";

const MUTED = "0.353 0.420 0.502";
const GOOD = "0.106 0.498 0.294";

export interface AnnualLine {
  date: string; ref: string; txId: string;
  direction: "in" | "out" | "fee";
  counterparty: string;
  amountMinor: number; currency: string; decimals: number;
  txHash: string | null; explorer: string | null;
  root: string | null; sealedAt: string | null;
}

export interface AnnualData {
  party: any;
  year: number;
  lines: AnnualLine[];
  totals: Record<string, { in: number; out: number; fee: number; decimals: number }>;
  transactions: { ref: string; name: string; role: string; root: string | null; sealedAt: string | null; anchor: string | null }[];
  verification: any | null;
  issuedAt: string;
  digest: string;
  attestation: AnnualAttestation | null;
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The years in which this party sent or received anything. */
export async function yearsFor(env: Env, partyId: string): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT substr(c.occurred_at, 1, 4) AS y
       FROM custody_events c
      WHERE c.event IN ('sent', 'fee_taken') AND c.tx_hash IS NOT NULL
        AND (c.id IN (SELECT l.event_id FROM payout_legs l JOIN participations p ON p.id = l.participation_id WHERE p.party_id = ?)
          OR c.transaction_id IN (SELECT transaction_id FROM participations WHERE party_id = ? AND role = 'sender'))
      ORDER BY y DESC`).bind(partyId, partyId).all<any>();
  return (results ?? []).map((r: any) => Number(r.y)).filter((y) => y > 2000);
}

export async function annualData(env: Env, partyId: string, year: number): Promise<AnnualData | null> {
  const party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(partyId).first<any>();
  if (!party) return null;
  const from = `${year}-01-01 00:00:00`, to = `${year + 1}-01-01 00:00:00`;

  // Received: payments to a leg this party is the recipient of.
  const { results: received } = await env.DB.prepare(
    `SELECT c.occurred_at, c.amount_minor, c.currency, c.decimals, c.tx_hash, t.id AS tx_id, t.ref, t.name,
            t.chain_id, t.rail, t.token_address, t.decimals_out, t.currency_out,
            (SELECT y.display_name FROM participations sp JOIN parties y ON y.id = sp.party_id
              WHERE sp.transaction_id = t.id AND sp.role = 'sender' LIMIT 1) AS counterparty
       FROM custody_events c JOIN payout_legs l ON l.event_id = c.id
       JOIN participations p ON p.id = l.participation_id JOIN transactions t ON t.id = c.transaction_id
      WHERE p.party_id = ? AND c.event = 'sent' AND c.tx_hash IS NOT NULL AND c.occurred_at >= ? AND c.occurred_at < ?
      ORDER BY c.occurred_at`).bind(partyId, from, to).all<any>();

  // Sent: every paid leg, and our fee, on transactions this party sent.
  const { results: sent } = await env.DB.prepare(
    `SELECT c.occurred_at, c.amount_minor, c.currency, c.decimals, c.tx_hash, c.event, t.id AS tx_id, t.ref, t.name,
            t.chain_id, t.rail, t.token_address, t.decimals_out, t.currency_out,
            (SELECT y.display_name FROM payout_legs l JOIN participations rp ON rp.id = l.participation_id
              JOIN parties y ON y.id = rp.party_id WHERE l.event_id = c.id LIMIT 1) AS counterparty
       FROM custody_events c JOIN transactions t ON t.id = c.transaction_id
      WHERE c.event IN ('sent', 'fee_taken') AND c.tx_hash IS NOT NULL AND c.occurred_at >= ? AND c.occurred_at < ?
        AND t.id IN (SELECT transaction_id FROM participations WHERE party_id = ? AND role = 'sender')
      ORDER BY c.occurred_at`).bind(from, to, partyId).all<any>();

  const sealOf = new Map<string, { root: string | null; sealedAt: string | null; anchor: string | null }>();
  const seal = async (txId: string) => {
    if (!sealOf.has(txId)) {
      const s = await env.DB.prepare(
        "SELECT root, sealed_at, anchor_tx_hash FROM dossier_seals WHERE transaction_id = ? ORDER BY sealed_at DESC LIMIT 1")
        .bind(txId).first<any>();
      sealOf.set(txId, { root: s?.root ?? null, sealedAt: s?.sealed_at ?? null, anchor: s?.anchor_tx_hash ?? null });
    }
    return sealOf.get(txId)!;
  };

  const lines: AnnualLine[] = [];
  const line = async (r: any, direction: AnnualLine["direction"]) => {
    const s = await seal(r.tx_id);
    const rail = railFor(r);
    lines.push({
      date: String(r.occurred_at).slice(0, 10), ref: r.ref, txId: r.tx_id, direction,
      counterparty: direction === "fee" ? "ThePaymaster" : (r.counterparty ?? "—"),
      amountMinor: Number(r.amount_minor), currency: r.currency ?? r.currency_out ?? rail.symbol,
      decimals: Number(r.decimals ?? r.decimals_out ?? rail.decimals),
      txHash: r.tx_hash ?? null, explorer: r.tx_hash ? rail.explorer.tx(r.tx_hash) : null,
      root: s.root, sealedAt: s.sealedAt,
    });
  };
  for (const r of received ?? []) await line(r, "in");
  for (const r of sent ?? []) await line(r, r.event === "fee_taken" ? "fee" : "out");
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ref.localeCompare(b.ref)));

  const totals: AnnualData["totals"] = {};
  for (const l of lines) {
    const t = (totals[l.currency] ??= { in: 0, out: 0, fee: 0, decimals: l.decimals });
    t[l.direction] += l.amountMinor;
  }

  const seen = new Map<string, AnnualData["transactions"][number]>();
  for (const r of [...(received ?? []).map((x: any) => ({ ...x, role: "recipient" })), ...(sent ?? []).map((x: any) => ({ ...x, role: "sender" }))]) {
    if (seen.has(r.tx_id)) continue;
    const s = await seal(r.tx_id);
    seen.set(r.tx_id, { ref: r.ref, name: r.name, role: r.role, root: s.root, sealedAt: s.sealedAt, anchor: s.anchor });
  }
  const transactions = [...seen.values()].sort((a, b) => a.ref.localeCompare(b.ref));

  const verification = await env.DB.prepare(
    `SELECT verified_at, expires_at, provider FROM verifications WHERE party_id = ? AND status = 'passed'
      ORDER BY verified_at DESC LIMIT 1`).bind(partyId).first<any>();

  const issuedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const digest = await sha256hex(canonical({ party: partyId, year, lines, totals, transactions }));
  const attestation = await attestAnnual(env, { party: partyId, year, digest: "0x" + digest, issuedAt });

  return { party, year, lines, totals, transactions, verification, issuedAt, digest, attestation };
}

export function annualJson(d: AnnualData): string {
  return JSON.stringify({
    statement: "annual", version: 1,
    party: { id: d.party.id, name: d.party.legal_name || d.party.display_name },
    year: d.year, issued_at: d.issuedAt, digest: d.digest,
    lines: d.lines, totals: d.totals, transactions: d.transactions,
    attestation: d.attestation,
  }, null, 2);
}

export function annualPdf(d: AnnualData, opts: { watermark?: string | null } = {}): Uint8Array {
  const who = d.party.legal_name || d.party.display_name;
  const pdf = new Pdf((p, n) => `ThePaymaster® — Annual statement ${d.year} — ${who} — digest ${d.digest.slice(0, 16)}… — page ${p} of ${n}`, opts);
  const money = (minor: number, dec: number, sym: string) => `${format(minor, dec)} ${sym}`;

  pdf.heading(`Annual statement ${d.year}`, 22);
  pdf.para(who, { face: "bold", size: 13, after: 2 });
  pdf.para(`Every payment ${who} sent or received through ThePaymaster® between 1 January and 31 December ${d.year}, ` +
    `drawn from the sealed record of each transaction. Issued ${d.issuedAt.slice(0, 16)} UTC by ThePaymaster Ltd, ` +
    `167-169 The Fifth Floor, Great Portland Street, London W1W 5PF.`, { size: 9, colour: MUTED, after: 10 });

  // --- totals ------------------------------------------------------------------
  const rows: [string, string, boolean?][] = [];
  for (const [cur, t] of Object.entries(d.totals)) {
    if (t.in) rows.push([`Received, ${cur}`, money(t.in, t.decimals, cur)]);
    if (t.out) rows.push([`Sent to recipients, ${cur}`, money(t.out, t.decimals, cur)]);
    if (t.fee) rows.push([`ThePaymaster fees paid, ${cur}`, money(t.fee, t.decimals, cur)]);
  }
  rows.push(["Payments", String(d.lines.length)]);
  rows.push(["Transactions", String(d.transactions.length)]);
  if (d.verification) rows.push(["Identity", `Verified by ThePaymaster ${String(d.verification.verified_at).slice(0, 10)}${d.verification.expires_at ? `, clearance to ${String(d.verification.expires_at).slice(0, 10)}` : ""}`]);
  if (party_is_individual(d.party)) {
    if (d.party.nationality) rows.push(["Nationality", countryName(d.party.nationality)]);
    if (d.party.residence_country) rows.push(["Country of residence", countryName(d.party.residence_country)]);
  } else if (d.party.company_no) rows.push(["Registered number", String(d.party.company_no)]);
  pdf.box(rows, `${d.year} at a glance`);

  // --- the payments --------------------------------------------------------------
  pdf.heading("Payments", 13);
  pdf.rule("0.106 0.141 0.188", 1);
  if (!d.lines.length) pdf.para("No payments in this year.", { colour: MUTED });
  for (const l of d.lines) {
    pdf.ensure(64);
    const dir = l.direction === "in" ? "Received from" : l.direction === "fee" ? "Fee to" : "Sent to";
    pdf.para(`${l.date} — ${l.ref} — ${dir} ${l.counterparty}`, { face: "bold", size: 10.5, after: 2 });
    pdf.row("Amount", money(l.amountMinor, l.decimals, l.currency), { colour: l.direction === "in" ? GOOD : undefined });
    if (l.txHash) pdf.row("Chain transaction", l.txHash, { mono: true });
    if (l.explorer) pdf.row("Explorer", l.explorer);
    pdf.row("Record", l.root ? `${l.root}  (sealed ${String(l.sealedAt).slice(0, 16)})` : "not yet sealed", { mono: Boolean(l.root) });
    pdf.rule();
  }

  // --- the transactions ------------------------------------------------------------
  pdf.space(6);
  pdf.heading("The transactions these belong to", 13);
  pdf.rule("0.106 0.141 0.188", 1);
  for (const t of d.transactions) {
    pdf.para(`${t.ref} — ${t.name} — ${who} was the ${t.role}`, { face: "bold", size: 10.5, after: 2 });
    pdf.row("Record root", t.root ?? "not yet sealed", { mono: Boolean(t.root) });
    if (t.sealedAt) pdf.row("Sealed", String(t.sealedAt).slice(0, 16));
    if (t.anchor) pdf.row("Published on Ethereum", t.anchor, { mono: true });
    pdf.rule();
  }

  // --- the signature -------------------------------------------------------------------
  pdf.space(6);
  pdf.heading("This statement", 13);
  pdf.rule("0.106 0.141 0.188", 1);
  pdf.row("Digest", d.digest, { mono: true });
  pdf.para("The digest is the SHA-256 of the lines, totals and transactions above, serialised canonically; the JSON copy of this statement carries the same and can be checked line by line.", { size: 9, colour: MUTED, after: 4 });
  if (d.attestation) {
    pdf.row("Signed by ThePaymaster", `EIP-712 signature by ${d.attestation.attester} over (party, year, digest, issued-at)`);
    pdf.row("Signature", d.attestation.signature, { mono: true });
  }
  pdf.para(`Check this statement, or any transaction's record, at ${VERIFY_URL}. Enquiries: info@thepaymaster.co.uk, +44 20 7088 8267.`, { size: 9, colour: MUTED });
  return pdf.bytes();
}

function party_is_individual(p: any): boolean { return p.kind !== "company"; }
