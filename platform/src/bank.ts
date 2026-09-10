/**
 * The bank side of a fiat leg: references, the penny test, the statement.
 *
 * On a chain the platform can see a payment for itself. With a bank it sees
 * what the bank tells it, so every payment we make or expect carries a
 * reference we chose, and the mandated account's statement — imported here,
 * line by line — is matched back to those references. Nothing is "paid" in
 * the record until a statement line says so.
 *
 *   TPM-2026-0002        the sender's money arriving
 *   TPM-2026-0002-01     the first recipient's payment (in roster order)
 *   TPM-2026-0002-FEE    our fee moving to our own account
 *   TPM PENNY K7X2QM     a penny to prove an account; the code is the proof
 *
 * The statement import takes CSV as banks export it: the columns are found by
 * their headings, not their positions, and a line imported twice is recorded
 * once. HSBC's API, when it is wired in, replaces the paste — not the matching.
 */

import { type Env, type Actor, id, update, log } from "./db.ts";
import { record as recordCustody, legs as payoutLegs, holderFor } from "./settlement.ts";
import { assess } from "./readiness.ts";
import { parse as parseMoney, format } from "./money.ts";
import { pennySent } from "./notify.ts";

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// --- references -------------------------------------------------------------------

export function inboundReference(ref: string): string { return ref; }
export function legReference(ref: string, n: number): string { return `${ref}-${String(n).padStart(2, "0")}`; }
export function feeReference(ref: string): string { return `${ref}-FEE`; }

/** Six characters a person can read off a statement and type: no 0/O, 1/I. */
export function pennyCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
}
export const pennyReference = (code: string) => `TPM PENNY ${code}`;

// --- the penny test ------------------------------------------------------------------

/** Staff mark the penny as sent; the code is what the recipient will read. */
export async function sendPenny(env: Env, actor: Actor, destinationId: string): Promise<{ code: string } | { problem: string }> {
  const d = await env.DB.prepare("SELECT * FROM destinations WHERE id = ?").bind(destinationId).first<any>();
  if (!d) return { problem: "No such destination." };
  if (d.kind !== "bank") return { problem: "The penny test is for bank accounts; wallets are proved by signature." };
  if (d.status === "draft") return { problem: "The recipient has not confirmed these details yet." };
  if (d.proved_at) return { problem: "This account is already proved." };
  const code = pennyCode();
  await update(env.DB, actor, "destination.penny_sent", "destinations", destinationId,
    { penny_code: code, penny_sent_at: stamp(), penny_attempts: 0 },
    { penny_code: d.penny_code ?? null, penny_sent_at: d.penny_sent_at ?? null },
    { note: `reference ${pennyReference(code)}` });
  await pennySent(env, actor, destinationId);
  return { code };
}

/** The recipient types the code they saw. Three tries, then a new penny. */
export async function claimPenny(env: Env, actor: Actor, destinationId: string, typed: string): Promise<string | null> {
  const d = await env.DB.prepare("SELECT * FROM destinations WHERE id = ?").bind(destinationId).first<any>();
  if (!d) return "No such destination.";
  if (d.proved_at) return null;
  if (!d.penny_code) return "We have not sent the penny yet. You will get an email when it goes; it usually lands within a couple of hours.";
  if (d.penny_attempts >= 3) return "Three tries did not match. We will send a fresh penny with a new code — nothing is wrong with your account.";
  const code = typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code !== d.penny_code) {
    await env.DB.prepare("UPDATE destinations SET penny_attempts = penny_attempts + 1 WHERE id = ?").bind(destinationId).run();
    return `That is not the code on the penny. Look for a credit of 0.01 with a reference beginning "TPM PENNY" — the six characters after it are the code. ${2 - d.penny_attempts} ${2 - d.penny_attempts === 1 ? "try" : "tries"} left.`;
  }
  await update(env.DB, actor, "destination.proved", "destinations", destinationId, {
    proved_at: stamp(), proof_signature: `penny:${d.penny_code}`,
  }, { proved_at: null }, { note: `account proved by penny test ${pennyReference(d.penny_code)}` });
  return null;
}

// --- the payments we expect, and the file to make them with ----------------------------

export type BankAccount = { name: string; sortCode?: string; accountNumber?: string; iban?: string; bic?: string; bank?: string };

