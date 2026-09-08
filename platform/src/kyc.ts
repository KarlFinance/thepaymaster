/**
 * Knowing who we are dealing with.
 *
 * A party tells us who they are and uploads what proves it; somebody here runs
 * the check at Themis and records what they concluded. Two shapes:
 *
 *   an individual — name, date of birth, nationality, where they live, a
 *   passport and something showing their address;
 *
 *   a company — its incorporation details and its people, each of whom is an
 *   individual party in their own right and must pass the same checks. A
 *   director of one client is often a shareholder of another, and having
 *   verified them once should count.
 *
 * A clearance is bounded rather than permanent: it carries a value ceiling and
 * a date. Somebody cleared for fifty thousand is not thereby cleared for five
 * million, and a conclusion from eight months ago proves nothing today.
 */

import { type Env, type Actor, id, log, insert, update } from "./db.ts";
import { esc, REVEAL_CSS } from "./views.ts";
import { store, documentsFor, DocumentProblem, ACCEPTED } from "./documents.ts";
import { beginCheck, standingCheck, history } from "./screening.ts";
import { format } from "./money.ts";

/** What each kind of party must give us before we will look at it. */
export const REQUIRED: Record<string, { kind: string; label: string; hint: string }[]> = {
  individual: [
    { kind: "passport", label: "Passport",
      hint: "The photo page. A clear photograph taken on a phone is fine." },
    { kind: "proof_of_address", label: "Proof of address",
      hint: "A utility bill, bank statement or council tax bill from the last three months." },
  ],
  company: [
    { kind: "certificate_of_incorporation", label: "Certificate of incorporation",
      hint: "As issued by the registry where the company was formed." },
    { kind: "proof_of_address", label: "Proof of registered address",
      hint: "A utility bill or official correspondence at the registered office." },
    { kind: "ownership_structure", label: "Ownership structure",
      hint: "A register of members, cap table or structure chart showing who owns what." },
  ],
};

const RELATIONS: Record<string, string> = {
  director: "Director",
  ubo: "Beneficial owner",
  shareholder: "Shareholder",
  signatory: "Authorised signatory",
};

const MAX_PEOPLE = 8;

// ---------------------------------------------------------------------------
// What the client sees
// ---------------------------------------------------------------------------

const KYC_CSS = `
.step{background:#fff;border:1px solid var(--rule);border-radius:12px;padding:22px 24px;margin-bottom:16px}
.step h2{margin:0 0 3px;font-size:17px;color:var(--ink);font-weight:700}
.step .why{margin:0 0 16px;font-size:14.5px}
.doc{border:1px solid var(--rule);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.doc h3{margin:0 0 2px;font-size:15px;color:var(--ink);font-weight:700;text-transform:none;letter-spacing:0}
.doc p{margin:0 0 10px;font-size:13.5px}
.doc.done{background:#EAF7F0;border-color:#B7E0C9}
.doc .have{font-size:13.5px;color:#12603D;font-weight:600}
input[type=file]{padding:9px;font-size:14px}
.person{border:1px solid var(--rule);border-radius:10px;padding:4px 16px 16px;margin-bottom:10px}
.trio{display:grid;grid-template-columns:1.4fr 1.6fr 1fr;gap:12px}
@media(max-width:620px){.trio{grid-template-columns:1fr}}
`;

export function kycStyles(): string {
  return KYC_CSS + REVEAL_CSS;
}

/**
 * The verification page a party lands on from their account.
 *
 * It asks first whether they are verifying themselves or a company, because
 * everything after that differs and guessing it from a transaction role would
 * be wrong as often as right.
 */
