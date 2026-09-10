/**
 * The public verifier.
 *
 * Anyone — a bank's compliance officer, a recipient's accountant, a stranger —
 * pastes a party's record.json, or a certification reference, and gets an
 * answer that does not depend on trusting us: each entry's leaf is recomputed
 * from its contents, folded up its proof path, and compared with the root;
 * the root is then looked up among the seals we have made, with the date and
 * the on-chain anchor if there is one.
 *
 * Nothing here needs a login and nothing here reveals anything: the verifier
 * only ever repeats back what the visitor already holds, plus the fact that
 * we sealed that root and when. A root is a hash; a reference is a label.
 */

import { type Env } from "./db.ts";
import { esc } from "./views.ts";
import { leafHash, verifyPath, type Step } from "./dossier.ts";
import { railFor } from "./rail.ts";
import { attestationFor, verify as verifySignature, type Attestation } from "./attestation.ts";

export const VERIFY_URL = "https://client.thepaymaster.co.uk/verify-record";

interface Outcome {
  ok: boolean;
  headline: string;
  lines: string[];
  entries?: { title: string; ok: boolean; why?: string }[];
}

async function sealFor(env: Env, root: string) {
  return env.DB.prepare(
    `SELECT s.id, s.root, s.sealed_at, s.leaf_count, s.algorithm, s.anchor_chain_id, s.anchor_tx_hash, s.anchored_at,
            s.attester, s.attestation, t.ref
       FROM dossier_seals s JOIN transactions t ON t.id = s.transaction_id
      WHERE lower(s.root) = lower(?) ORDER BY s.sealed_at DESC LIMIT 1`).bind(root).first<any>();
}

/** A pasted record.json. */
export async function checkRecord(env: Env, text: string): Promise<Outcome> {
  let doc: any;
  try { doc = JSON.parse(text); } catch {
    return { ok: false, headline: "That is not a record.json file.", lines: ["The text could not be read as JSON. Paste the whole file, from the first { to the last }."] };
  }
  const root = String(doc?.root ?? "");
  const facts: any[] = Array.isArray(doc?.facts) ? doc.facts : [];
  if (!/^[0-9a-f]{64}$/i.test(root) || !facts.length) {
    return { ok: false, headline: "That is not a record.json file.", lines: ["It needs a 64-character root and a list of facts, each with kind, id, data, leaf and path."] };
  }

  const entries: Outcome["entries"] = [];
  let allGood = true;
  for (const f of facts) {
    const title = String(f.title ?? f.kind ?? "entry");
    if (typeof f.kind !== "string" || typeof f.id !== "string" || typeof f.data !== "object") {
      entries.push({ title, ok: false, why: "missing kind, id or data" }); allGood = false; continue;
    }
    const leaf = await leafHash({ kind: f.kind, id: f.id, title, data: f.data });
    if (leaf !== String(f.leaf ?? "").toLowerCase()) {
      entries.push({ title, ok: false, why: "the contents do not match the leaf — this entry has been altered" }); allGood = false; continue;
    }
    const path: Step[] = Array.isArray(f.path) ? f.path : [];
    const inRoot = await verifyPath(leaf, path, root.toLowerCase());
    if (!inRoot) { entries.push({ title, ok: false, why: "the proof path does not lead to the root" }); allGood = false; continue; }
    entries.push({ title, ok: true });
  }

  const seal = await sealFor(env, root);
  const lines: string[] = [];
  if (!allGood) {
    return { ok: false, headline: "This record does not check out.", entries,
      lines: ["At least one entry has been altered or does not belong to the root it claims. Treat the file as unreliable and ask the party for it again."] };
  }
  lines.push(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} recomputed from their contents; every one leads to the root ${root.slice(0, 16)}….`);
  if (!seal) {
    return { ok: false, headline: "Internally consistent, but not a root ThePaymaster has sealed.", entries,
      lines: [...lines, "The entries agree with each other, but this root is not one we have sealed. Either the record was produced before its transaction was sealed (it will say provisional), or it did not come from us. Ask the party for the final version."] };
  }
  lines.push(`ThePaymaster sealed this root on ${String(seal.sealed_at).slice(0, 16)} UTC over ${seal.leaf_count} facts, as the record of transaction ${seal.ref}.`);
  // The signature, if the file carries one: it must verify, and it must be by
  // the key that signed the seal we hold — a valid signature by somebody else
  // would be exactly the forgery this exists to catch.
  const ours = await attestationFor(env, seal, seal.ref);
  const theirs: Attestation | null = doc.attestation ?? null;
  if (theirs) {
    const valid = verifySignature(theirs);
    const sameKey = ours ? theirs.attester.toLowerCase() === ours.attester.toLowerCase() : false;
    const sameSeal = theirs.message?.root?.toLowerCase() === ("0x" + root).toLowerCase() || theirs.message?.root?.toLowerCase() === root.toLowerCase();
    if (valid && sameKey && sameSeal) lines.push(`The file carries ThePaymaster's EIP-712 signature over the seal, by key ${theirs.attester}, and it verifies.`);
    else {
      return { ok: false, headline: "The record verifies but its signature does not.", entries,
        lines: [...lines, !valid ? "The signature in the file is not a valid signature over its own seal message."
          : !sameKey ? `The signature is by ${theirs.attester}, which is not ThePaymaster's attestation key${ours ? ` (${ours.attester})` : ""}.`
          : "The signature is over a different root from the one in the file."] };
    }
  } else if (ours) {
    lines.push(`ThePaymaster's signature over this seal is by key ${ours.attester}; the file predates signing or omitted it, and the root check above stands on its own.`);
  }
  if (seal.anchor_tx_hash) {
    const explorer = railFor({ chain_id: seal.anchor_chain_id }).explorer.tx(seal.anchor_tx_hash);
    lines.push(`The root was published on Ethereum in transaction ${seal.anchor_tx_hash} (block time ${String(seal.anchored_at ?? "").slice(0, 16)} UTC) — ${explorer}`);
  } else {
    lines.push("The root has not yet been published on a public chain; the seal date above is ours.");
  }
  return { ok: true, headline: "Verified. This record is genuine and unaltered.", lines, entries };
}

