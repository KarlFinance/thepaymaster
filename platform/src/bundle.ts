/**
 * The dossier as a file somebody can keep.
 *
 * The page is the working view; this is what goes in the compliance file. A
 * ZIP with three kinds of thing in it:
 *
 *   dossier.html   — the whole record as one self-contained document, no
 *                    external assets, printable, readable in any browser
 *   dossier.json   — every fact, every leaf, the root and the seals, in the
 *                    form a program (or an auditor's script) can verify
 *   documents/…    — every file uploaded to the transaction or to any party on
 *                    it, named by id so it matches its entry in the record
 *
 * The ZIP is written here, by hand, without compression. Documents are already
 * compressed (PDFs, JPEGs); the HTML and JSON are small; and a stored ZIP is
 * the one every unzipper on earth reads without argument. Zero dependencies
 * is worth more than a few kilobytes.
 */

import { type Env } from "./db.ts";
import { build, seals, ALGORITHM, type Fact } from "./dossier.ts";
import { format } from "./money.ts";
import { dossierPdf } from "./dossierpdf.ts";
import { folderData, folderEntries, folderName } from "./folder.ts";
import { attestationFor } from "./attestation.ts";

// ---------------------------------------------------------------------------
// ZIP, stored method
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** MS-DOS time and date, which is what ZIP carries. Two-second resolution. */
function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

interface Entry { name: string; data: Uint8Array }

export function zip(entries: Entry[], when = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { time, date } = dosStamp(when);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => [v & 0xFF, (v >>> 8) & 0xFF];
  const u32 = (v: number) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    // Bit 11: the name is UTF-8. Method 0: stored.
    const head = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(e.data.length), ...u32(e.data.length),
      ...u16(name.length), ...u16(0),
    ]);
    const local = new Uint8Array(head.length + name.length + e.data.length);
    local.set(head, 0); local.set(name, head.length); local.set(e.data, head.length + name.length);
    locals.push(local);

    const central = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(time), ...u16(date), ...u32(crc), ...u32(e.data.length), ...u32(e.data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...name,
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);

  const total = offset + cdSize + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(end, p);
  return out;
}

// ---------------------------------------------------------------------------
// The dossier's contents
// ---------------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "file";
}

/**
 * A complete HTML document with nothing external in it: no fonts, no images,
 * no links out. It has to open, and look the same, in a browser that has never
 * heard of us and never will.
 */
function html(tx: any, facts: Fact[], leaves: string[], root: string,
              sealRows: any[], docs: { name: string; sha256: string; label: string }[]): string {
  const decimals = tx.decimals_in ?? 2;
  const val = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return "—";
    const s = String(v);
    if (/_minor$/.test(k) && /^-?\d+$/.test(s)) return `${esc(format(Number(s), decimals))} <small>(${esc(s)} minor)</small>`;
    return esc(s);
  };
  const groups = new Map<string, string[]>();
  facts.forEach((f, i) => {
    const g = f.kind.replace(/^\d+[a-z]?-/, "").replace(/-/g, " ");
    const rows = Object.entries(f.data)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `<tr><th>${esc(k.replace(/_/g, " "))}</th><td>${val(k, v)}</td></tr>`).join("");
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(
      `<section class="fact"><h3>${i + 1}. ${esc(f.title)}</h3><table>${rows}</table>
       <p class="leaf">leaf ${esc(leaves[i])}</p></section>`);
  });
  const latest = sealRows[0];

  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<title>Dossier — ${esc(tx.ref)}</title>
