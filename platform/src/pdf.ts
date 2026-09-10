/**
 * A PDF writer with no dependencies, for the one document that has to be a PDF.
 *
 * The dossier is what a compliance officer files. HTML is what they read on
 * screen; a PDF is what goes in the file, gets attached to an email to a
 * bank, and is opened in five years by somebody with nothing but a PDF reader.
 * A Worker has no browser to print with, so the PDF is written here from the
 * facts themselves: the fourteen standard fonts, WinAnsi text, one content
 * stream per page, a correct cross-reference table. Every reader on earth
 * opens that.
 *
 * Layout is a cursor moving down A4 pages: headings, paragraphs, label/value
 * rows, rules, page breaks; footers with the page count are written once the
 * count is known.
 */

// ---------------------------------------------------------------------------
// Fonts: metrics for the standard Helvetica faces (AFM widths, /1000 em)
// ---------------------------------------------------------------------------

const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

export type Face = "regular" | "bold" | "mono";
const FONT_NAME: Record<Face, string> = { regular: "Helvetica", bold: "Helvetica-Bold", mono: "Courier" };
const FONT_REF: Record<Face, string> = { regular: "/F1", bold: "/F2", mono: "/F3" };

/** WinAnsi for the characters that matter to us; anything else becomes "?". */
const WINANSI: Record<string, number> = {
  "—": 0x97, "–": 0x96, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94,
  "…": 0x85, "•": 0x95, "£": 0xa3, "€": 0x80, "©": 0xa9, "®": 0xae,
  "°": 0xb0, "×": 0xd7, "é": 0xe9, "è": 0xe8, "à": 0xe0, "ç": 0xe7,
  "ü": 0xfc, "ö": 0xf6, "ä": 0xe4, "ñ": 0xf1, "í": 0xed, "ó": 0xf3,
  "á": 0xe1, "ú": 0xfa, "É": 0xc9, " ": 0x20, "✓": 0x2b, "✗": 0x2d,
};

function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c < 127) out.push(c);
    else if (WINANSI[ch] !== undefined) out.push(WINANSI[ch]);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else out.push(0x3f);
  }
  return out;
}

function widthOf(text: string, face: Face, size: number): number {
  const codes = encode(text);
  if (face === "mono") return codes.length * 600 * size / 1000;
  const table = face === "bold" ? HELV_BOLD : HELV;
  let w = 0;
  for (const c of codes) w += (c >= 32 && c < 127) ? table[c - 32] : 556;
  return w * size / 1000;
}

/** Break text into lines no wider than `max`, breaking long unbroken runs (hashes) by character. */
function wrap(text: string, face: Face, size: number, max: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    const push = () => { if (line) lines.push(line); line = ""; };
    for (let word of words) {
      // A word wider than the whole line (an address, a hash) is cut where it must be.
      while (widthOf(word, face, size) > max) {
        let cut = word.length;
        while (cut > 1 && widthOf(word.slice(0, cut), face, size) > max - (line ? widthOf(line + " ", face, size) : 0)) cut--;
        if (cut <= 1) { push(); cut = word.length; while (cut > 1 && widthOf(word.slice(0, cut), face, size) > max) cut--; }
        line = line ? `${line} ${word.slice(0, cut)}` : word.slice(0, cut);
        push();
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (widthOf(candidate, face, size) <= max) line = candidate;
      else { push(); line = word; }
    }
    push();
    if (!words.length) lines.push("");
  }
  return lines;
}

const esc = (bytes: number[]) => {
  let s = "";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += "\\" + String.fromCharCode(b);
    else if (b < 32 || b > 126) s += "\\" + b.toString(8).padStart(3, "0");
    else s += String.fromCharCode(b);
  }
  return s;
};