/** "Name|sort|account|IBAN|BIC|bank" from a Worker var; null when unset or malformed. */
export function accountFromVar(v: string | undefined): BankAccount | null {
  if (!v) return null;
  const [name, sortCode, accountNumber, iban, bic, bank] = v.split("|").map((x) => x.trim());
  if (!name || !(iban || (sortCode && accountNumber))) return null;
  return { name, sortCode: sortCode || undefined, accountNumber: accountNumber || undefined,
    iban: iban || undefined, bic: bic || undefined, bank: bank || undefined };
}

/** Does the sender pay everyone from their own bank on this transaction? */
export const paysDirect = (t: { inbound: string; outbound: string; converts: number; fiat_payer?: string | null }) =>
  holderFor(t) === "client";

export interface Expected {
  what: string;                     // receipt | leg:<participation> | fee
  who: string;
  reference: string;
  amountMinor: number;
  direction: "in" | "out";
  currency: string;
  decimals: number;
  account: BankAccount | null;
  paid: boolean;
}

export async function expected(env: Env, txId: string): Promise<{ tx: any; items: Expected[] }> {
  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!tx) return { tx: null, items: [] };
  const state = await assess(env, txId);
  const items: Expected[] = [];

  const received = await env.DB.prepare(
    "SELECT 1 FROM custody_events WHERE transaction_id = ? AND event = 'received' LIMIT 1").bind(txId).first();
  const direct = paysDirect(tx);
  if (tx.inbound === "fiat" && !direct) {
    items.push({ what: "receipt", who: "the sender", reference: inboundReference(tx.ref),
      amountMinor: state.settlement?.grossMinor ?? tx.gross_expected_minor ?? 0, direction: "in",
      currency: tx.currency_in, decimals: tx.decimals_in, account: null, paid: Boolean(received) });
  }

  const legRows = await payoutLegs(env, txId);
  const { results: dests } = await env.DB.prepare(
    `SELECT p.id AS participation_id, d.* FROM participations p LEFT JOIN destinations d ON d.participation_id = p.id
      WHERE p.transaction_id = ? AND p.role = 'recipient'`).bind(txId).all<any>();
  if (tx.outbound === "fiat") legRows.forEach((l, i) => {
    const d = (dests ?? []).find((x: any) => x.participation_id === l.participationId);
    items.push({ what: `leg:${l.participationId}`, who: l.name, reference: legReference(tx.ref, i + 1),
      amountMinor: l.expectedMinor, direction: "out", currency: tx.currency_out, decimals: tx.decimals_out,
      paid: Boolean(l.txHash || l.sentMinor !== null),
      account: d?.kind === "bank" ? { name: d.account_name, sortCode: d.sort_code, accountNumber: d.account_number,
        iban: d.iban, bic: d.bic, bank: d.bank_name } : null });
  });

  const fee = await env.DB.prepare(
    "SELECT 1 FROM custody_events WHERE transaction_id = ? AND event = 'fee_taken' LIMIT 1").bind(txId).first();
  if (tx.inbound === "fiat") {
    items.push({ what: "fee", who: "ThePaymaster", reference: feeReference(tx.ref),
      amountMinor: state.settlement?.feeMinor ?? 0, direction: "out", currency: tx.currency_in, decimals: tx.decimals_in,
      account: direct ? accountFromVar(env.FEE_BANK_ACCOUNT) : null, paid: Boolean(fee) });
  }
  return { tx, items };
}

/** A bulk payment file: one row per outgoing payment still to make. Plain CSV every banking portal takes. */
export async function paymentsCsv(env: Env, txId: string): Promise<string> {
  const { tx, items } = await expected(env, txId);
  if (!tx) return "";
  const dec = tx.decimals_out ?? 2;
  const q = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = [["Beneficiary name", "Sort code", "Account number", "IBAN", "BIC", "Bank", "Amount", "Currency", "Reference"].map(q).join(",")];
  for (const it of items) {
    if (it.direction !== "out" || it.paid || it.amountMinor <= 0) continue;
    const a = it.account;
    rows.push([a?.name ?? it.who, a?.sortCode ?? "", a?.accountNumber ?? "", a?.iban ?? "", a?.bic ?? "", a?.bank ?? "",
      format(it.amountMinor, dec).replace(/,/g, ""), tx.currency_out, it.reference].map(q).join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

// --- the statement -------------------------------------------------------------------

export interface ParsedLine { booked_on: string; reference: string; amount_minor: number; direction: "in" | "out"; counterparty: string | null; raw: string }

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === "," || c === "\t" || c === ";") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function toIsoDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})/);
  if (m) { const mo = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(m[2].toLowerCase()) + 1; if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}