export function verifyForm(party: any, docs: any[], people: any[],
                           error = "", saved = false): string {
  const kind = party.kind === "company" ? "company" : "individual";
  const have = new Set(docs.map((d) => d.kind));
  const v = (x: unknown) => esc(x ?? "");

  const chooser = `
    <div class="step">
      <h2>Who are we verifying?</h2>
      <p class="why">If the money is moving in a company's name, choose the company —
         we will ask about its directors and owners separately.</p>
      <label><input type="radio" name="kind" value="individual" style="width:auto"
        ${kind === "individual" ? "checked" : ""}> Me, as an individual</label>
      <label><input type="radio" name="kind" value="company" style="width:auto"
        ${kind === "company" ? "checked" : ""}> A company</label>
    </div>`;

  const individual = `
    <div class="step">
      <h2>About you</h2>
      <p class="why">Exactly as they appear on your passport.</p>
      <label for="ln">Full legal name</label>
      <input id="ln" name="legal_name" value="${v(party.legal_name ?? party.display_name)}" required>
      <label for="dob">Date of birth</label>
      <input id="dob" name="date_of_birth" type="date" value="${v(party.date_of_birth)}" required>
      <label for="nat">Nationality</label>
      <input id="nat" name="nationality" value="${v(party.nationality)}"
        placeholder="British" required>
      <label for="res">Country you live in</label>
      <input id="res" name="residence_country" value="${v(party.residence_country)}"
        placeholder="United Kingdom" required>
      <label for="addr">Home address</label>
      <textarea id="addr" name="address" rows="3" required>${v(party.address)}</textarea>
    </div>`;

  const company = `
    <div class="step">
      <h2>About the company</h2>
      <label for="ln">Registered name</label>
      <input id="ln" name="legal_name" value="${v(party.legal_name ?? party.display_name)}" required>
      <label for="cno">Registration number</label>
      <input id="cno" name="company_no" value="${v(party.company_no)}" required>
      <label for="inc">Country of incorporation</label>
      <input id="inc" name="incorporated_in" value="${v(party.incorporated_in)}"
        placeholder="England and Wales" required>
      <label for="incon">Date of incorporation</label>
      <input id="incon" name="incorporated_on" type="date" value="${v(party.incorporated_on)}">
      <label for="addr">Registered address</label>
      <textarea id="addr" name="address" rows="3" required>${v(party.address)}</textarea>
    </div>

    <div class="step">
      <h2>Directors and beneficial owners</h2>
      <p class="why">Everyone who directs the company or owns more than 25% of it.
         We will write to each of them to verify themselves — you do not need
         their documents, only their name and email.</p>
      ${Array.from({ length: MAX_PEOPLE }, (_, n) => {
        const p = people[n];
        return `<div class="person"${n > 1 && !p ? " hidden" : ""} data-person>
          <div class="trio">
            <div><label for="pn${n}">Name</label>
              <input id="pn${n}" name="pname${n}" value="${v(p?.display_name)}"></div>
            <div><label for="pe${n}">Email</label>
              <input id="pe${n}" name="pemail${n}" type="email" value="${v(p?.email)}"></div>
            <div><label for="pr${n}">Role</label>
              <select id="pr${n}" name="prelation${n}">
                ${Object.entries(RELATIONS).map(([k, label]) =>
                  `<option value="${k}"${p?.relation === k ? " selected" : ""}>${label}</option>`).join("")}
              </select></div>
          </div>
          <label for="po${n}">Ownership, if any (%)</label>
          <input id="po${n}" name="pown${n}" inputmode="decimal" style="max-width:140px"
            value="${p?.ownership_bps ? (p.ownership_bps / 100).toString() : ""}">
        </div>`;
      }).join("")}
      <button type="button" class="plain" id="morePeople">Add another person</button>
    </div>`;

  const documents = `
    <div class="step">
      <h2>Documents</h2>
      <p class="why">Uploaded straight to us. Nothing is emailed, and nothing is
         shared with anyone else on the transaction.</p>
      ${(REQUIRED[kind] ?? []).map((d) => {
        const got = docs.filter((x) => x.kind === d.kind);
        return `<div class="doc${got.length ? " done" : ""}">
          <h3>${esc(d.label)}</h3>
          <p>${esc(d.hint)}</p>
          ${got.length ? `<p class="have">Received: ${got.map((g) =>
             esc(g.filename ?? g.kind)).join(", ")}</p>` : ""}
          <input type="file" name="doc_${esc(d.kind)}" accept="${ACCEPTED}">
        </div>`;
      }).join("")}
      <p class="muted">PDF or a photograph, up to 15MB each.</p>
    </div>`;

  return `
  <h1>Verify ${kind === "company" ? "the company" : "yourself"}</h1>
  <p class="sub">We are required to know who is behind every transaction. This is
     the only time we will ask — once done, it carries over to anything else you
     do with us.</p>
  ${error ? `<div class="err">${error}</div>` : ""}
  ${saved ? `<div class="ok">Saved. You can come back and finish this later.</div>` : ""}

  <form method="post" enctype="multipart/form-data">
    ${chooser}
    ${kind === "company" ? company : individual}
    ${documents}
    <div class="step">
      <button type="submit" name="action" value="save">Save and come back later</button>
      <button type="submit" name="action" value="submit" style="margin-left:8px">
        Send it to ThePaymaster</button>
      <p class="muted" style="margin-bottom:0">Sending it tells us you have finished.
         We will come back to you if anything is missing.</p>
    </div>
  </form>
  <script>
    var more = document.getElementById('morePeople');
    if (more) more.addEventListener('click', function () {
      var next = document.querySelector('[data-person][hidden]');
      if (next) next.hidden = false;
      if (!document.querySelector('[data-person][hidden]')) more.hidden = true;
    });
    // Changing who is being verified changes every question below it, so the
    // page reloads rather than trying to morph in place.
    document.querySelectorAll('input[name=kind]').forEach(function (r) {
      r.addEventListener('change', function () { r.form.submit(); });
    });
  </script>`;
}

