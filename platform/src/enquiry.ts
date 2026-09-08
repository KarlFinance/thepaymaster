/**
 * The front door.
 *
 * A public form, and the admin inbox it feeds. This is the first artefact of
 * the dossier rather than a lead in a CRM: what the client said the deal was,
 * before anyone had done any work on it. That is the version most likely to
 * matter if the transaction is ever questioned, so it is captured verbatim,
 * timestamped, and never edited — later corrections go on the transaction, not
 * over the top of this.
 */

import { type Env, type Actor, id, log, record } from "./db.ts";
import { page, nav, esc } from "./views.ts";
import { send, staffEmails, enquiryLanded, enquiryAcknowledged } from "./email.ts";
import { format, parse } from "./money.ts";

const CURRENCIES: Record<string, number> = {
  GBP: 2, EUR: 2, USD: 2, USDT: 6, USDC: 6, BTC: 8, ETH: 18,
};

/** Where the notification email points. */
const ADMIN_URL = "https://admin.thepaymaster.co.uk";

const LIKELIHOOD: Record<string, string> = {
  exploring: "Exploring options",
  likely: "Likely to proceed",
  committed: "Committed, waiting on us",
};

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

const FORM_CSS = `
:root{--ink:#0C1524;--accent:#FF8159;--panel:#F5F7FA;--text:#4A5567;--rule:#DBDFEA}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:17px/1.6 "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:#fff}
.band{background:var(--panel);padding:56px 0;text-align:center}
.band h1{margin:0;font-size:clamp(28px,4vw,42px);color:var(--ink);font-weight:800;letter-spacing:-.02em}
.band p{margin:12px auto 0;max-width:52ch;padding:0 20px}
.shell{max-width:660px;margin:0 auto;padding:40px 20px 72px}
fieldset{border:0;padding:0;margin:0 0 32px}
legend{font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink);margin-bottom:6px}
.hint{font-size:14.5px;margin:0 0 18px}
label{display:block;margin:16px 0 5px;font-weight:600;color:var(--ink);font-size:15px}
input,select,textarea{width:100%;padding:11px 13px;border:1px solid var(--rule);border-radius:9px;font:inherit;background:#fff}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.check{display:flex;gap:10px;align-items:flex-start;margin-top:14px;font-weight:400;color:var(--text)}
.check input{width:auto;margin-top:4px}
button{background:var(--accent);color:var(--ink);border:0;border-radius:9px;padding:14px 28px;font:inherit;font-weight:700;font-size:17px;cursor:pointer}
.err{background:#FDECEA;border:1px solid #F5C2BC;color:#8A1F11;padding:12px 15px;border-radius:9px;margin-bottom:20px}
.small{font-size:13.5px}
@media(max-width:560px){.pair{grid-template-columns:1fr}}
`;