<style>
body{margin:0;padding:40px 48px;font:15px/1.55 Georgia,"Times New Roman",serif;color:#1b2430;background:#fff;max-width:900px}
h1{font:700 30px/1.15 -apple-system,Helvetica,Arial,sans-serif;margin:0 0 4px}
h2{font:700 17px/1.3 -apple-system,Helvetica,Arial,sans-serif;margin:34px 0 8px;border-top:2px solid #1b2430;padding-top:14px}
h3{font:700 14px/1.3 -apple-system,Helvetica,Arial,sans-serif;margin:0 0 6px}
.muted{color:#5a6b80}.mono{font:12.5px ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
table{border-collapse:collapse;width:100%;font-size:13.5px}th{text-align:left;width:220px;vertical-align:top;color:#5a6b80;font-weight:600;padding:3px 10px 3px 0}td{padding:3px 0}
.fact{border-top:1px solid #e3e7ee;padding:12px 0;break-inside:avoid}.leaf{color:#8a97a8;font:12px ui-monospace,Menlo,Consolas,monospace;margin:6px 0 0;word-break:break-all}
.seal{background:#f5f7fa;border:1px solid #dde2ea;border-radius:8px;padding:16px 18px;margin:16px 0}
ol li{margin-bottom:8px}
@media print{body{padding:0}.fact{break-inside:avoid}}
</style></head><body>
<h1>Transaction dossier</h1>
<p><b>${esc(tx.ref)}</b> — ${esc(tx.name ?? "")}<br>
<span class="muted">Produced by ThePaymaster Ltd, 167-169 The Fifth Floor, Great Portland Street, London W1W 5PF.
Every fact below was recorded at the time it happened and cannot be edited afterwards.</span></p>

<div class="seal">
<h3>Seal</h3>
<table>
<tr><th>Root, as the record stands</th><td class="mono">${esc(root)}</td></tr>
<tr><th>Facts</th><td>${leaves.length}</td></tr>
<tr><th>Algorithm</th><td class="mono">${esc(ALGORITHM)}</td></tr>
${latest ? `<tr><th>Sealed</th><td>${esc(latest.sealed_at)} — root <span class="mono">${esc(latest.root)}</span>${
  latest.root !== root ? " <b>(the record has changed since this seal)</b>" : ""}</td></tr>` : `<tr><th>Sealed</th><td>Not yet sealed</td></tr>`}
${latest?.anchor_tx_hash ? `<tr><th>Published on Ethereum</th><td>block time ${esc(latest.anchored_at)} UTC — transaction <span class="mono">${esc(latest.anchor_tx_hash)}</span></td></tr>` : ""}
</table>
</div>

<h2>Documents in this bundle</h2>
${docs.length ? `<table>${docs.map((d) => `<tr><th>${esc(d.label)}</th><td><span class="mono">documents/${esc(d.name)}</span><br><span class="mono muted">sha256 ${esc(d.sha256)}</span></td></tr>`).join("")}</table>`
  : `<p class="muted">No files were uploaded to this transaction.</p>`}
<p class="muted">Hash any file in the documents folder and compare it with the sha256 in its entry below: if they match, the file is the one that was recorded.</p>

${[...groups].map(([g, blocks]) => `<h2>${esc(g.charAt(0).toUpperCase() + g.slice(1))}</h2>${blocks.join("")}`).join("")}

<h2>How to verify this dossier without trusting us</h2>
<ol>
<li>Take one fact. Serialise it as JSON containing exactly its <i>kind</i>, its <i>id</i> and its <i>data</i>, with object keys sorted by Unicode code point, no whitespace, and any null or empty value omitted. Encode as UTF-8 and take the SHA-256. That is its leaf, printed beneath it.</li>
<li>Order every leaf by kind, then by id, both ascending as strings.</li>
<li>Pair them left to right. Each parent is the SHA-256 of its two children's digests concatenated as raw bytes — not as hex text. A node with no partner is promoted unchanged; it is never duplicated.</li>
<li>Repeat until one hash remains. It must equal the root above.</li>
</ol>
<p class="muted">dossier.json in this bundle carries the same facts, leaves and root in machine-readable form.</p>
</body></html>`;
}

/** Everything about a transaction, as one downloadable file. */
export async function dossierBundle(env: Env, txId: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!tx) return null;

  const built = await build(env, txId);
  const sealRows = await seals(env, txId);

  // Every file on the transaction or on anyone on it.
  const { results: arts } = await env.DB.prepare(
    `SELECT id, kind, label, filename, content_type, sha256, r2_key FROM artefacts
      WHERE transaction_id = ?
         OR party_id IN (SELECT party_id FROM participations WHERE transaction_id = ?)
      ORDER BY uploaded_at`).bind(txId, txId).all<any>();

  const entries: Entry[] = [];
  const listed: { name: string; sha256: string; label: string }[] = [];
  for (const a of arts ?? []) {
    try {
      const obj = await env.DOCS.get(a.r2_key);
      if (!obj) continue;
      const data = new Uint8Array(await obj.arrayBuffer());
      const name = `${a.id}-${safeName(a.filename ?? a.kind ?? "document")}`;
      entries.push({ name: `documents/${name}`, data });
      listed.push({ name, sha256: a.sha256, label: a.label ?? a.kind ?? "Document" });
    } catch { /* a missing object is noted by its absence from the list */ }
  }

  // One folder per party: their statement, their own record with proofs, and
  // their documents — the thing to send them, ready-made.
  const { results: partyRows } = await env.DB.prepare(
    `SELECT DISTINCT y.id, y.legal_name, y.display_name FROM participations p
       JOIN parties y ON y.id = p.party_id WHERE p.transaction_id = ? ORDER BY y.display_name`)
    .bind(txId).all<any>();
  for (const y of partyRows ?? []) {
    const d = await folderData(env, txId, y.id, "staff");
    if (!d) continue;
    const folder = folderName(y.legal_name || y.display_name);
    for (const e of await folderEntries(env, d)) entries.push({ name: `parties/${folder}/${e.name}`, data: e.data });
  }

  const enc = new TextEncoder();
  const producedAt = new Date().toISOString();
  const attestation = sealRows[0] ? await attestationFor(env, sealRows[0], tx.ref) : null;
  entries.unshift(
    { name: "dossier.pdf", data: dossierPdf({ tx, facts: built.facts, leaves: built.leaves, root: built.root,
        seals: sealRows, documents: listed, producedAt, attestation }) },
    { name: "dossier.html", data: enc.encode(html(tx, built.facts, built.leaves, built.root, sealRows, listed)) },
    { name: "dossier.json", data: enc.encode(JSON.stringify({
        transaction: { id: tx.id, ref: tx.ref, name: tx.name },
        algorithm: ALGORITHM,
        root: built.root,
        facts: built.facts.map((f, i) => ({ kind: f.kind, id: f.id, title: f.title, leaf: built.leaves[i], data: f.data })),
        seals: sealRows,
        attestation,
        documents: listed,
        produced_at: new Date().toISOString(),
      }, null, 2)) },
  );

  return { name: `${tx.ref}-dossier.zip`, bytes: zip(entries) };
}

/** The PDF on its own, for the dossier page's link. */
export async function dossierPdfFor(env: Env, txId: string): Promise<{ name: string; bytes: Uint8Array } | null> {
  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!tx) return null;
  const built = await build(env, txId);
  const sealRows = await seals(env, txId);
  const { results: arts } = await env.DB.prepare(
    `SELECT id, kind, label, filename, sha256 FROM artefacts
      WHERE transaction_id = ?
         OR party_id IN (SELECT party_id FROM participations WHERE transaction_id = ?)
      ORDER BY uploaded_at`).bind(txId, txId).all<any>();
  const documents = (arts ?? []).map((a: any) => ({
    name: `${a.id}-${(a.filename ?? a.kind ?? "document").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}`,
    sha256: a.sha256, label: a.label ?? a.kind ?? "Document",
  }));
  const attestation = sealRows[0] ? await attestationFor(env, sealRows[0], tx.ref) : null;
  return { name: `${tx.ref}-dossier.pdf`, bytes: dossierPdf({
    tx, facts: built.facts, leaves: built.leaves, root: built.root, seals: sealRows, documents, attestation }) };
}
