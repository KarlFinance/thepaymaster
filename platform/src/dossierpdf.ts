/**
 * The dossier as a PDF.
 *
 * The same facts, leaves, root and seals the HTML shows, laid out for a file
 * rather than a screen. Pure: it takes what build() and seals() return and
 * gives back bytes, so it can be produced for the download bundle, served on
 * its own, and tested without a database.
 */

import { Pdf } from "./pdf.ts";
import { type Fact, type Seal, ALGORITHM } from "./dossier.ts";
import { format } from "./money.ts";
import { type Attestation } from "./attestation.ts";

export interface DossierDoc { name: string; sha256: string; label: string }

export function dossierPdf(o: {
  tx: { ref: string; name?: string | null; decimals_in?: number | null; summary?: string | null };
  facts: Fact[];
  leaves: string[];
  root: string;
  seals: Seal[];
  documents: DossierDoc[];
  producedAt?: string;
  attestation?: Attestation | null;
}): Uint8Array {
  const latest = o.seals[0] as any | undefined;
  const decimals = o.tx.decimals_in ?? 2;
  const pdf = new Pdf((page, total) =>
    `ThePaymaster — dossier ${o.tx.ref} — root ${o.root.slice(0, 16)}… — page ${page} of ${total}`);

  // --- title ----------------------------------------------------------------
  pdf.heading("Transaction dossier", 22);
  pdf.para(`${o.tx.ref}${o.tx.name ? ` — ${o.tx.name}` : ""}`, { face: "bold", size: 13, after: 2 });
  pdf.para("Produced by ThePaymaster Ltd, 85 Great Portland Street, First Floor, London W1W 7LT. " +
    "Every fact below was recorded at the time it happened and cannot be edited afterwards. " +
    `Produced ${(o.producedAt ?? new Date().toISOString()).replace("T", " ").slice(0, 16)} UTC.`,
    { size: 9, colour: "0.353 0.420 0.502", after: 10 });

  if (o.tx.summary) {
    pdf.heading("Executive summary", 13);
    pdf.para(String(o.tx.summary), { size: 10.5, after: 8 });
  }

  // --- seal -----------------------------------------------------------------
  const sealRows: [string, string, boolean?][] = [
    ["Root, as the record stands", o.root, true],
    ["Facts", String(o.leaves.length)],
    ["Algorithm", ALGORITHM, true],
  ];
  if (latest) {
    sealRows.push(["Sealed", `${latest.sealed_at} — ${latest.leaf_count} facts`]);
    sealRows.push(["Sealed root", latest.root, true]);
    if (latest.root !== o.root) sealRows.push(["Note", "The record has changed since this seal. Facts have been added; seal again when complete."]);
    if (latest.anchor_tx_hash) {
      sealRows.push(["Published on Ethereum", `chain ${latest.anchor_chain_id}${latest.anchored_at ? `, block time ${latest.anchored_at} UTC` : ""}`]);
      sealRows.push(["Anchor transaction", latest.anchor_tx_hash, true]);
    }
    if (o.attestation) {
      sealRows.push(["Signed by ThePaymaster", `EIP-712 signature by ${o.attestation.attester} over (ref, root, facts, sealed-at, algorithm); verify with any Ethereum library or at the public verifier.`]);
      sealRows.push(["Signature", o.attestation.signature, true]);
    }
  } else {
    sealRows.push(["Sealed", "Not yet sealed. The root above is what a seal would commit to now."]);
  }
  pdf.box(sealRows, "Seal");
  if (latest) pdf.status(latest.root === o.root ? "Sealed and unchanged since." : "Sealed; the record has changed since.", latest.root === o.root);
  else pdf.status("Unsealed working copy.", false);

  // --- documents ------------------------------------------------------------
  pdf.heading("Documents in the bundle", 13);
  if (!o.documents.length) {
    pdf.para("No files were uploaded to this transaction or its parties.", { colour: "0.353 0.420 0.502" });
  } else {
    pdf.para("Each file's SHA-256 was taken as it arrived. Hash the file in the documents folder and compare: a match proves it is the file that was recorded.", { size: 9, colour: "0.353 0.420 0.502" });
    for (const d of o.documents) {
      pdf.row(d.label, `documents/${d.name}`, { mono: true });
      pdf.row("", `sha256 ${d.sha256}`, { mono: true, colour: "0.353 0.420 0.502" });
    }
  }

  // --- the facts, grouped -------------------------------------------------------
  const groups = new Map<string, number[]>();
  o.facts.forEach((f, i) => {
    const g = f.kind.replace(/^\d+[a-z]?-/, "").replace(/-/g, " ");
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(i);
  });
  const value = (k: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/_minor$/.test(k) && /^-?\d+$/.test(s)) return `${format(Number(s), decimals)}  (${s} minor)`;
    return s;
  };
  const looksHex = (s: string) => /^(0x)?[0-9a-fA-F]{20,}$/.test(s) || /^(bc|tb)1[0-9a-z]{20,}$/i.test(s);

  for (const [g, idx] of groups) {
    // A heading with nothing under it at the foot of a page is worse than a
    // little white space: keep the heading with its first fact.
    pdf.ensure(110);
    pdf.space(6);
    pdf.heading(g.charAt(0).toUpperCase() + g.slice(1), 13);
    pdf.rule("0.106 0.141 0.188", 1);
    for (const i of idx) {
      const f = o.facts[i];
      pdf.ensure(60);
      pdf.para(`${i + 1}. ${f.title}`, { face: "bold", size: 10.5, after: 2 });
      for (const [k, v] of Object.entries(f.data)) {
        if (v === null || v === undefined || v === "") continue;
        const text = value(k, v);
        pdf.row(k.replace(/_/g, " "), text, { mono: looksHex(text) });
      }
      pdf.row("leaf", o.leaves[i], { mono: true, colour: "0.541 0.592 0.659" });
      pdf.rule();
    }
  }

  // --- how to verify -----------------------------------------------------------
  pdf.space(6);
  pdf.heading("How to verify this dossier without trusting us", 13);
  pdf.numbered([
    "Take one fact. Serialise it as JSON containing exactly its kind, its id and its data, with object keys sorted by Unicode code point, no whitespace, and any null or empty value omitted. Encode as UTF-8 and take the SHA-256. That is its leaf, printed beneath it.",
    "Order every leaf by kind, then by id, both ascending as strings.",
    "Pair them left to right. Each parent is the SHA-256 of its two children's digests concatenated as raw bytes — not as hex text. A node with no partner is promoted unchanged; it is never duplicated.",
    "Repeat until one hash remains. It must equal the root on the first page.",
  ]);
  pdf.para("dossier.json in the bundle carries the same facts, leaves and root in machine-readable form.", { size: 9, colour: "0.353 0.420 0.502" });

  return pdf.bytes();
}