/**
 * Statement CSV → lines. Headings are matched loosely: a date column, one or
 * more description/reference columns, and either a signed amount column or
 * separate paid-in / paid-out (credit / debit) columns.
 */
export function parseStatement(text: string, decimals: number): { lines: ParsedLine[]; skipped: number } {
  const rows = text.split(/\r?\n/).filter((r) => r.trim());
  if (rows.length < 2) return { lines: [], skipped: rows.length };
  const head = splitCsvLine(rows[0]).map((h) => h.toLowerCase());
  const find = (...names: RegExp[]) => head.findIndex((h) => names.some((n) => n.test(h)));
  const iDate = find(/date/);
  const descCols = head.map((h, i) => (/desc|narrative|detail|reference|memo|payee|particular|text/.test(h) ? i : -1)).filter((i) => i >= 0);
  const iAmount = find(/^amount$|^value$|^amount \(/);
  const iIn = find(/paid in|credit|money in|deposit|inflow/);
  const iOut = find(/paid out|debit|money out|withdraw|outflow/);
  const iCp = find(/counterparty|from|beneficiary|payer|name/);
  if (iDate < 0 || (!descCols.length) || (iAmount < 0 && (iIn < 0 || iOut < 0))) return { lines: [], skipped: rows.length };

  const lines: ParsedLine[] = []; let skipped = 0;
  for (const raw of rows.slice(1)) {
    const c = splitCsvLine(raw);
    const date = toIsoDate(c[iDate] ?? "");
    const desc = descCols.map((i) => c[i] ?? "").filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    let minor = 0, direction: "in" | "out" = "in";
    try {
      if (iAmount >= 0) {
        const s = (c[iAmount] ?? "").replace(/[£$€\s]/g, "");
        if (!s) throw new Error("blank");
        const neg = /^\(.*\)$|^-/.test(s) || /\bDR\b/i.test(c[iAmount]);
        minor = parseMoney(s.replace(/[()\-]/g, ""), decimals); direction = neg ? "out" : "in";
      } else {
        const inS = (c[iIn] ?? "").replace(/[£$€\s]/g, ""), outS = (c[iOut] ?? "").replace(/[£$€\s]/g, "");
        if (inS && Number(inS.replace(/,/g, "")) > 0) { minor = parseMoney(inS, decimals); direction = "in"; }
        else if (outS && Number(outS.replace(/,/g, "")) > 0) { minor = parseMoney(outS, decimals); direction = "out"; }
        else throw new Error("no amount");
      }
    } catch { skipped++; continue; }
    if (!date || !desc || minor <= 0) { skipped++; continue; }
    lines.push({ booked_on: date, reference: desc, amount_minor: minor, direction, counterparty: iCp >= 0 ? (c[iCp] || null) : null, raw });
  }
  return { lines, skipped };
}

async function fingerprint(l: ParsedLine, currency: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${currency}|${l.booked_on}|${l.reference}|${l.direction}|${l.amount_minor}`));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Import statement lines. Duplicates (same date, reference, amount, direction) are skipped. */
export async function importStatement(env: Env, actor: Actor, text: string, currency: string, decimals: number):
    Promise<{ added: number; duplicates: number; skipped: number }> {
  const { lines, skipped } = parseStatement(text, decimals);
  let added = 0, duplicates = 0;
  for (const l of lines) {
    const fp = await fingerprint(l, currency);
    const dup = await env.DB.prepare("SELECT 1 FROM bank_lines WHERE fingerprint = ?").bind(fp).first();
    if (dup) { duplicates++; continue; }
    await env.DB.prepare(
      `INSERT INTO bank_lines (id, imported_by, booked_on, reference, amount_minor, direction, currency, counterparty, raw, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id("bl"), actor.id ?? "unknown", l.booked_on, l.reference, l.amount_minor, l.direction, currency, l.counterparty, l.raw, fp).run();
    added++;
  }
  await log(env.DB, actor, "bank.statement_imported", "bank_lines", "import", { note: `${added} new, ${duplicates} already held, ${skipped} unreadable` });
  return { added, duplicates, skipped };
}