function shell(title: string, body: string): Response {
  return new Response(`<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ThePaymaster</title>
<link rel="stylesheet" href="https://thepaymaster.co.uk/wp-content/uploads/elementor/google-fonts/css/plusjakartasans.css">
<style>${FORM_CSS}</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function enquiryForm(error = "", was: Record<string, string> = {}): Response {
  const v = (k: string) => esc(was[k] ?? "");
  const cur = Object.keys(CURRENCIES)
    .map((c) => `<option${was.currency === c ? " selected" : ""}>${c}</option>`).join("");

  return shell("Start a transaction", `
<div class="band">
  <h1>Start a transaction</h1>
  <p>Tell us what you are trying to do. We will come back to you to arrange a
     short call before anything else happens.</p>
</div>
<div class="shell">
  ${error ? `<div class="err">${error}</div>` : ""}
  <form method="post">
    <fieldset>
      <legend>You</legend>
      <label for="name">Your name</label>
      <input id="name" name="name" required autocomplete="name" value="${v("name")}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email" value="${v("email")}">
      <label for="phone">Phone</label>
      <input id="phone" name="phone" type="tel" autocomplete="tel" value="${v("phone")}">
      <label class="check"><input type="checkbox" name="whatsapp_ok" value="1"${was.whatsapp_ok ? " checked" : ""}>
        <span class="small">This number is on WhatsApp and you may message me there.</span></label>
    </fieldset>

    <fieldset>
      <legend>The transaction</legend>
      <p class="hint">Rough figures are fine. We would rather hear early with
        approximate numbers than late with exact ones.</p>
      <div class="pair">
        <div><label for="amount">How much, roughly</label>
          <input id="amount" name="amount" inputmode="decimal" placeholder="1,000,000" value="${v("amount")}"></div>
        <div><label for="currency">Currency</label>
          <select id="currency" name="currency">${cur}</select></div>
      </div>
      <label for="expected_on">When is it likely to happen</label>
      <input id="expected_on" name="expected_on" type="date" value="${v("expected_on")}">
      <label for="likelihood">How likely is it to go ahead</label>
      <select id="likelihood" name="likelihood">
        ${Object.entries(LIKELIHOOD).map(([k, label]) =>
          `<option value="${k}"${was.likelihood === k ? " selected" : ""}>${label}</option>`).join("")}
      </select>
      <label for="detail">What is the transaction, and who needs paying</label>
      <textarea id="detail" name="detail" rows="5"
        placeholder="A completed plant sale. Proceeds split between three parties, one of them overseas.">${v("detail")}</textarea>
    </fieldset>

    <fieldset>
      <legend>Talking to us</legend>
      <label for="contact_pref">How would you rather we made first contact</label>
      <select id="contact_pref" name="contact_pref">
        <option value="zoom"${was.contact_pref === "zoom" ? " selected" : ""}>Book a Zoom call</option>
        <option value="whatsapp"${was.contact_pref === "whatsapp" ? " selected" : ""}>Message me on WhatsApp</option>
        <option value="either"${was.contact_pref === "either" ? " selected" : ""}>Either is fine</option>
      </select>
    </fieldset>

    <div style="position:absolute;left:-9999px" aria-hidden="true">
      <label for="website">Leave this empty</label>
      <input id="website" name="website" tabindex="-1" autocomplete="off">
    </div>

    <button type="submit">Send this to ThePaymaster</button>
    <p class="small" style="margin-top:18px">We will hold these details to deal with your
      enquiry. Nothing is shared with anyone else.</p>
  </form>
</div>`);
}

export async function submitEnquiry(request: Request, env: Env,
                                    later: (p: Promise<unknown>) => void): Promise<Response> {
  const f = await request.formData();
  const s = (k: string) => String(f.get(k) ?? "").trim();
  const was = Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));

  // A bot fills every field it can see. This one is hidden, so anything in it
  // did not come from a person.
  if (s("website")) return thanks();

  if (!s("name") || !s("email")) {
    return enquiryForm("We need at least a name and an email address.", was);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s("email"))) {
    return enquiryForm("That email address does not look right.", was);
  }

  const currency = s("currency") || "GBP";
  const decimals = CURRENCIES[currency] ?? 2;
  let amountMinor: number | null = null;
  if (s("amount")) {
    try { amountMinor = parse(s("amount"), decimals); }
    catch { return enquiryForm(`We could not read “${esc(s("amount"))}” as an amount.`, was); }
  }

  const eid = id("enq");
  const ip = request.headers.get("CF-Connecting-IP") ?? undefined;
  await record(env.DB, { kind: "system", id: null, ip }, "enquiry.received", "enquiries", eid, {
    name: s("name"), email: s("email"), phone: s("phone") || null,
    whatsapp_ok: f.get("whatsapp_ok") ? 1 : 0,
    contact_pref: ["zoom", "whatsapp", "either"].includes(s("contact_pref")) ? s("contact_pref") : null,
    amount_minor: amountMinor, currency: amountMinor === null ? null : currency,
    expected_on: s("expected_on") || null,
    likelihood: Object.keys(LIKELIHOOD).includes(s("likelihood")) ? s("likelihood") : null,
    detail: s("detail") || null,
    source: request.headers.get("Referer") ?? null,
    status: "new",
  });

  // After the row is safely down, and never in the way of the response: the
  // enquiry is saved whether or not anyone's mail server is having a good day.
  const actor = { kind: "system" as const, id: null, ip };
  const amount = amountMinor === null ? null
    : `${currency} ${format(amountMinor, decimals)}`;
  later((async () => {
    const staff = await staffEmails(env);
    if (staff.length) {
      const m = enquiryLanded({
        id: eid, name: s("name"), email: s("email"), phone: s("phone"),
        whatsapp_ok: f.get("whatsapp_ok") ? 1 : 0,
        contact_pref: s("contact_pref"), amount,
        expected_on: s("expected_on"), likelihood: s("likelihood"),
        detail: s("detail"),
      }, ADMIN_URL);
      await send(env as any, actor, { ...m, to: staff, replyTo: s("email"),
        about: { kind: "enquiries", id: eid } });
    }
    const ack = enquiryAcknowledged(s("name"));
    await send(env as any, actor, { ...ack, to: s("email"),
      about: { kind: "enquiries", id: eid } });
  })());

  return thanks();
}

function thanks(): Response {
  return shell("Thank you", `
<div class="band">
  <h1>Thank you</h1>
  <p>We have your enquiry and will come back to you shortly to arrange that
     first conversation.</p>
</div>
<div class="shell"><p>If it is urgent, call
  <a href="tel:+442070888267">+44 20 7088 8267</a> or email
  <a href="mailto:info@thepaymaster.co.uk">info@thepaymaster.co.uk</a>.</p></div>`);
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export async function inbox(env: Env, admin: { name: string }): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, email, amount_minor, currency, expected_on, likelihood,
            contact_pref, whatsapp_ok, status, created_at, transaction_id
       FROM enquiries ORDER BY
       CASE status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1
                   WHEN 'call_booked' THEN 2 ELSE 3 END, created_at DESC`).all<any>();

  const rows = (results ?? []).map((e) => {
    const amount = e.amount_minor
      ? `${esc(e.currency)} ${format(e.amount_minor, CURRENCIES[e.currency] ?? 2)}` : "—";
    return `<tr>
      <td><a href="/e/${esc(e.id)}">${esc(e.name)}</a><div class="muted">${esc(e.email)}</div></td>
      <td>${amount}</td>
      <td>${esc(e.expected_on ?? "—")}</td>
      <td>${esc(LIKELIHOOD[e.likelihood] ?? "—")}</td>
      <td>${esc(e.contact_pref ?? "—")}${e.whatsapp_ok ? " · WhatsApp ok" : ""}</td>
      <td><span class="tag">${esc(e.status)}</span></td>
      <td class="muted">${esc(e.created_at)}</td></tr>`;
  }).join("");

  return page("Enquiries", `<h1>Enquiries</h1>
    <div class="panel" style="max-width:none">
      ${rows ? `<table><tr><th>Who</th><th>Amount</th><th>Expected</th><th>Likelihood</th>
        <th>Contact</th><th>Status</th><th>Received</th></tr>${rows}</table>`
      : `<p class="muted">Nothing yet. The form is at
         <a href="/enquiry">/enquiry</a>.</p>`}
    </div>`, { nav: nav("/enquiries", admin.name) });
}