/** A certification reference such as STM-TPM-2026-0002-APMKEV, or a bare root. */
export async function checkReference(env: Env, ref: string): Promise<Outcome> {
  const r = ref.trim();
  if (/^[0-9a-f]{64}$/i.test(r)) {
    const seal = await sealFor(env, r);
    if (!seal) return { ok: false, headline: "Not a root ThePaymaster has sealed.", lines: ["No seal carries that root. Check the characters, or ask for the final record."] };
    const lines = [`Sealed ${String(seal.sealed_at).slice(0, 16)} UTC over ${seal.leaf_count} facts, as the record of transaction ${seal.ref}.`];
    if (seal.anchor_tx_hash) lines.push(`Published on Ethereum: ${railFor({ chain_id: seal.anchor_chain_id }).explorer.tx(seal.anchor_tx_hash)}`);
    const att = await attestationFor(env, seal, seal.ref);
    if (att) lines.push(`Signed by ThePaymaster's attestation key ${att.attester}: ${att.signature}`);
    return { ok: true, headline: "That root is a record ThePaymaster sealed.", lines };
  }
  const m = r.match(/^STM-(TPM-\d{4}-\d{4})-([A-Z0-9]{6})$/i);
  if (!m) return { ok: false, headline: "That does not look like a certification reference.", lines: ["A reference reads STM-TPM-YYYY-NNNN-XXXXXX and is printed at the top of the certification. A record root is 64 hexadecimal characters."] };
  const row = await env.DB.prepare(
    `SELECT t.id, t.ref, t.status, y.id AS party_id,
            (SELECT sealed_at FROM dossier_seals s WHERE s.transaction_id = t.id ORDER BY sealed_at DESC LIMIT 1) AS sealed_at
       FROM transactions t JOIN participations p ON p.transaction_id = t.id JOIN parties y ON y.id = p.party_id
      WHERE t.ref = ? AND upper(substr(y.id, -6)) = upper(?) LIMIT 1`).bind(m[1].toUpperCase(), m[2]).first<any>();
  if (!row) return { ok: false, headline: "No certification with that reference.", lines: ["ThePaymaster has not issued a certification under that reference. Check it against the document; if it is exactly as printed, the document did not come from us."] };
  const final = row.sealed_at && ["settled", "closed"].includes(String(row.status));
  return {
    ok: true,
    headline: final ? "That certification was issued by ThePaymaster and the transaction is complete."
                    : "That certification was issued by ThePaymaster; the transaction is not yet complete.",
    lines: [
      `Reference ${r.toUpperCase()} belongs to a named party on transaction ${row.ref}.`,
      row.sealed_at ? `The record was sealed ${String(row.sealed_at).slice(0, 16)} UTC.` : "The record has not yet been sealed, so any certification under this reference is provisional.",
      "To check the document itself rather than its reference, paste the party's record.json above: every entry is recomputed and matched to the sealed root.",
    ],
  };
}

