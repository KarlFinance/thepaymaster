/**
 * The agreements each party signs, made for the transaction in front of them.
 *
 * Two documents, both Keirón's September 2026 texts, carried verbatim in
 * agreements-text.json: the Sender's Paymaster Agreement (with its
 * Transaction Schedule, Distribution Schedule and Client Account schedule)
 * and the Recipient's Authorisation and Payment Instruction. The platform
 * fills every bracket from the record — the parties, the amounts, the modes,
 * the recipient's own account — shows the filled document to the signer, and
 * records the signature over a hash of exactly that content.
 *
 * If the transaction changes afterwards (an amount, a recipient, an account),
 * the freshly filled document hashes differently, the signature no longer
 * covers the facts, and the party is asked to sign again. The signed PDF goes
 * into the document store as an artefact shared with the party, so it lands
 * in the dossier and in their own folder without anything else knowing about
 * agreements at all.
 */

import { type Env, type Actor, id, insert } from "./db.ts";
import { format } from "./money.ts";
import { Pdf } from "./pdf.ts";
import { store } from "./documents.ts";
import { assess } from "./readiness.ts";
import { resembles } from "./mandate.ts";
import { accountFromVar, paysDirect } from "./bank.ts";
import { esc } from "./views.ts";
import { DESK } from "./conversion.ts";
import text from "./agreements-text.json" with { type: "json" };

export type Kind = "sender_agreement" | "recipient_authorisation";
export const VERSION: string = (text as any).version;

type Block =
  | { t: "title" | "subtitle" | "h2" | "h3" | "p" | "tick"; text: string }
  | { t: "clause" | "sub"; n: string; text: string }
  | { t: "def"; term: string; text: string }
  | { t: "table"; rows: string[][] }
  | { t: "sign"; lines: string[] };

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const day = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : "");
const TICK = "☑", BOX = "☐";
const MUTED = "0.353 0.420 0.502";   // the PDF writer takes RGB fractions, not hex

// ---------------------------------------------------------------------------
// What goes into the brackets
// ---------------------------------------------------------------------------

interface Facts {
  tx: any; sender: any; recipients: any[]; dests: Record<string, any>;
  verified: Record<string, string | null>; auths: Record<string, string | null>;
  amounts: Record<string, number>; grossMinor: number; feeMinor: number;
  narrative: string | null;
}

async function facts(env: Env, txId: string): Promise<Facts | null> {
  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!tx) return null;
  const { results: parts } = await env.DB.prepare(
    `SELECT p.id AS participation_id, p.role, p.share_bps, p.amount_minor, y.*
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ? AND p.role IN ('sender','recipient') ORDER BY p.role DESC, y.display_name`).bind(txId).all<any>();
  const sender = (parts ?? []).find((p) => p.role === "sender") ?? null;
  const recipients = (parts ?? []).filter((p) => p.role === "recipient");
  const dests: Record<string, any> = {};
  for (const r of recipients) {
    dests[r.participation_id] = await env.DB.prepare("SELECT * FROM destinations WHERE participation_id = ?").bind(r.participation_id).first<any>();
  }
  const verified: Record<string, string | null> = {};
  const auths: Record<string, string | null> = {};
  for (const p of parts ?? []) {
    const v = await env.DB.prepare(
      `SELECT verified_at FROM verifications WHERE party_id = ? AND status = 'passed'
         AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY verified_at DESC LIMIT 1`).bind(p.id).first<any>();
    verified[p.id] = v?.verified_at ?? null;
    const a = await env.DB.prepare(
      "SELECT signed_at FROM agreements WHERE transaction_id = ? AND party_id = ? AND kind = 'recipient_authorisation' ORDER BY signed_at DESC LIMIT 1")
      .bind(txId, p.id).first<any>();
    auths[p.id] = a?.signed_at ?? null;
  }
  const state = await assess(env, txId, { agreements: false });
  const narrative = sender ? (await env.DB.prepare(
    "SELECT text FROM narratives WHERE transaction_id = ? AND party_id = ? ORDER BY created_at DESC LIMIT 1").bind(txId, sender.id).first<any>())?.text ?? null : null;
  return { tx, sender, recipients, dests, verified, auths,
    amounts: state.settlement?.amounts ?? {}, grossMinor: state.settlement?.grossMinor ?? tx.gross_expected_minor ?? 0,
    feeMinor: state.settlement?.feeMinor ?? 0, narrative };
}