// ---------------------------------------------------------------------------
// Taking it in
// ---------------------------------------------------------------------------

export interface SubmitResult {
  error?: string;
  saved?: boolean;
  submitted?: boolean;
}

export async function receiveVerification(env: Env, actor: Actor, party: any,
                                          request: Request): Promise<SubmitResult> {
  const f = await request.formData();
  const s = (k: string) => String(f.get(k) ?? "").trim();
  const kind = s("kind") === "company" ? "company" : "individual";
  const submitting = s("action") === "submit";

  const before = {
    kind: party.kind, legal_name: party.legal_name, date_of_birth: party.date_of_birth,
    nationality: party.nationality, residence_country: party.residence_country,
    address: party.address, company_no: party.company_no,
    incorporated_in: party.incorporated_in, incorporated_on: party.incorporated_on,
  };

  const fields: Record<string, unknown> = {
    kind,
    legal_name: s("legal_name") || null,
    address: s("address") || null,
  };
  if (kind === "individual") {
    fields.date_of_birth = s("date_of_birth") || null;
    fields.nationality = s("nationality") || null;
    fields.residence_country = s("residence_country") || null;
  } else {
    fields.company_no = s("company_no") || null;
    fields.incorporated_in = s("incorporated_in") || null;
    fields.incorporated_on = s("incorporated_on") || null;
  }

  await update(env.DB, actor, "party.details_given", "parties", party.id, fields, before);

  // Documents, one field per required kind.
  for (const d of REQUIRED[kind] ?? []) {
    const file = f.get(`doc_${d.kind}`);
    if (!(file instanceof File) || file.size === 0) continue;
    try {
      await store(env, actor, file, { kind: d.kind, label: d.label, partyId: party.id });
    } catch (err) {
      if (err instanceof DocumentProblem) {
        return { error: `${d.label}: ${err.message}` };
      }
      throw err;
    }
  }

  if (kind === "company") {
    const problem = await recordPeople(env, actor, party.id, f);
    if (problem) return { error: problem };
  }

  if (!submitting) return { saved: true };

  // Only now check completeness: somebody saving as they go should never be
  // told off for a gap they were about to fill.
  const missing = await whatIsMissing(env, { ...party, ...fields });
  if (missing.length) {
    return { error: `Still needed before we can check this: ${missing.join(", ")}.` };
  }

  await update(env.DB, actor, "party.kyc_submitted", "parties", party.id,
    { kyc_submitted_at: new Date().toISOString().replace("T", " ").slice(0, 19) },
    { kyc_submitted_at: party.kyc_submitted_at });

  await beginCheck(env, actor, {
    partyId: party.id, kind,
    name: String(fields.legal_name ?? party.display_name),
    email: party.email,
    dateOfBirth: fields.date_of_birth as string | undefined,
    nationality: fields.nationality as string | undefined,
    residence: fields.residence_country as string | undefined,
    companyNumber: fields.company_no as string | undefined,
    incorporatedIn: fields.incorporated_in as string | undefined,
  });

  return { submitted: true };
}

/**
 * Create or find each named person and hang them off the company.
 *
 * They become parties in their own right, so each can verify themselves once
 * and count everywhere they appear.
 */
async function recordPeople(env: Env, actor: Actor, companyId: string,
                            f: FormData): Promise<string | null> {
  const s = (k: string) => String(f.get(k) ?? "").trim();
  for (let n = 0; n < MAX_PEOPLE; n++) {
    const name = s(`pname${n}`), email = s(`pemail${n}`).toLowerCase();
    if (!name && !email) continue;
    if (!name || !email) return `Person ${n + 1} needs both a name and an email.`;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return `“${email}” does not look like an email address.`;
    }
    const relation = RELATIONS[s(`prelation${n}`)] ? s(`prelation${n}`) : "director";
    const ownRaw = s(`pown${n}`);
    let ownership: number | null = null;
    if (ownRaw) {
      const pct = Number(ownRaw);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return `Ownership for ${name} should be a percentage between 0 and 100.`;
      }
      ownership = Math.round(pct * 100);
    }

    let person = await env.DB.prepare("SELECT id FROM parties WHERE lower(email) = ?")
      .bind(email).first<any>();
    if (!person) {
      const pid = id("pty");
      await insert(env.DB, actor, "party.created", "parties", pid, {
        kind: "individual", display_name: name, email,
      }, { note: `${relation} of ${companyId}` });
      person = { id: pid };
    }

    const exists = await env.DB.prepare(
      "SELECT id FROM relationships WHERE company_id = ? AND person_id = ? AND relation = ?")
      .bind(companyId, person.id, relation).first<any>();
    if (!exists) {
      await insert(env.DB, actor, "relationship.added", "relationships", id("rel"), {
        company_id: companyId, person_id: person.id, relation,
        ownership_bps: ownership,
      }, { note: `${name} — ${relation}` });
    }
  }
  return null;
}