export const VERIFY_CSS = `
.verify .card{max-width:760px}
.verify textarea{font-family:ui-monospace,Menlo,monospace;font-size:12px;min-height:160px}
.verify .result{border-left:4px solid #1B7F4B;background:#F1F8F4;padding:14px 16px;border-radius:0 8px 8px 0;margin-top:16px}
.verify .result.bad{border-left-color:#8A1F11;background:#FDF0EE}
.verify .result h3{margin:0 0 6px;font-size:16px}
.verify .result li{margin:3px 0;font-size:14px}
.verify .entries{margin-top:10px;font-size:13px;columns:1}
.verify .entries div{padding:2px 0;border-top:1px solid rgba(0,0,0,.06)}
.verify .ok{color:#1B7F4B;font-weight:700}.verify .no{color:#8A1F11;font-weight:700}
`;

export function verifyBody(outcome?: Outcome, was: { record?: string; ref?: string } = {}): string {
  const result = outcome ? `<div class="result${outcome.ok ? "" : " bad"}">
      <h3>${outcome.ok ? "&#10003; " : "&#10007; "}${esc(outcome.headline)}</h3>
      <ul>${outcome.lines.map((l) => `<li>${esc(l).replace(/(https?:\/\/\S+)/g, '<a href="$1" rel="noopener" target="_blank">$1</a>')}</li>`).join("")}</ul>
      ${outcome.entries?.length ? `<details class="entries"><summary>${outcome.entries.filter((e) => e.ok).length} of ${outcome.entries.length} entries verified — show them</summary>
        ${outcome.entries.map((e) => `<div><span class="${e.ok ? "ok" : "no"}">${e.ok ? "&#10003;" : "&#10007;"}</span> ${esc(e.title)}${e.why ? ` <span class="muted">— ${esc(e.why)}</span>` : ""}</div>`).join("")}</details>` : ""}
    </div>` : "";
  return `<div class="verify">
    <div class="card">
      <h1>Verify a ThePaymaster record</h1>
      <p class="sub">Check a Counterparty Certification or a party's record without taking our word for it.
        Nothing you paste here is stored, and nothing about the transaction is revealed beyond what you already hold.</p>
      <form method="post" action="/verify-record">
        <label for="record">Paste the contents of <code>record.json</code> from the party's dossier</label>
        <textarea id="record" name="record" placeholder='{"transaction": …, "root": "…", "facts": [ … ]}'>${esc(was.record ?? "")}</textarea>
        <p class="muted" style="margin:4px 0 12px">Every entry is recomputed from its own contents and folded up its proof path to the root; the root is then matched against the seals ThePaymaster has made and any on-chain anchor.</p>
        <label for="ref">Or enter a certification reference, or a record root</label>
        <input id="ref" name="ref" placeholder="STM-TPM-2026-0002-APMKEV  or  a 64-character root" value="${esc(was.ref ?? "")}" spellcheck="false">
        <div class="row" style="margin-top:12px"><button class="go">Check it</button></div>
      </form>
      ${result}
      <details style="margin-top:18px"><summary>How the check works</summary>
        <ol>
          <li>Each entry is serialised as JSON with exactly its kind, id and data, keys sorted, no whitespace, empty values omitted, and hashed with SHA-256. That must equal the entry's leaf.</li>
          <li>The leaf is folded up its proof path — each step's hash placed on the side it says, the pair hashed with SHA-256 — until one hash remains. That must equal the record root.</li>
          <li>The root is looked up among the seals ThePaymaster has made. A match gives the date it was sealed and, where it has been published, the Ethereum transaction carrying it.</li>
        </ol>
        <p class="muted">Anyone can re-implement steps 1 and 2 in a few lines; step 3 can be checked against the chain without us.</p>
      </details>
    </div>
  </div>`;
}