export async function enquiryDetail(env: Env, admin: { name: string }, eid: string): Promise<Response> {
  const e = await env.DB.prepare("SELECT * FROM enquiries WHERE id = ?")
    .bind(eid).first<Record<string, any>>();
  if (!e) return new Response("Not found", { status: 404 });

  const { results: trail } = await env.DB.prepare(
    `SELECT at, actor_kind, action, note FROM audit_log
      WHERE entity_id = ? ORDER BY id DESC LIMIT 30`).bind(eid).all<any>();

  const kv = (k: string, v: string) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const amount = e.amount_minor
    ? `${esc(e.currency)} ${format(e.amount_minor, CURRENCIES[e.currency] ?? 2)}` : "—";
  const wa = e.whatsapp_ok
    ? `<span class="tag">WhatsApp consented</span>`
    : `<span class="muted">no WhatsApp consent</span>`;

  const actions = e.transaction_id
    ? `<p>Became <a href="/t/${esc(e.transaction_id)}">a transaction</a>.</p>`
    : `<form method="post" action="/e/${esc(eid)}/status">
        <label for="note">Note (recorded against your name)</label>
        <input id="note" name="note" placeholder="Called, Zoom booked for Thursday">
        <div class="row">
          <button class="plain" name="to" value="contacted">Contacted</button>
          <button class="plain" name="to" value="call_booked">Call booked</button>
          <button class="plain" name="to" value="dead">Dead</button>
          <button class="go" name="to" value="converted">Create transaction from this</button>
        </div></form>`;

  return page(e.name, `<h1>${esc(e.name)}</h1>
    <div class="panel"><table>
      ${kv("Email", `<a href="mailto:${esc(e.email)}">${esc(e.email)}</a>`)}
      ${kv("Phone", e.phone ? `${esc(e.phone)} — ${wa}` : "—")}
      ${kv("Wants", esc(e.contact_pref ?? "—"))}
      ${kv("Amount", amount)}
      ${kv("Expected", esc(e.expected_on ?? "—"))}
      ${kv("Likelihood", esc(LIKELIHOOD[e.likelihood] ?? "—"))}
      ${kv("Status", `<span class="tag">${esc(e.status)}</span>`)}
      ${kv("Received", esc(e.created_at))}
      ${e.source ? kv("From page", esc(e.source)) : ""}
    </table></div>

    <h2>What they said</h2>
    <div class="panel"><p style="white-space:pre-wrap;margin:0">${esc(e.detail ?? "—")}</p>
      <p class="muted" style="margin-bottom:0">Captured as written and never edited —
        this is the first entry in the dossier.</p></div>

    <h2>Move it on</h2>
    <div class="panel">${actions}</div>

    <h2>History</h2>
    <div class="panel"><table class="log">
      ${(trail ?? []).map((t) => `<tr><td>${esc(t.at)}</td><td>${esc(t.action)}</td>
        <td>${esc(t.note ?? "")}</td></tr>`).join("")}
    </table></div>`, { nav: nav("/enquiries", admin.name) });
}