/** What a party still owes us, in words a client can act on. */
export async function whatIsMissing(env: Env, party: any): Promise<string[]> {
  const kind = party.kind === "company" ? "company" : "individual";
  const missing: string[] = [];

  if (!party.legal_name) missing.push(kind === "company" ? "registered name" : "full legal name");
  if (!party.address) missing.push("address");
  if (kind === "individual") {
    if (!party.date_of_birth) missing.push("date of birth");
    if (!party.nationality) missing.push("nationality");
    if (!party.residence_country) missing.push("country of residence");
  } else {
    if (!party.company_no) missing.push("registration number");
    if (!party.incorporated_in) missing.push("country of incorporation");
  }

  const docs = await documentsFor(env, party.id);
  const have = new Set(docs.map((d) => d.kind));
  for (const d of REQUIRED[kind] ?? []) {
    if (!have.has(d.kind)) missing.push(d.label.toLowerCase());
  }

  if (kind === "company") {
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM relationships WHERE company_id = ?")
      .bind(party.id).first<{ n: number }>();
    if (!row?.n) missing.push("at least one director or beneficial owner");
  }
  return missing;
}

export async function peopleOf(env: Env, companyId: string) {
  const { results } = await env.DB.prepare(
    `SELECT r.relation, r.ownership_bps, p.id, p.display_name, p.email,
            p.kyc_submitted_at
       FROM relationships r JOIN parties p ON p.id = r.person_id
      WHERE r.company_id = ? ORDER BY r.relation, p.display_name`)
    .bind(companyId).all<any>();
  return results ?? [];
}

// ---------------------------------------------------------------------------
// What we see
// ---------------------------------------------------------------------------

/** Everyone who has sent something in and is waiting on us. */
export async function reviewQueue(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.kind, p.display_name, p.legal_name, p.email, p.kyc_submitted_at,
            (SELECT status FROM verifications v WHERE v.party_id = p.id
              ORDER BY v.created_at DESC LIMIT 1) AS status,
            (SELECT count(*) FROM artefacts a WHERE a.party_id = p.id) AS docs
       FROM parties p
      WHERE p.kyc_submitted_at IS NOT NULL
      ORDER BY CASE WHEN (SELECT status FROM verifications v WHERE v.party_id = p.id
                           ORDER BY v.created_at DESC LIMIT 1) = 'pending'
                    THEN 0 ELSE 1 END, p.kyc_submitted_at`).all<any>();
  return results ?? [];
}

/**
 * Record a decision.
 *
 * A ceiling and an expiry are required rather than optional. An unbounded
 * clearance is the thing this design is trying not to have: it is what turns
 * "we checked them once" into "they are checked", which is how a party cleared
 * for a small deal ends up waved through a large one two years later.
 */
export async function decide(env: Env, actor: Actor, partyId: string, opts: {
  passed: boolean;
  ceilingMinor: number | null;
  months: number;
  note: string;
}): Promise<void> {
  const latest = await env.DB.prepare(
    `SELECT id, status FROM verifications WHERE party_id = ?
      ORDER BY created_at DESC LIMIT 1`).bind(partyId).first<any>();
  if (!latest) throw new Error("nothing to decide on");

  const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
  const expires = new Date(Date.now() + opts.months * 30 * 86_400_000)
    .toISOString().replace("T", " ").slice(0, 19);

  await update(env.DB, actor,
    opts.passed ? "verification.passed" : "verification.failed",
    "verifications", latest.id, {
      status: opts.passed ? "passed" : "failed",
      verified_at: opts.passed ? nowStr : null,
      expires_at: opts.passed ? expires : null,
      band_ceiling_minor: opts.passed ? opts.ceilingMinor : null,
      decided_by: actor.id,
      notes: opts.note || null,
    }, { status: latest.status },
    { note: opts.passed
        ? `cleared to ${opts.ceilingMinor === null ? "no ceiling"
            : "GBP " + format(opts.ceilingMinor, 2)} until ${expires.slice(0, 10)}`
        : "refused" });
}

export { standingCheck, history, documentsFor };