/** "Jane Smith, an individual residing at …" or "Acme Ltd, a company registered in …". */
function partyLine(p: any): string {
  const name = p.legal_name || p.display_name;
  if (p.kind === "company") {
    return `${name}, a company registered in ${p.incorporated_in || p.country || "[jurisdiction]"} with registration number ${p.company_no || "[number]"}, whose registered office is at ${p.address || "[address]"}`;
  }
  return `${name}, an individual residing at ${p.address || "[address]"}`;
}

function modesOf(tx: any): { A: boolean; B: boolean; C: boolean } {
  return { A: tx.inbound === "fiat" && tx.outbound === "fiat",
           B: tx.inbound === "fiat" && tx.outbound === "crypto",
           C: tx.inbound === "crypto" && tx.outbound === "crypto" && !tx.converts };
}
const modeLetter = (tx: any) => { const m = modesOf(tx); return m.A ? "A" : m.B ? "B" : m.C ? "C" : "—"; };

function entitlementOf(f: Facts, r: any): { text: string; pct: string; amountMinor: number } {
  const amountMinor = f.amounts[r.participation_id] ?? 0;
  const pct = r.share_bps != null ? `${(r.share_bps / 100).toFixed(2).replace(/\.?0+$/, "")}` : "";
  // On a converting transaction the share is fixed in the incoming currency;
  // what arrives is that share of what the desk returns.
  const money = f.tx.converts
    ? `${format(amountMinor, f.tx.decimals_in)} ${f.tx.currency_in} before conversion, delivered as the same share of the ${f.tx.currency_out} the desk returns`
    : `${format(amountMinor, f.tx.decimals_out)} ${f.tx.currency_out}`;
  return { text: pct ? `${pct}% (${money})` : money, pct: pct || "—", amountMinor };
}