// --- reconciliation ------------------------------------------------------------------

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Match imported lines to what this transaction expects, and record what
 * matches. A line matches on reference *and* amount *and* direction; anything
 * less is shown as "near" for a person to look at, never recorded.
 */
export async function reconcile(env: Env, actor: Actor, txId: string):
    Promise<{ recorded: string[]; near: string[]; pennies: string[] }> {
  const { tx, items } = await expected(env, txId);
  if (!tx) return { recorded: [], near: [], pennies: [] };
  const { results: unmatched } = await env.DB.prepare(
    "SELECT * FROM bank_lines WHERE matched_event_id IS NULL AND matched_what IS NULL ORDER BY booked_on").all<any>();
  const lines = unmatched ?? [];
  const recorded: string[] = [], near: string[] = [], pennies: string[] = [];

  for (const it of items) {
    if (it.paid || it.amountMinor <= 0) continue;
    const want = norm(it.reference);
    const dec = it.decimals;
    const candidates = lines.filter((l: any) => norm(l.reference).includes(want) && l.direction === it.direction && l.currency === it.currency);
    const exact = candidates.find((l: any) => Number(l.amount_minor) === it.amountMinor);
    if (!exact) {
      for (const c of candidates) near.push(`${it.who} (${it.reference}): a line on ${c.booked_on} for ${format(Number(c.amount_minor), dec)} — expected ${format(it.amountMinor, dec)}`);
      continue;
    }
    const res = await recordCustody(env, actor, txId, {
      holder: holderFor(tx),
      event: it.what === "receipt" ? "received" : it.what === "fee" ? "fee_taken" : "sent",
      amountMinor: it.amountMinor, currency: it.currency, decimals: dec,
      occurredAt: `${exact.booked_on} 00:00:00`,
      note: `bank statement line ${exact.id}: "${exact.reference}"`,
    });
    if (typeof res === "object") { near.push(`${it.who}: ${res.problem}`); continue; }
    if (it.what.startsWith("leg:")) {
      await env.DB.prepare("INSERT OR IGNORE INTO payout_legs (event_id, participation_id) VALUES (?, ?)")
        .bind(res, it.what.slice(4)).run();
    }
    await env.DB.prepare("UPDATE bank_lines SET transaction_id = ?, matched_event_id = ?, matched_what = ? WHERE id = ?")
      .bind(txId, res, it.what, exact.id).run();
    lines.splice(lines.indexOf(exact), 1);
    recorded.push(`${it.who} — ${it.reference} — ${format(it.amountMinor, dec)} ${it.currency} on ${exact.booked_on}`);
  }

  // Pennies that went out: tie the statement line to the destination it tested.
  const { results: pennyDests } = await env.DB.prepare(
    `SELECT d.id, d.penny_code, y.display_name FROM destinations d JOIN participations p ON p.id = d.participation_id
       JOIN parties y ON y.id = p.party_id WHERE p.transaction_id = ? AND d.penny_code IS NOT NULL`).bind(txId).all<any>();
  for (const d of pennyDests ?? []) {
    const line = lines.find((l: any) => l.direction === "out" && norm(l.reference).includes(norm(pennyReference(d.penny_code))));
    if (!line) continue;
    await env.DB.prepare("UPDATE bank_lines SET transaction_id = ?, matched_what = ? WHERE id = ?").bind(txId, `penny:${d.id}`, line.id).run();
    lines.splice(lines.indexOf(line), 1);
    pennies.push(`${d.display_name} — penny ${d.penny_code} left on ${line.booked_on}`);
  }
  if (recorded.length || pennies.length) {
    await log(env.DB, actor, "bank.reconciled", "transactions", txId, { note: `${recorded.length} payments, ${pennies.length} pennies` });
  }
  return { recorded, near, pennies };
}

/** Lines held for a transaction, and the unmatched pool, for the panel. */
export async function linesFor(env: Env, txId: string) {
  const { results: matched } = await env.DB.prepare("SELECT * FROM bank_lines WHERE transaction_id = ? ORDER BY booked_on").bind(txId).all<any>();
  const { results: pool } = await env.DB.prepare(
    "SELECT * FROM bank_lines WHERE matched_event_id IS NULL AND matched_what IS NULL ORDER BY booked_on DESC LIMIT 40").all<any>();
  return { matched: matched ?? [], pool: pool ?? [] };
}