/**
 * Move an enquiry along, and — for 'converted' — open a draft transaction
 * carrying what we were told, so nothing has to be retyped and the enquiry
 * stays joined to what it became.
 */
export async function enquiryStatus(request: Request, env: Env, actor: Actor,
                                    eid: string, nextRef: () => Promise<string>): Promise<Response> {
  const f = await request.formData();
  const to = String(f.get("to") ?? "");
  const note = String(f.get("note") ?? "").trim();
  if (!["contacted", "call_booked", "dead", "converted"].includes(to)) {
    return new Response("Unknown status", { status: 400 });
  }

  const e = await env.DB.prepare("SELECT * FROM enquiries WHERE id = ?")
    .bind(eid).first<Record<string, any>>();
  if (!e) return new Response("Not found", { status: 404 });
  if (e.transaction_id) return Response.redirect(new URL(`/e/${eid}`, request.url).toString(), 302);

  if (to !== "converted") {
    await record(env.DB, actor, `enquiry.${to}`, "enquiries", eid, { status: to },
      { before: { status: e.status }, note: note || undefined });
    return Response.redirect(new URL(`/e/${eid}`, request.url).toString(), 302);
  }

  // The legs are unknown at this point — that is what the call is for — so the
  // draft starts as fiat to fiat and is corrected on the transaction itself.
  const txId = id("tx");
  const ref = await nextRef();
  const currency = e.currency ?? "GBP";
  const decimals = CURRENCIES[currency] ?? 2;
  await record(env.DB, actor, "transaction.created", "transactions", txId, {
    ref, name: `${e.name} — enquiry ${e.created_at?.slice(0, 10) ?? ""}`.trim(),
    detail: e.detail ?? null,
    inbound: "fiat", outbound: "fiat", converts: 0,
    currency_in: currency, currency_out: currency,
    decimals_in: decimals, decimals_out: decimals,
    fee_bps: 100, fee_mode: "deducted",
    gross_expected_minor: e.amount_minor ?? null,
    status: "draft", created_by: actor.id,
  }, { note: `from enquiry ${eid}` });

  await record(env.DB, actor, "enquiry.converted", "enquiries", eid,
    { status: "converted", transaction_id: txId },
    { before: { status: e.status }, note: note || undefined });

  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}