// ---------------------------------------------------------------------------
// The page and the cursor
// ---------------------------------------------------------------------------

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = { top: 56, right: 48, bottom: 56, left: 48 };
const INK = "0.106 0.141 0.188";       // #1B2430
const MUTED = "0.353 0.420 0.502";     // #5A6B80
const RULE = "0.855 0.882 0.918";      // #DAE1EA
const GOOD = "0.106 0.498 0.294";
const BAD = "0.541 0.122 0.067";

export class Pdf {
  private pages: string[][] = [];
  private y = 0;
  private readonly width = A4.w - MARGIN.left - MARGIN.right;
  private footer: (page: number, total: number) => string;

  constructor(footer: (page: number, total: number) => string) {
    this.footer = footer;
    this.newPage();
  }

  private get ops(): string[] { return this.pages[this.pages.length - 1]; }
  get pageCount(): number { return this.pages.length; }

  newPage(): void {
    this.pages.push([]);
    this.y = A4.h - MARGIN.top;
  }

  /** Move to a new page if fewer than `need` points remain. */
  ensure(need: number): void {
    if (this.y - need < MARGIN.bottom) this.newPage();
  }

  space(pt: number): void { this.y -= pt; }

  private textAt(x: number, y: number, text: string, face: Face, size: number, colour = INK): void {
    this.ops.push(`BT ${FONT_REF[face]} ${size} Tf ${colour} rg ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(encode(text))}) Tj ET`);
  }

  private textWidth(text: string, face: Face, size: number): number { return widthOf(text, face, size); }

  heading(text: string, size = 16, colour = INK): void {
    const lines = wrap(text, "bold", size, this.width);
    this.ensure(lines.length * size * 1.25 + 6);
    for (const l of lines) { this.textAt(MARGIN.left, this.y - size, l, "bold", size, colour); this.y -= size * 1.25; }
    this.y -= 4;
  }

  para(text: string, o: { size?: number; face?: Face; colour?: string; indent?: number; after?: number } = {}): void {
    const size = o.size ?? 10, face = o.face ?? "regular", indent = o.indent ?? 0;
    const lead = size * 1.4;
    const lines = wrap(text, face, size, this.width - indent);
    for (const l of lines) {
      this.ensure(lead);
      this.textAt(MARGIN.left + indent, this.y - size, l, face, size, o.colour ?? INK);
      this.y -= lead;
    }
    this.y -= o.after ?? 4;
  }

  /** A label in the left column and a wrapped value in the right. */
  row(label: string, value: string, o: { mono?: boolean; labelWidth?: number; colour?: string } = {}): void {
    const lead = 12, lw = o.labelWidth ?? 150;
    const face: Face = o.mono ? "mono" : "regular";
    const size = o.mono ? 8 : 9;
    const valueLines = wrap(value || "—", face, size, this.width - lw - 8);
    const labelLines = wrap(label, "regular", 9, lw - 8);
    const n = Math.max(valueLines.length, labelLines.length);
    this.ensure(n * lead + 2);
    for (let i = 0; i < n; i++) {
      if (labelLines[i]) this.textAt(MARGIN.left, this.y - 9, labelLines[i], "regular", 9, MUTED);
      if (valueLines[i]) this.textAt(MARGIN.left + lw, this.y - size, valueLines[i], face, size, o.colour ?? INK);
      this.y -= lead;
    }
    this.y -= 2;
  }

  rule(colour = RULE, weight = 0.6): void {
    this.ensure(8);
    this.ops.push(`${colour} RG ${weight} w ${MARGIN.left} ${(this.y - 2).toFixed(2)} m ${(A4.w - MARGIN.right).toFixed(2)} ${(this.y - 2).toFixed(2)} l S`);
    this.y -= 8;
  }

