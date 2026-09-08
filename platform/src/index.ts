/**
 * ThePaymaster admin — Phase 1.
 *
 * What exists here is the spine and nothing more: transactions can be created
 * by hand, moved through the pipeline, and every change is written to an
 * append-only log with the name of whoever made it. No client portal, no
 * invites, no KYC, no money. Those come next, and they all hang off this.
 */

import { type Env, type Actor, id, nextRef, log, record, canMove, typeName,
         isOnChain, destinationKind, FLOW } from "./db.ts";
import { identify } from "./access.ts";
import { page, nav, board, esc, type Row } from "./views.ts";
import { enquiryForm, submitEnquiry, inbox, enquiryDetail, enquiryStatus } from "./enquiry.ts";
import { format, parse } from "./money.ts";

const CURRENCIES: Record<string, number> = {
  GBP: 2, EUR: 2, USD: 2, USDT: 6, USDC: 6, BTC: 8, ETH: 18,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? undefined;

    try {
      // Public, and deliberately before the session check: the front door
      // cannot be behind a login.
      if (url.pathname === "/enquiry") {
        return request.method === "POST"
          ? submitEnquiry(request, env, (p) => ctx.waitUntil(p))
          : enquiryForm();
      }
      // Everything past here is staff-only, and the gate is Cloudflare
      // Access. There is no password of our own any more: one place to grant
      // someone entry, one place to revoke it, and no second login to explain.
      const who = await identify(request);
      if (!who) return noAccess();

      // Passing Access proves who you are, not that you work here. The admins
      // table is still the list of people this application knows.
      const admin = await env.DB.prepare(
        "SELECT id, name, email FROM admins WHERE lower(email) = ? AND active = 1")
        .bind(who.email).first<{ id: string; name: string; email: string }>();
      if (!admin) return notStaff(who.email);

      const actor: Actor = { kind: "admin", id: admin.id, ip };

      if (url.pathname === "/") return pipeline(env, admin);
      if (url.pathname === "/new") {
        return request.method === "POST"
          ? createTransaction(request, env, actor, admin)
          : newForm(admin);
      }
      if (url.pathname === "/enquiries") return inbox(env, admin);
      if (url.pathname.startsWith("/e/")) {
        const eid = url.pathname.slice(3).split("/")[0];
        if (url.pathname.endsWith("/status") && request.method === "POST") {
          return enquiryStatus(request, env, actor, eid, () => nextRef(env.DB));
        }
        return enquiryDetail(env, admin, eid);
      }
      if (url.pathname === "/log") return auditView(env, admin);
      if (url.pathname.startsWith("/t/")) {
        const txId = url.pathname.slice(3).split("/")[0];
        if (url.pathname.endsWith("/move") && request.method === "POST") {
          return move(request, env, actor, txId);
        }
        return detail(env, admin, txId);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      // Never leak internals to a browser; the message goes to the tail.
      console.error(err);
      return new Response("Something went wrong.", { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------------

/**
 * Reached without a verified Access assertion.
 *
 * In normal operation this is unreachable — Access intercepts first. Seeing it
 * means the route or the Access application has come adrift, so it says so
 * plainly rather than falling back to anything more permissive.
 */
function noAccess(): Response {
  return page("Not available", `<div class="login"><h1>Not available</h1>
    <p>This panel is reached through Cloudflare Access. No verified session was
       presented with this request.</p>
    <p class="muted">If you are seeing this after signing in, the Access
       application covering admin.thepaymaster.co.uk needs checking.</p></div>`);
}

/** Through Access, but not someone this application knows. */
function notStaff(email: string): Response {
  return page("No account", `<div class="login"><h1>No account here</h1>
    <p>${esc(email)} passed Access but is not on this application's staff list.</p>
    <p class="muted">Someone with an account needs to add you.</p></div>`);
}

// ---------------------------------------------------------------------------

async function pipeline(env: Env, admin: { name: string }): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, ref, name, status, inbound, outbound, converts,
            currency_in, decimals_in, gross_expected_minor
       FROM transactions ORDER BY updated_at DESC`).all<Row>();
  return page("Pipeline", board(results ?? []), { nav: nav("/", admin.name) });
}

function newForm(admin: { name: string }, error = ""): Response {
  const opts = Object.keys(CURRENCIES).map((c) => `<option>${c}</option>`).join("");
  return page("New transaction", `<h1>New transaction</h1>${error}
  <form method="post" class="panel">
    <label for="n">Name</label>
    <input id="n" name="name" required placeholder="Ashcroft plant sale — 3 beneficiaries">
    <label for="d">What we know so far</label>
    <textarea id="d" name="detail" rows="3"></textarea>

    <h2>The two legs</h2>
    <p class="muted">The five transaction types are the combinations of these three.
      What recipients must supply follows from the outbound leg alone.</p>
    <label for="i">Inbound</label>
    <select id="i" name="inbound"><option value="fiat">Fiat in</option><option value="crypto">Crypto in</option></select>
    <label for="o">Outbound</label>
    <select id="o" name="outbound"><option value="fiat">Fiat out</option><option value="crypto">Crypto out</option></select>
    <label><input type="checkbox" name="converts" value="1" style="width:auto"> Involves a conversion</label>

    <label for="ci">Currency in</label><select id="ci" name="currency_in">${opts}</select>
    <label for="co">Currency out</label><select id="co" name="currency_out">${opts}</select>
    <label for="g">Expected amount in <span class="muted">(optional at this stage)</span></label>
    <input id="g" name="gross" placeholder="1,000,000.00">

    <h2>Fee</h2>
    <label for="fm">Which number is fixed?</label>
    <select id="fm" name="fee_mode">
      <option value="deducted">What the sender sends — fee comes out of it</option>
      <option value="grossed_up">What the recipients receive — sender sends more</option>
    </select>
    <label for="fb">Rate (basis points)</label><input id="fb" name="fee_bps" value="100">

    <h2>Agency</h2>
    <p class="muted">Paragraph 2(b) is only available to an agent acting for one
      side. Recorded per transaction so it is a documented fact rather than a claim.</p>
    <label for="af">Acting for</label>
    <select id="af" name="acting_for">
      <option value="">Not decided</option><option value="payer">The payer</option><option value="payee">The payee</option>
    </select>

    <div class="row"><button class="go">Create transaction</button>
      <a href="/" class="muted">Cancel</a></div>
  </form>`, { nav: nav("/new", admin.name) });
}

async function createTransaction(request: Request, env: Env, actor: Actor,
                                 admin: { name: string }): Promise<Response> {
  const f = await request.formData();
  const s = (k: string) => String(f.get(k) ?? "").trim();

  const currencyIn = s("currency_in"), currencyOut = s("currency_out");
  const decimalsIn = CURRENCIES[currencyIn], decimalsOut = CURRENCIES[currencyOut];
  if (!s("name")) return newForm(admin, `<div class="err">A name is required.</div>`);
  if (decimalsIn === undefined || decimalsOut === undefined) {
    return newForm(admin, `<div class="err">Unknown currency.</div>`);
  }

  let gross: number | null = null;
  if (s("gross")) {
    try { gross = parse(s("gross"), decimalsIn); }
    catch (e) { return newForm(admin, `<div class="err">${esc((e as Error).message)}</div>`); }
  }

  const txId = id("tx");
  const ref = await nextRef(env.DB);
  await record(env.DB, actor, "transaction.created", "transactions", txId, {
    ref, name: s("name"), detail: s("detail") || null,
    inbound: s("inbound"), outbound: s("outbound"), converts: f.get("converts") ? 1 : 0,
    currency_in: currencyIn, currency_out: currencyOut,
    decimals_in: decimalsIn, decimals_out: decimalsOut,
    fee_bps: Number(s("fee_bps")) || 100,
    fee_mode: s("fee_mode") === "grossed_up" ? "grossed_up" : "deducted",
    acting_for: s("acting_for") || null,
    gross_expected_minor: gross,
    status: "draft", created_by: actor.id,
  });
  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}

// ---------------------------------------------------------------------------

async function detail(env: Env, admin: { name: string }, txId: string): Promise<Response> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(txId).first<Record<string, any>>();
  if (!t) return new Response("Not found", { status: 404 });

  const { results: trail } = await env.DB.prepare(
    `SELECT at, actor_kind, actor_id, action, note FROM audit_log
      WHERE entity_id = ? OR entity_id IN
            (SELECT id FROM participations WHERE transaction_id = ?)
      ORDER BY at DESC, id DESC LIMIT 60`).bind(txId, txId).all<any>();

  const names = await adminNames(env);
  const moves = (FLOW[t.status] ?? []).map((to) =>
    `<button class="plain" name="to" value="${to}">${to.replace(/_/g, " ")}</button>`).join(" ");

  const kv = (k: string, v: string) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  return page(t.ref, `
    <h1>${esc(t.ref)} — ${esc(t.name)}</h1>
    <div class="panel"><table>
      ${kv("Type", esc(typeName(t as any)) + (isOnChain(t as any) ? ' <span class="tag chain">sender executes on-chain</span>' : ' <span class="tag">we settle manually</span>'))}
      ${kv("Status", `<span class="tag">${esc(t.status)}</span>`)}
      ${kv("Recipients supply", destinationKind(t as any) === "bank" ? "Bank details" : "Wallet address")}
      ${kv("Sender proves wallets", t.inbound === "crypto" ? "Yes — one or more" : "No")}
      ${kv("Currencies", `${esc(t.currency_in)} in, ${esc(t.currency_out)} out`)}
      ${kv("Expected in", t.gross_expected_minor
            ? `${esc(t.currency_in)} ${format(t.gross_expected_minor, t.decimals_in)}` : "—")}
      ${kv("Fee", `${(t.fee_bps / 100).toFixed(2)}% — ${t.fee_mode === "deducted"
            ? "deducted from what the sender sends" : "added on top so recipients get their figure"}`)}
      ${kv("Acting for", t.acting_for ? esc(t.acting_for) : '<span class="muted">not decided</span>')}
      ${t.detail ? kv("Notes", esc(t.detail)) : ""}
    </table></div>

    <h2>Move it on</h2>
    <div class="panel">
      ${moves ? `<form method="post" action="/t/${esc(txId)}/move">
        <label for="note">Why (recorded against your name)</label>
        <input id="note" name="note" placeholder="Briefing call done, sender ready">
        <div class="row">${moves}</div></form>`
      : `<p class="muted">This transaction is finished. Nothing further to do.</p>`}
    </div>

    <h2>Everything that has happened</h2>
    <div class="panel"><table class="log">
      ${(trail ?? []).map((e) => `<tr><td>${esc(e.at)}</td>
        <td>${esc(names[e.actor_id] ?? e.actor_kind)}</td>
        <td>${esc(e.action)}</td><td>${esc(e.note ?? "")}</td></tr>`).join("")}
    </table></div>`, { nav: nav("", admin.name) });
}

async function move(request: Request, env: Env, actor: Actor, txId: string): Promise<Response> {
  const f = await request.formData();
  const to = String(f.get("to") ?? "");
  const note = String(f.get("note") ?? "").trim();

  const t = await env.DB.prepare("SELECT status FROM transactions WHERE id = ?")
    .bind(txId).first<{ status: string }>();
  if (!t) return new Response("Not found", { status: 404 });
  if (!canMove(t.status, to)) return new Response("That move is not allowed", { status: 400 });

  await record(env.DB, actor, `transaction.${to}`, "transactions", txId,
    { status: to, updated_at: new Date().toISOString().replace("T", " ").slice(0, 19) },
    { before: { status: t.status }, note: note || undefined });
  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}

async function auditView(env: Env, admin: { name: string }): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT at, actor_kind, actor_id, action, entity_kind, entity_id, note
       FROM audit_log ORDER BY id DESC LIMIT 300`).all<any>();
  const names = await adminNames(env);
  return page("Audit log", `<h1>Audit log</h1>
    <p class="muted">Append-only. Nothing in this table is ever changed or removed.</p>
    <div class="panel" style="max-width:none"><table class="log">
      <tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Note</th></tr>
      ${(results ?? []).map((e) => `<tr><td>${esc(e.at)}</td>
        <td>${esc(names[e.actor_id] ?? e.actor_kind)}</td><td>${esc(e.action)}</td>
        <td>${esc(e.entity_kind)} ${esc(e.entity_id)}</td><td>${esc(e.note ?? "")}</td></tr>`).join("")}
    </table></div>`, { nav: nav("/log", admin.name) });
}

async function adminNames(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT id, name FROM admins").all<any>();
  return Object.fromEntries((results ?? []).map((a) => [a.id, a.name]));
}