function accountBlock(env: Env): Record<string, string> {
  const a = accountFromVar(env.MANDATED_ACCOUNT);
  if (!a) return { bank: "HSBC UK", account_name: "ThePaymaster (Global) Ltd", account_number: "Supplied through a Secure Channel",
    sort_code: "Supplied through a Secure Channel", iban: "Supplied through a Secure Channel", bic_swift: "Supplied through a Secure Channel",
    payment_reference: "The Reference Code issued for this Transaction Schedule", local_currency_details: "Supplied through a Secure Channel where a local-currency account is used" };
  return { bank: a.bank ?? "HSBC UK", account_name: a.name, account_number: a.accountNumber ?? "—", sort_code: a.sortCode ?? "—",
    iban: a.iban ?? "—", bic_swift: a.bic ?? "—", payment_reference: "The Reference Code issued for this Transaction Schedule",
    local_currency_details: "Supplied through a Secure Channel where a local-currency account is used" };
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

function fillSender(env: Env, f: Facts): Block[] {
  const { tx, sender } = f;
  const modes = modesOf(tx);
  const acct = accountBlock(env);
  const out: Block[] = [];
  const src = (text as any).sender as Block[];
  let sigTables = 0;
  for (const raw of src) {
    const b: Block = JSON.parse(JSON.stringify(raw));
    if (b.t === "p" && b.text.startsWith("THIS AGREEMENT is made on")) { b.text = "THIS AGREEMENT is made on the date of the Principal's electronic signature below."; out.push(b); continue; }
    if (b.t === "sub" && b.n === "(2)") { b.text = `${partyLine(sender)} (the "Principal").`; out.push(b); continue; }
    if (b.t === "h3" && b.text.startsWith("TRANSACTION SCHEDULE No.")) { b.text = `TRANSACTION SCHEDULE No. ${tx.ref}`; out.push(b); continue; }
    if (b.t === "h3" && b.text.startsWith("DISTRIBUTION SCHEDULE for")) { b.text = `DISTRIBUTION SCHEDULE for Transaction Schedule No. ${tx.ref}`; out.push(b); continue; }
    if (b.t === "p" && b.text.includes("[DATE]")) { b.text = b.text.replace("[DATE]", "the date of the Principal's electronic signature"); out.push(b); continue; }
    if (b.t === "table") {
      const first = b.rows[0]?.[0] ?? "";
      if (first.startsWith("For and on behalf of THEPAYMASTER") || first.startsWith("For THEPAYMASTER")) {
        sigTables++;
        out.push({ t: "sign", lines: [
          "For and on behalf of THEPAYMASTER LIMITED: Keirón Allen, Director, ka@thepaymaster.co.uk — countersigned electronically on receipt of the Principal's signature.",
          `For and on behalf of the PRINCIPAL: ${sender.legal_name || sender.display_name}${sender.kind === "company" ? " (by its authorised signatory)" : ""} — signed electronically below.`,
        ] });
        continue;
      }
      if (first === "Principal") {
        const pct = tx.fee_mode === "grossed_up";
        const vals: Record<string, string> = {
          "Principal": partyLine(sender),
          "Underlying Transaction": [tx.name, tx.detail, tx.summary].filter(Boolean).join(". ") || "As described to ThePaymaster at the briefing call and in the documents supplied through the Secure Channel.",
          // Constant on purpose: the Principal signs before the recipients have done
          // their part, and a narrative written later must not unsign the Principal.
          "Source of the Gross Amount": "As evidenced by the Principal to ThePaymaster in Verification and recorded in the transaction record.",
          "Third party payer (if any)": "None. The Principal pays.",
          "Gross Amount": `${tx.currency_in} ${format(f.grossMinor, tx.decimals_in)} (${pct ? "derived from fixed Recipient entitlements" : "fixed"})`,
          "Receipt pattern": "Single receipt.",
          "Distribution Mode(s)": `${modes.A ? TICK : BOX} Mode A (Fiat)   ${modes.B ? TICK : BOX} Mode B (Fiat with Conversion)   ${modes.C ? TICK : BOX} Mode C (Native Digital Asset)` +
            (tx.inbound === "crypto" && tx.outbound === "fiat" ? "   — Digital assets in, fiat out: governed by the separate contract for that route; this Agreement's Modes do not apply." : ""),
          "Service Fee": `1% of the Gross Amount (${tx.currency_in} ${format(f.feeMinor, tx.decimals_in)}). Borne by: ${pct ? BOX : TICK} deducted from the Gross Amount pro rata across Recipients   ${pct ? TICK : BOX} paid by the Principal in addition to the Gross Amount   ${BOX} borne by named Recipient(s)`,
          "Conversion Fee (Mode B only)": modes.B || tx.converts
            ? `${(DESK.feeBps / 100).toFixed(2).replace(/\.?0+$/, "")}% of each converted amount, charged by ${DESK.name} at source and deducted from the converted amount at Conversion (clause 8.2). It is the desk's charge and is not collected by ThePaymaster. The desk's spread and network fees are costs of the Distribution.`
            : "Not applicable.",
          "Network fees (Modes B and C)": modes.A ? "Not applicable." : `${TICK} deducted from the relevant Recipient's Distribution   ${BOX} borne by the Principal`,
          "Special terms": "None.",
        };
        b.rows = b.rows.map((r) => [r[0], vals[r[0]] ?? r[1]]);
        out.push(b); continue;
      }
      if (first === "#") {
        const head = b.rows[0];
        const rows = f.recipients.map((r, i) => {
          const d = f.dests[r.participation_id]; const e = entitlementOf(f, r);
          return [String(i + 1), `${r.legal_name || r.display_name} (${r.kind === "company" ? "company" : "individual"})`, e.text, modeLetter(tx),
            modes.A ? tx.currency_out : `${tx.currency_out}${d?.chain ? ` on ${d.chain}` : ""}`,
            // Dated in the record, not here: these fill after the Principal has signed.
            "Per the transaction record", "Per the transaction record",
            modes.A ? "n/a" : "Per the transaction record"];
        });
        b.rows = [head, ...rows, ["", "Total", "100%", "", "", "", "", ""]];
        out.push(b); continue;
      }
      if (first === "Bank") {
        b.rows = b.rows.map((r) => [r[0], String(r[1]).replace(/\{\{account\.([a-z_]+)\}\}/g, (_m, k) => acct[k] ?? "—")]);
        out.push(b); continue;
      }
      out.push(b); continue;
    }
    if (b.t === "p" && b.text.startsWith("Signed for the Principal")) { out.push({ t: "sign", lines: [`Signed for the Principal: ${sender.legal_name || sender.display_name} — electronically, below.`] }); continue; }
    if (b.t === "p" && (b.text === "Name:" || b.text === "Date:")) continue;
    out.push(b);
  }
  void sigTables;
  return out;
}

function fillRecipient(env: Env, f: Facts, participationId: string): Block[] | null {
  const r = f.recipients.find((x) => x.participation_id === participationId);
  if (!r) return null;
  const { tx, sender } = f;
  const d = f.dests[participationId];
  const modes = modesOf(tx);
  const e = entitlementOf(f, r);
  const grossText = `${tx.currency_in} ${format(f.grossMinor, tx.decimals_in)}`;
  const out: Block[] = [];
  for (const raw of (text as any).recipient as Block[]) {
    const b: Block = JSON.parse(JSON.stringify(raw));
    if (b.t === "table") {
      const first = b.rows[0]?.[0] ?? "";
      if (first.startsWith("Given by")) {
        b.rows = [
          ['Given by (the "Recipient")', partyLine(r)],
          ['To (the "Principal")', `${sender ? (sender.legal_name || sender.display_name) : "[Principal]"}, care of its commercial agent ThePaymaster Limited, company number 15991850, of 167-169 The Fifth Floor, Great Portland Street, London W1W 5PF ("ThePaymaster")`],
          ["Transaction Schedule reference", tx.ref],
          ["Date", "The date of the Recipient's electronic signature below"],
        ];
        out.push(b); continue;
      }
      if (first.startsWith("Account name")) {
        const bank = d?.kind === "bank" ? d : null;
        const vals: Record<string, string> = {
          "Account name (exactly as held at the bank)": bank?.account_name ?? "—",
          "Bank name and country": bank ? [bank.bank_name, bank.bank_country].filter(Boolean).join(", ") || "—" : "—",
          "Account number": bank?.account_number ?? "—", "Sort code / routing / branch code": bank?.sort_code ?? "—",
          "IBAN": bank?.iban ?? "—", "BIC / SWIFT": bank?.bic ?? "—", "Intermediary bank (if any)": "None",
          "Reference to appear on the Recipient's statement (optional)": `${tx.ref}`,
        };
        b.rows = b.rows.map((row) => [row[0], bank ? (vals[row[0]] ?? "—") : "Not applicable — Method A not elected"]);
        out.push(b); continue;
      }
      if (first === "Digital Asset") {
        const w = d?.kind === "wallet" ? d : null;
        const vals: Record<string, string> = {
          "Digital Asset": tx.currency_out, "Network (for example Bitcoin, Ethereum ERC-20, Tron TRC-20)": w?.chain ?? "—",
          "Wallet address": w?.address ?? "—",
          "Verified Wallet Certificate reference or URL": w?.proved_at ? `Control proved to ThePaymaster by signature from the wallet's key (${day(w.proved_at)}); recorded in the transaction record` : "not yet proved",
          "Certificate date": day(w?.proved_at) || "—", "Wallet type": `${BOX} Hardware wallet ${BOX} Software wallet ${BOX} Multi-signature wallet (as declared by the Recipient)`,
          "Email address for test transaction confirmation": r.email ?? "—",
        };
        b.rows = b.rows.map((row) => [row[0], w ? (vals[row[0]] ?? "—") : "Not applicable — Methods B and C not elected"]);
        out.push(b); continue;
      }
      if (first.startsWith("SIGNED by the RECIPIENT")) {
        out.push({ t: "sign", lines: [
          `SIGNED by the RECIPIENT: ${r.legal_name || r.display_name}${r.kind === "company" ? " (by its authorised signatory)" : ""} — electronically, below.`,
          "RECEIVED by THEPAYMASTER LIMITED as commercial agent for the Principal: Keirón Allen, Director, ka@thepaymaster.co.uk — on receipt of the Recipient's signature.",
        ] });
        continue;
      }
      out.push(b); continue;
    }
    if (b.t === "clause" && b.n === "1.1") {
      b.text = b.text.replace("[DESCRIPTION OF UNDERLYING TRANSACTION]", [tx.name, tx.detail].filter(Boolean).join(" — ") || `the transaction referenced ${tx.ref}`);
    }
    if (b.t === "clause" && b.n === "1.2") {
      b.text = b.text.replace("[AGREEMENT OR BASIS OF ENTITLEMENT, DATED]", `the arrangement described in Transaction Schedule ${tx.ref}`)
        .replace("[PERCENTAGE]%", e.pct === "—" ? "a fixed amount" : `${e.pct}%`)
        .replace("[TOTAL AMOUNT AND CURRENCY OR DIGITAL ASSET]", grossText)
        .replace("[ENTITLEMENT AMOUNT]", tx.converts
          ? `${tx.currency_in} ${format(e.amountMinor, tx.decimals_in)} before conversion, delivered in ${tx.currency_out} as the same share of what the desk returns`
          : `${tx.currency_out} ${format(e.amountMinor, tx.decimals_out)}`);
    }
    if (b.t === "tick") {
      const deducted = tx.fee_mode !== "grossed_up";
      if (b.text.startsWith("deducted from the gross")) b.text = `${deducted ? TICK : BOX} ${b.text}`;
      else if (b.text.startsWith("paid by the Principal")) b.text = `${deducted ? BOX : TICK} ${b.text}`;
      else if (b.text.startsWith("borne by the Recipient")) b.text = `${BOX} ${b.text.replace("[AMOUNT]", "—")}`;
      else if (b.text.startsWith("Method A")) { const a = tx.outbound === "fiat"; b.text = `${a ? TICK : BOX} ${b.text.replace("[    ]%", a ? "100%" : "0%").replace("[CURRENCY]", tx.currency_out)}`; }
      else if (b.text.startsWith("Method B")) b.text = `${modes.B ? TICK : BOX} ${b.text.replace("[    ]%", modes.B ? "100%" : "0%").replace("[ASSET]", tx.currency_out).replace("[NETWORK]", d?.chain ?? "—")}`;
      else if (b.text.startsWith("Method C")) b.text = `${modes.C ? TICK : BOX} ${b.text.replace("[    ]%", modes.C ? "100%" : "0%").replace("[ASSET]", tx.currency_out).replace("[NETWORK]", d?.chain ?? "—")}`;
      out.push(b); continue;
    }
    out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering: canonical text (hashed), HTML (signing screen), PDF (dossier)
// ---------------------------------------------------------------------------

function canonical(blocks: Block[]): string {
  return blocks.map((b) => {
    switch (b.t) {
      case "table": return b.rows.map((r) => r.join(" | ")).join("\n");
      case "sign": return b.lines.join("\n");
      case "def": return `"${b.term}" ${b.text}`;
      case "clause": case "sub": return `${b.n} ${b.text}`;
      default: return b.text;
    }
  }).join("\n");
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function toHtml(blocks: Block[]): string {
  return blocks.map((b) => {
    switch (b.t) {
      case "title": return `<h2 class="ag-title">${esc(b.text)}</h2>`;
      case "subtitle": return `<p class="ag-sub">${esc(b.text)}</p>`;
      case "h2": return `<h3 class="ag-h2">${esc(b.text)}</h3>`;
      case "h3": return `<h4 class="ag-h3">${esc(b.text)}</h4>`;
      case "p": return `<p>${esc(b.text)}</p>`;
      case "tick": return `<p class="ag-tick">${esc(b.text)}</p>`;
      case "clause": return `<p class="ag-clause"><span class="ag-n">${esc(b.n)}</span>${esc(b.text)}</p>`;
      case "sub": return `<p class="ag-sub-item"><span class="ag-n">${esc(b.n)}</span>${esc(b.text)}</p>`;
      case "def": return `<p class="ag-def"><b>"${esc(b.term)}"</b> ${esc(b.text)}</p>`;
      case "table": return `<div class="ag-tbl"><table>${b.rows.map((r, i) => `<tr>${r.map((c) => i === 0 && b.rows.length > 2 && b.rows[0].length > 2 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
      case "sign": return `<div class="ag-sign">${b.lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>`;
    }
  }).join("\n");
}

export const AGREEMENT_CSS = `
.ag{max-height:520px;overflow:auto;border:1px solid #DBDFEA;background:#fff;padding:18px 22px;font-size:13.5px;line-height:1.5}
.ag .ag-title{font-size:20px;margin:0 0 2px}.ag .ag-sub{color:#4A5567;margin:0 0 14px}
.ag .ag-h2{font-size:14px;margin:18px 0 6px;letter-spacing:.02em}.ag .ag-h3{font-size:13.5px;margin:14px 0 6px}
.ag p{margin:0 0 8px}.ag .ag-n{display:inline-block;min-width:38px;font-weight:600}.ag .ag-sub-item{padding-left:38px}.ag .ag-sub-item .ag-n{min-width:32px;margin-left:-32px}
.ag .ag-def{padding-left:14px}.ag .ag-tick{padding-left:14px}
.ag table{border-collapse:collapse;width:100%;font-size:12.5px;margin:6px 0 10px}.ag th,.ag td{border:1px solid #DBDFEA;padding:5px 7px;vertical-align:top;text-align:left}
.ag .ag-sign{background:#F5F7FA;padding:10px 12px;margin:10px 0}
`;

export function toPdf(blocks: Block[], o: { ref: string; kind: Kind; signedName: string; signedAt: string; ip?: string | null; hash: string; version: string }): Uint8Array {
  const title = o.kind === "sender_agreement" ? "Sender's Paymaster Agreement" : "Recipient's Authorisation and Payment Instruction";
  const pdf = new Pdf((p, n) => `ThePaymaster® — ${title} — ${o.ref} — ${o.version} — page ${p} of ${n}`);
  for (const b of blocks) {
    switch (b.t) {
      case "title": pdf.heading(b.text, 18); break;
      case "subtitle": pdf.para(b.text, { size: 10.5, colour: MUTED, after: 8 }); break;
      case "h2": pdf.heading(b.text, 12); break;
      case "h3": pdf.para(b.text, { face: "bold", size: 10.5, after: 4 }); break;
      case "p": pdf.para(b.text, { size: 9.5 }); break;
      case "tick": pdf.para(b.text, { size: 9.5, indent: 14 }); break;
      case "clause": pdf.para(`${b.n}  ${b.text}`, { size: 9.5 }); break;
      case "sub": pdf.para(`${b.n}  ${b.text}`, { size: 9.5, indent: 22 }); break;
      case "def": pdf.para(`"${b.term}"  ${b.text}`, { size: 9.5, indent: 12 }); break;
      case "table":
        if (b.rows[0]?.length === 2) {
          pdf.box(b.rows.map((r) => [r[0], r[1] || "—"] as [string, string]));
        } else {
          for (const r of b.rows) pdf.para(r.filter(Boolean).join("  |  "), { size: 8.5, face: "mono" });
        }
        break;
      case "sign": for (const l of b.lines) pdf.para(l, { size: 9.5, face: "bold" }); break;
    }
  }
  pdf.rule();
  pdf.heading("Electronic signature", 12);
  pdf.box([
    ["Signed by", o.signedName],
    ["Signed at", `${o.signedAt} UTC`],
    ["From", o.ip ?? "not recorded"],
    ["Content hash", o.hash, true],
    ["Template", o.version],
  ]);
  pdf.para("The signer typed their name against the document above in their ThePaymaster account, after verifying their identity to ThePaymaster. " +
    "The content hash is the SHA-256 of the exact text shown; the same hash is recorded in the transaction's sealed record.", { size: 8.5, colour: MUTED });
  return pdf.bytes();
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export interface Rendered { kind: Kind; blocks: Block[]; hash: string; html: string }

/** The document a party should sign right now, filled from the record as it stands. */
export async function render(env: Env, txId: string, partyId: string): Promise<Rendered | null> {
  const f = await facts(env, txId);
  if (!f) return null;
  let blocks: Block[] | null; let kind: Kind;
  if (f.sender?.id === partyId) { kind = "sender_agreement"; blocks = fillSender(env, f); }
  else {
    const r = f.recipients.find((x) => x.id === partyId);
    if (!r) return null;
    kind = "recipient_authorisation"; blocks = fillRecipient(env, f, r.participation_id);
  }
  if (!blocks) return null;
  return { kind, blocks, hash: await sha256(canonical(blocks)), html: toHtml(blocks) };
}

export interface Status { state: "unsigned" | "signed" | "stale"; kind: Kind; latest: any | null; current: Rendered | null }

/** Signed, and does the signature still cover the facts as they stand? */
export async function status(env: Env, txId: string, partyId: string): Promise<Status | null> {
  const current = await render(env, txId, partyId);
  if (!current) return null;
  const latest = await env.DB.prepare(
    "SELECT * FROM agreements WHERE transaction_id = ? AND party_id = ? ORDER BY signed_at DESC, rowid DESC LIMIT 1").bind(txId, partyId).first<any>();
  if (!latest) return { state: "unsigned", kind: current.kind, latest: null, current };
  return { state: latest.content_hash === current.hash ? "signed" : "stale", kind: current.kind, latest, current };
}

/** The party signs what they were shown. The hash they saw must be the hash now. */
export async function sign(env: Env, actor: Actor, txId: string, partyId: string, o: {
  typedName: string; shownHash: string; ip?: string; agent?: string; signerPartyId?: string;
}): Promise<string | null> {
  const current = await render(env, txId, partyId);
  if (!current) return "There is no agreement to sign on this transaction.";
  if (current.hash !== o.shownHash) return "The transaction changed while you were reading. The document has been refreshed — please read it again and sign.";
  const party = await env.DB.prepare("SELECT display_name, legal_name FROM parties WHERE id = ?").bind(partyId).first<any>();
  const signer = o.signerPartyId && o.signerPartyId !== partyId
    ? await env.DB.prepare("SELECT display_name FROM parties WHERE id = ?").bind(o.signerPartyId).first<any>() : null;
  const typed = o.typedName.trim();
  if (typed.length < 3) return "Please type your full name to sign.";
  const expected = signer?.display_name ?? party?.display_name ?? "";
  if (!resembles(typed, String(expected)) && !(party?.legal_name && resembles(typed, String(party.legal_name)))) {
    return `Please sign with your own name, as we hold it: ${expected}.`;
  }
  const tx = await env.DB.prepare("SELECT ref FROM transactions WHERE id = ?").bind(txId).first<any>();
  const part = await env.DB.prepare("SELECT id FROM participations WHERE transaction_id = ? AND party_id = ? AND role IN ('sender','recipient') LIMIT 1").bind(txId, partyId).first<any>();
  const signedAt = stamp();
  const rowId = id("agr");
  const pdf = toPdf(current.blocks, { ref: tx.ref, kind: current.kind, signedName: typed, signedAt, ip: o.ip ?? null, hash: current.hash, version: VERSION });
  const label = current.kind === "sender_agreement" ? "Sender's Paymaster Agreement" : "Recipient's Authorisation";
  const safe = String(party?.display_name ?? "party").replace(/[^A-Za-z0-9]+/g, "_");
  const stored = await store(env, actor, new File([pdf as BlobPart], `${tx.ref}-${label.replace(/[^A-Za-z]+/g, "_")}-${safe}.pdf`, { type: "application/pdf" }),
    { kind: "agreement", label: `${label} — signed by ${typed}`, partyId, transactionId: txId, shared: true });
  await insert(env.DB, actor, "agreement.signed", "agreements", rowId, {
    transaction_id: txId, party_id: partyId, participation_id: part?.id ?? null, kind: current.kind, version: VERSION,
    content_json: JSON.stringify(current.blocks), content_hash: current.hash,
    signed_name: typed, signed_at: signedAt, signed_ip: o.ip ?? null, signed_agent: (o.agent ?? "").slice(0, 200) || null,
    signer_party_id: o.signerPartyId ?? partyId, artefact_id: stored.artefactId,
  }, { note: `${label} ${VERSION} signed by ${typed}; hash ${current.hash.slice(0, 16)}…` });
  return null;
}

/** One line per party the transaction needs a signature from, for staff and for readiness. */
export async function forTransaction(env: Env, txId: string): Promise<{ partyId: string; participationId: string; name: string; role: string; state: Status["state"]; latest: any | null; kind: Kind }[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id AS participation_id, p.role, y.id AS party_id, y.display_name FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ? AND p.role IN ('sender','recipient') ORDER BY p.role DESC, y.display_name`).bind(txId).all<any>();
  const out = [];
  for (const r of results ?? []) {
    const s = await status(env, txId, r.party_id);
    out.push({ partyId: r.party_id, participationId: r.participation_id, name: r.display_name, role: r.role,
      state: s?.state ?? "unsigned", latest: s?.latest ?? null, kind: (s?.kind ?? (r.role === "sender" ? "sender_agreement" : "recipient_authorisation")) as Kind });
  }
  return out;
}

export { paysDirect };