  /** A shaded box with rows inside — the seal. */
  box(rows: [string, string, boolean?][], title?: string): void {
    const size = 9, lead = 12;
    const est = 14 + (title ? 18 : 0) + rows.reduce((n, [, v, mono]) =>
      n + Math.max(1, wrap(v || "—", mono ? "mono" : "regular", mono ? 8 : size, this.width - 150 - 24).length) * lead + 2, 0);
    this.ensure(est + 8);
    const top = this.y;
    // Draw the background after measuring; PDF paints in order, so record a placeholder.
    const at = this.ops.length;
    this.ops.push("");
    this.y -= 10;
    if (title) { this.textAt(MARGIN.left + 12, this.y - 11, title, "bold", 11); this.y -= 18; }
    for (const [k, v, mono] of rows) {
      const face: Face = mono ? "mono" : "regular";
      const vs = mono ? 8 : size;
      const vl = wrap(v || "—", face, vs, this.width - 150 - 24);
      for (let i = 0; i < vl.length; i++) {
        if (i === 0) this.textAt(MARGIN.left + 12, this.y - size, k, "regular", size, MUTED);
        this.textAt(MARGIN.left + 12 + 150, this.y - vs, vl[i], face, vs);
        this.y -= lead;
      }
      this.y -= 2;
    }
    this.y -= 6;
    const h = top - this.y;
    this.ops[at] = `0.961 0.969 0.980 rg ${MARGIN.left} ${this.y.toFixed(2)} ${this.width.toFixed(2)} ${h.toFixed(2)} re f`;
    this.y -= 10;
  }

  status(text: string, good: boolean): void {
    this.para(text, { face: "bold", size: 10, colour: good ? GOOD : BAD, after: 6 });
  }

  numbered(items: string[]): void {
    items.forEach((t, i) => {
      const size = 10, lead = 14, indent = 18;
      const lines = wrap(t, "regular", size, this.width - indent);
      this.ensure(lines.length * lead);
      this.textAt(MARGIN.left, this.y - size, `${i + 1}.`, "bold", size);
      for (const l of lines) { this.textAt(MARGIN.left + indent, this.y - size, l, "regular", size); this.y -= lead; }
      this.y -= 3;
    });
  }

  // -------------------------------------------------------------------------

  /** The finished file. */
  bytes(): Uint8Array {
    const total = this.pages.length;
    const objects: (string | Uint8Array)[] = [];
    const add = (o: string | Uint8Array) => { objects.push(o); return objects.length; };

    // 1 catalog, 2 pages, 3-5 fonts, then per page: page object + content.
    add(""); add(""); // placeholders for catalog and pages tree
    const f1 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAME.regular} /Encoding /WinAnsiEncoding >>`);
    const f2 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAME.bold} /Encoding /WinAnsiEncoding >>`);
    const f3 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAME.mono} /Encoding /WinAnsiEncoding >>`);
    const pageIds: number[] = [];
    this.pages.forEach((ops, i) => {
      const foot = this.footer(i + 1, total);
      const footOps = `BT /F1 8 Tf ${MUTED} rg ${MARGIN.left} ${(MARGIN.bottom - 24).toFixed(2)} Td (${esc(encode(foot))}) Tj ET`;
      const stream = new TextEncoder().encode([...ops, footOps].join("\n"));
      const contentId = add(concat(new TextEncoder().encode(`<< /Length ${stream.length} >>\nstream\n`), stream, new TextEncoder().encode("\nendstream")));
      const pageId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    });
    objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${total} >>`;

    const enc = new TextEncoder();
    const parts: Uint8Array[] = [enc.encode("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
    let offset = parts[0].length;
    const offsets: number[] = [];
    objects.forEach((o, i) => {
      offsets.push(offset);
      const head = enc.encode(`${i + 1} 0 obj\n`);
      const body = typeof o === "string" ? enc.encode(o) : o;
      const tail = enc.encode(`\nendobj\n`);
      parts.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    });
    const xref = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `,
      ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
      `trailer`, `<< /Size ${objects.length + 1} /Root 1 0 R >>`, `startxref`, String(offset), `%%EOF`, ``].join("\n");
    parts.push(enc.encode(xref));
    return concat(...parts);
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
