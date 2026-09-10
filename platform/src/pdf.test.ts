/**
 * The PDF writer: a well-formed file whose cross-reference table points at
 * every object, with the text we put in.
 *
 *   node --experimental-strip-types src/pdf.test.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dossierPdf } from "./dossierpdf.ts";

let bad = 0;
const check = (n: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log(`  FAIL ${n}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${n}`);
};

const facts = Array.from({ length: 40 }, (_, i) => ({
  kind: i < 3 ? "02-party" : i < 20 ? "06-destination" : "10-audit",
  id: `id_${String(i).padStart(3, "0")}`,
  title: i < 3 ? `Party — Person ${i}` : i < 20 ? "Destination" : `audit.event_${i}`,
  data: { id: `id_${i}`, address: "0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e", amount_minor: 495003 * (i + 1),
          note: "A note with an em dash — and “quotes” and £ signs, long enough to need wrapping across the column width more than once over.",
          empty: null },
}));
const leaves = facts.map((_, i) => "ab".repeat(16) + String(i).padStart(32, "0"));
const bytes = dossierPdf({
  tx: { ref: "TPM-2026-0002", name: "Test distribution", decimals_in: 6 },
  facts, leaves, root: "c".repeat(64),
  seals: [{ id: "seal_1", transaction_id: "tx", root: "c".repeat(64), leaf_count: 40, sealed_at: "2026-09-09 12:00:00",
            anchor_tx_hash: "0x" + "d".repeat(64), anchor_chain_id: 1, anchored_at: "2026-09-09 12:10:11" } as any],
  documents: [{ name: "art_1-passport.png", sha256: "e".repeat(64), label: "passport" }],
  producedAt: "2026-09-10T18:00:00Z",
});

const text = Buffer.from(bytes).toString("latin1");
check("header", text.startsWith("%PDF-1.4"), true);
check("ends with EOF", text.trimEnd().endsWith("%%EOF"), true);
const startxref = Number(text.match(/startxref\n(\d+)/)![1]);
check("startxref points at xref", text.slice(startxref, startxref + 4), "xref");
const count = Number(text.match(/xref\n0 (\d+)/)![1]);
const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
check("xref has one entry per object", entries.length, count - 1);
let mis = 0;
entries.forEach((off, i) => { if (!text.slice(off).startsWith(`${i + 1} 0 obj`)) mis++; });
check("every offset lands on its object", mis, 0);
const pages = Number(text.match(/\/Count (\d+)/)![1]);
check("several pages", pages > 3, true);
check("page objects match count", (text.match(/\/Type \/Page\b/g) || []).length, pages);
check("content lengths are exact", [...text.matchAll(/\/Length (\d+) >>\nstream\n/g)].every((m) => {
  const start = m.index! + m[0].length; return text.slice(start + Number(m[1]), start + Number(m[1]) + 10).startsWith("\nendstream");
}), true);
check("title text present", text.includes("(Transaction dossier)"), true);
check("em dash encoded as WinAnsi 0x97", text.includes("\\227"), true);
check("root printed", text.includes("(" + "c".repeat(64) + ")"), true);
check("footer with page count", /page 1 of \d+/.test(text), true);
check("no raw non-Latin bytes leaked", !/[^\x00-\xff]/.test(text), true);

const path = `${process.env.TMPDIR ?? "/tmp"}/tpm-dossier-test.pdf`;
writeFileSync(path, bytes);
const kind = execFileSync("file", ["-b", path]).toString().trim();
check("file(1) recognises a PDF", kind.startsWith("PDF document"), true);
console.log(`  (written to ${path}, ${bytes.length} bytes, ${pages} pages)`);
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
