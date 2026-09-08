/**
 * ThePaymaster admin — Phase 1.
 *
 * What exists here is the spine and nothing more: transactions can be created
 * by hand, moved through the pipeline, and every change is written to an
 * append-only log with the name of whoever made it. No client portal, no
 * invites, no KYC, no money. Those come next, and they all hang off this.
 */

import { type Env, type Actor, id, nextRef, log, insert, update, canMove, typeName,
         isOnChain, destinationKind, FLOW } from "./db.ts";
import { currentAdmin, loginScreen, handleLogin, handleTotp, handleTotpSetup,
         handleSignOut, handleAccount } from "./adminauth.ts";
import { page, nav, board, esc, type Row } from "./views.ts";
import { enquiryForm, submitEnquiry, inbox, enquiryDetail, enquiryStatus } from "./enquiry.ts";
import { startPage, startSubmit, joinLink, signOut, clientHome, clientDeal } from "./client.ts";
import { mint } from "./tokens.ts";
import { send, startLink, invite } from "./email.ts";

/**
 * Staff only, and only on this hostname.
 *
 * Locally the two sides need separating too, so 127.0.0.1 stands in for the
 * admin host and localhost for the client one — two names for the same
 * address, which keeps the split honest while developing. Neither can be
 * reached from anywhere but this machine.
 */
const ADMIN_HOST = "admin.thepaymaster.co.uk";
const LOCAL_ADMIN_HOST = "127.0.0.1";
const CLIENT_BASE = "https://client.thepaymaster.co.uk";

/** Where client links point. Overridden locally so the loop can be walked. */
function clientBase(env: Env, url: URL): string {
  if (env.CLIENT_BASE) return env.CLIENT_BASE;
  return url.hostname === LOCAL_ADMIN_HOST ? `http://localhost:${url.port}` : CLIENT_BASE;
}
import { format, parse } from "./money.ts";

const CURRENCIES: Record<string, number> = {
  GBP: 2, EUR: 2, USD: 2, USDT: 6, USDC: 6, BTC: 8, ETH: 18,
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? undefined;

    try {
      // Public, and deliberately before anything else: the front door cannot
      // be behind a login.
      if (url.pathname === "/enquiry") {
        return request.method === "POST"
          ? submitEnquiry(request, env, (p) => ctx.waitUntil(p))
          : enquiryForm();
      }

      // Clients and staff are separated by hostname as well as by credential.
      // The admin routes below simply do not exist anywhere but the admin
      // host, so a mistake in the Access configuration cannot expose them on
      // an address clients already have.
      const isAdminHost = url.hostname === ADMIN_HOST
        || url.hostname === LOCAL_ADMIN_HOST;
      if (!isAdminHost) {
        if (url.pathname.startsWith("/start/")) {
          const value = url.pathname.slice(7);
          return request.method === "POST"
            ? startSubmit(env, value, request, (p) => ctx.waitUntil(p))
            : startPage(env, value);
        }
        if (url.pathname.startsWith("/join/")) {
          return joinLink(env, url.pathname.slice(6), request);
        }
        if (url.pathname === "/signout") return signOut(env, request);
        if (url.pathname === "/") return clientHome(env, request);
        if (url.pathname.startsWith("/d/")) {
          return clientDeal(env, request, url.pathname.slice(3).split("/")[0]);
        }
        return new Response("Not found", { status: 404 });
      }
      // Everything past here is staff-only, and the gate is Cloudflare
      // Access. There is no password of our own any more: one place to grant
      // someone entry, one place to revoke it, and no second login to explain.
      // Sign-in screens, before any session check.
      if (url.pathname === "/login") {
        return request.method === "POST" ? handleLogin(env, request) : loginScreen();
      }
      if (url.pathname === "/2fa") return handleTotp(env, request);
      if (url.pathname === "/2fa/setup") return handleTotpSetup(env, request);
      if (url.pathname === "/signout") return handleSignOut(env, request);

      const session = await currentAdmin(env, request);
      if (!session) return Response.redirect(new URL("/login", url).toString(), 302);
      const { admin, sessionId } = session;
      const actor: Actor = { kind: "admin", id: admin.id, ip };

      // A password we issued is not a password they chose. Nothing else is
      // reachable until it has been replaced.
      if (admin.must_change_password && url.pathname !== "/account") {
        return Response.redirect(new URL("/account", url).toString(), 302);
      }
      if (url.pathname === "/account") {
        return handleAccount(env, request, actor, admin, sessionId);
      }

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
        if (url.pathname.endsWith("/startlink") && request.method === "POST") {
          return sendStartLink(request, env, actor, txId, (p) => ctx.waitUntil(p));
        }
        if (url.pathname.endsWith("/release") && request.method === "POST") {
          return release(request, env, actor, txId, (p) => ctx.waitUntil(p));
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
  await insert(env.DB, actor, "transaction.created", "transactions", txId, {
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

  const { results: people } = await env.DB.prepare(
    `SELECT p.role, p.invited_at, y.display_name, y.email
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ? ORDER BY
        CASE p.role WHEN 'sender' THEN 0 WHEN 'recipient' THEN 1 ELSE 2 END,
        y.display_name`).bind(txId).all<any>();

  const roster = (people ?? []).length
    ? `<table><tr><th>Who</th><th>Role</th><th>Invited</th></tr>` +
      people!.map((p) => `<tr><td>${esc(p.display_name)}<div class="muted">${esc(p.email)}</div></td>
        <td><span class="tag">${esc(p.role)}</span></td>
        <td class="muted">${esc(p.invited_at ?? "not yet")}</td></tr>`).join("") + `</table>`
    : `<p class="muted">Nobody yet. Send the sender a start link and they will
        tell us who is involved.</p>`;

  const startForm = t.status === "draft" ? `
    <h2>Ask the sender to set it up</h2>
    <div class="panel">
      <form method="post" action="/t/${esc(txId)}/startlink">
        <label for="se">Sender's email</label>
        <input id="se" name="email" type="email" required placeholder="them@company.com">
        <div class="row"><button class="go">Send the start link</button></div>
        <p class="muted">They fill in who is involved. Nothing reaches a recipient
           until you release it.</p>
      </form>
    </div>` : "";

  const releaseForm = (t.submitted_at && t.status === "draft") ? `
    <h2>Release it</h2>
    <div class="panel">
      <div class="muted" style="margin-bottom:10px">Submitted by
        ${esc(t.submitted_by ?? "the sender")} on ${esc(t.submitted_at)}.</div>
      <form method="post" action="/t/${esc(txId)}/release">
        <label for="rn">Anything to record before it goes out</label>
        <input id="rn" name="note" placeholder="Checked against the enquiry, happy to proceed">
        <div class="row"><button class="go">Release and invite everyone</button></div>
        <p class="muted">This emails every party a link to their own account. It is the
           first thing any recipient hears from us.</p>
      </form>
    </div>` : "";

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

    <h2>Who is on it</h2>
    <div class="panel">${roster}</div>
    ${startForm}${releaseForm}

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

  await update(env.DB, actor, `transaction.${to}`, "transactions", txId,
    { status: to, updated_at: new Date().toISOString().replace("T", " ").slice(0, 19) },
    { status: t.status }, { note: note || undefined });
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

// ---------------------------------------------------------------------------
// The loop: start link out, submission back, invitations released
// ---------------------------------------------------------------------------

/**
 * Send the sender a link to set their own transaction up.
 *
 * We ask for their email rather than assuming one, because at this point the
 * only thing we may have is an enquiry, and the person who enquired is not
 * always the person who will be sending the money.
 */
async function sendStartLink(request: Request, env: Env, actor: Actor, txId: string,
                             later: (p: Promise<unknown>) => void): Promise<Response> {
  const f = await request.formData();
  const email = String(f.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return new Response("That is not an email address", { status: 400 });
  }
  const tx = await env.DB.prepare("SELECT ref, status FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!tx) return new Response("Not found", { status: 404 });
  if (tx.status !== "draft") {
    return new Response("Start links are only for drafts", { status: 400 });
  }

  const { url } = await mint(env, actor, {
    purpose: "start", email, base: clientBase(env, new URL(request.url)),
    transactionId: txId,
  });
  later(send(env, actor, {
    ...startLink(tx.ref, url), to: email,
    about: { kind: "transactions", id: txId },
  }));
  await log(env.DB, actor, "transaction.start_link_sent", "transactions", txId,
    { note: `to ${email}` });
  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}

/**
 * Release a submitted transaction: invite everyone on it.
 *
 * This is the moment the transaction stops being ours and becomes everybody's,
 * so it is deliberately a separate, deliberate act rather than something that
 * happens when the sender presses submit. Nothing reaches a recipient until a
 * person here has read what the sender wrote and decided to let it go.
 */
async function release(request: Request, env: Env, actor: Actor, txId: string,
                       later: (p: Promise<unknown>) => void): Promise<Response> {
  const f = await request.formData();
  const note = String(f.get("note") ?? "").trim();

  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!tx) return new Response("Not found", { status: 404 });
  if (!canMove(tx.status, "awaiting_parties")) {
    return new Response("Not in a state to be released", { status: 400 });
  }

  const { results: parties } = await env.DB.prepare(
    `SELECT p.id AS participation_id, p.role, y.id AS party_id,
            y.display_name, y.email
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ?`).bind(txId).all<any>();
  if (!parties || parties.length === 0) {
    return new Response("Nobody on this transaction to invite", { status: 400 });
  }
  const sender = parties.find((p) => p.role === "sender");

  await update(env.DB, actor, "transaction.released", "transactions", txId,
    { status: "awaiting_parties",
      updated_at: new Date().toISOString().replace("T", " ").slice(0, 19) },
    { status: tx.status },
    { note: note || `invited ${parties.length} ${parties.length === 1 ? "party" : "parties"}` });

  later((async () => {
    for (const p of parties) {
      const { url } = await mint(env, actor, {
        purpose: "join", email: p.email, base: clientBase(env, new URL(request.url)),
        transactionId: txId, participationId: p.participation_id,
      });
      await env.DB.prepare("UPDATE participations SET invited_at = datetime('now') WHERE id = ?")
        .bind(p.participation_id).run();
      await send(env, actor, {
        ...invite({
          ref: tx.ref, name: tx.name, role: p.role,
          senderName: sender?.display_name ?? "A client", url,
        }),
        to: p.email,
        about: { kind: "participations", id: p.participation_id },
      });
    }
  })());

  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}
