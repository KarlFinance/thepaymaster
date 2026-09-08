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
import { startPage, startSubmit, joinLink, signOut, clientHome, clientDeal,
         clientVerify } from "./client.ts";
import { reviewQueue, decide, whatIsMissing, peopleOf, standingCheck,
         history, documentsFor } from "./kyc.ts";
import { fetchDocument, store, DocumentProblem } from "./documents.ts";
import { assess, summarise } from "./readiness.ts";
import { arrival, legs, events as custodyEvents, settlementChecks,
         record as recordCustody, holderFor } from "./settlement.ts";
import { forTransaction, lock as lockDestination, requestChange,
         approveChange, describe as describeDestination } from "./destinations.ts";
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
        if (url.pathname === "/verify") {
          return clientVerify(env, request, (p) => ctx.waitUntil(p));
        }
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
      if (url.pathname === "/kyc") return kycQueue(env, admin);
      if (url.pathname.startsWith("/p/")) {
        const pid = url.pathname.slice(3).split("/")[0];
        if (url.pathname.endsWith("/decide") && request.method === "POST") {
          return kycDecide(request, env, actor, pid);
        }
        return partyView(env, admin, pid);
      }
      if (url.pathname.startsWith("/doc/")) {
        return serveDocument(env, actor, url.pathname.slice(5));
      }
      if (url.pathname === "/log") return auditView(env, admin);
      if (url.pathname.startsWith("/t/")) {
        const txId = url.pathname.slice(3).split("/")[0];
        if (url.pathname.endsWith("/settle")) {
          return request.method === "POST"
            ? recordSettlement(request, env, actor, txId)
            : settlePage(env, admin, txId);
        }
        if (url.pathname.endsWith("/move") && request.method === "POST") {
          return move(request, env, actor, txId);
        }
        if (url.pathname.endsWith("/startlink") && request.method === "POST") {
          return sendStartLink(request, env, actor, txId, (p) => ctx.waitUntil(p));
        }
        if (url.pathname.endsWith("/split") && request.method === "POST") {
          return setSplit(request, env, actor, txId);
        }
        if (url.pathname.endsWith("/lock") && request.method === "POST") {
          const f = await request.formData();
          const problem = await lockDestination(env, actor,
            String(f.get("destination") ?? ""));
          if (problem) return new Response(problem, { status: 400 });
          return Response.redirect(new URL(`/t/${txId}`, url).toString(), 302);
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
    `SELECT p.id AS participation_id, p.role, p.invited_at, p.amount_minor,
            p.share_bps, y.id AS party_id, y.display_name, y.email
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ? ORDER BY
        CASE p.role WHEN 'sender' THEN 0 WHEN 'recipient' THEN 1 ELSE 2 END,
        y.display_name`).bind(txId).all<any>();

  const roster = (people ?? []).length
    ? `<table><tr><th>Who</th><th>Role</th><th>Invited</th></tr>` +
      people!.map((p) => `<tr><td><a href="/p/${esc(p.party_id)}">${esc(p.display_name)}</a>
        <div class="muted">${esc(p.email)}</div></td>
        <td><span class="tag">${esc(p.role)}</span></td>
        <td class="muted">${esc(p.invited_at ?? "not yet")}</td></tr>`).join("") + `</table>`
    : `<p class="muted">Nobody yet. Send the sender a start link and they will
        tell us who is involved.</p>`;

  const state = await assess(env, txId);
  const gate = `
    <h2>Readiness</h2>
    <div class="panel"><table>
      ${state.checks.map((c) => `<tr>
        <td style="width:26px">${c.met ? "&#10003;" : "&#8212;"}</td>
        <td><strong>${esc(c.label)}</strong><div class="muted">${esc(c.detail)}</div></td>
        <td class="muted">${esc(c.at ?? "")}</td></tr>`).join("")}
    </table>
    <p class="muted" style="margin-bottom:0">${state.ready
      ? "Everything is green. This can be moved to ready."
      : "The gate is closed until every line is ticked. Moving it on is refused, not just discouraged."}</p>
    </div>`;

  const splitForm = `
    <h2>The split</h2>
    <div class="panel">
      <p class="muted">${t.fee_mode === "deducted"
        ? `The sender's figure is fixed, so recipients take a percentage of what is
           left after the fee. The percentages must total 100.`
        : `The recipients' figures are fixed, so the sender sends
           <strong>more</strong> — the gross is worked out as net ÷ (1 − fee), not
           net × (1 + fee).`}</p>
      <form method="post" action="/t/${esc(txId)}/split">
        <table><tr><th>Recipient</th><th>${t.fee_mode === "deducted"
          ? "Share of the net (%)" : `Receives (${esc(t.currency_out)})`}</th></tr>
        ${(people ?? []).filter((p) => p.role === "recipient").map((p) => `<tr>
          <td>${esc(p.display_name)}</td>
          <td><input name="v_${esc(p.participation_id)}" style="max-width:180px"
            value="${t.fee_mode === "deducted"
              ? (p.share_bps ? (p.share_bps / 100).toString() : "")
              : (p.amount_minor ? format(p.amount_minor, t.decimals_out) : "")}"></td>
        </tr>`).join("")}
        </table>
        <div class="row"><button class="go">Save the split</button></div>
      </form>
      ${state.settlement ? `<table style="margin-top:16px">
        <tr><th>Sender sends</th><td>${esc(t.currency_in)}
          ${format(state.settlement.grossMinor, t.decimals_in)}</td></tr>
        <tr><th>Our fee</th><td>${esc(t.currency_in)}
          ${format(state.settlement.feeMinor, t.decimals_in)}</td></tr>
        <tr><th>Distributed</th><td>${esc(t.currency_out)}
          ${format(state.settlement.netMinor, t.decimals_out)}</td></tr>
        ${(people ?? []).filter((p) => p.role === "recipient").map((p) => `<tr>
          <th style="font-weight:400">&rarr; ${esc(p.display_name)}</th>
          <td>${esc(t.currency_out)} ${format(
            state.settlement!.amounts[p.participation_id] ?? 0, t.decimals_out)}</td></tr>`).join("")}
      </table>` : ""}
    </div>`;

  const dests = await forTransaction(env, txId);
  const destinations = dests.length ? `
    <h2>Where the money goes</h2>
    <div class="panel" style="max-width:none"><table>
      <tr><th>Recipient</th><th>Details</th><th>State</th><th></th></tr>
      ${dests.map((d) => `<tr>
        <td>${esc(d.display_name)}<div class="muted">${esc(d.email)}</div></td>
        <td><pre style="white-space:pre-wrap;font:inherit;margin:0;font-size:13.5px">${
          d.id ? esc(describeDestination(d as any)) : '<span class="muted">nothing yet</span>'}</pre></td>
        <td><span class="tag">${esc(d.status ?? "none")}</span></td>
        <td>${d.status === "confirmed"
          ? `<form method="post" action="/t/${esc(txId)}/lock">
               <input type="hidden" name="destination" value="${esc(d.id)}">
               <button class="plain">Lock</button></form>`
          : d.status === "locked"
            ? `<span class="muted">${esc((d.locked_at ?? "").slice(0, 16))}</span>`
            : ""}</td></tr>`).join("")}
    </table>
    <p class="muted" style="margin-bottom:0">A recipient enters and reads back their own
       details. Locking is ours. Changing a locked one takes two of us.</p>
    </div>` : "";

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

    ${splitForm}
    ${gate}
    ${destinations}
    ${["ready","settling","settled","closed"].includes(t.status)
      ? `<h2>Settlement</h2><div class="panel">
          <p class="muted">Recording what actually moved, with the paperwork.</p>
          <p><a href="/t/${esc(txId)}/settle"><button class="go" type="button">
            Open the settlement sheet</button></a></p></div>`
      : ""}

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

  // The gate. Marking something ready when it is not is the one mistake this
  // whole design exists to prevent, so it is refused here rather than merely
  // discouraged in the interface.
  if (to === "ready" || to === "settling") {
    const state = await assess(env, txId);
    if (!state.ready) {
      const short = state.checks.filter((c) => !c.met).map((c) => c.label).join("; ");
      return new Response(`Not ready: ${short}`, { status: 400 });
    }
  }

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

// ---------------------------------------------------------------------------
// Verification, from our side
// ---------------------------------------------------------------------------

async function kycQueue(env: Env, admin: { name: string }): Promise<Response> {
  const rows = await reviewQueue(env);
  const waiting = rows.filter((r) => r.status === "pending");
  const done = rows.filter((r) => r.status !== "pending");

  const table = (list: any[]) => list.length
    ? `<table><tr><th>Who</th><th>Kind</th><th>Documents</th><th>Sent</th><th>State</th></tr>` +
      list.map((r) => `<tr>
        <td><a href="/p/${esc(r.id)}">${esc(r.legal_name || r.display_name)}</a>
          <div class="muted">${esc(r.email)}</div></td>
        <td>${esc(r.kind)}</td><td>${r.docs}</td>
        <td class="muted">${esc((r.kyc_submitted_at ?? "").slice(0, 16))}</td>
        <td><span class="tag">${esc(r.status ?? "—")}</span></td></tr>`).join("") + `</table>`
    : `<p class="muted">Nothing here.</p>`;

  return page("Verification", `<h1>Verification</h1>
    <h2>Waiting on us</h2>
    <div class="panel" style="max-width:none">${table(waiting)}</div>
    <h2>Decided</h2>
    <div class="panel" style="max-width:none">${table(done)}</div>
    <p class="muted">Checks are run at Themis. What is recorded here is what was
       collected, what was concluded, and by whom.</p>`,
    { nav: nav("/kyc", admin.name) });
}

async function partyView(env: Env, admin: { name: string }, partyId: string): Promise<Response> {
  const p = await env.DB.prepare("SELECT * FROM parties WHERE id = ?")
    .bind(partyId).first<any>();
  if (!p) return new Response("Not found", { status: 404 });

  const docs = await documentsFor(env, partyId);
  const people = p.kind === "company" ? await peopleOf(env, partyId) : [];
  const past = await history(env, partyId);
  const cleared = await standingCheck(env, partyId);
  const missing = await whatIsMissing(env, p);

  const kv = (k: string, v: string) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const detail = p.kind === "company"
    ? kv("Registered name", esc(p.legal_name ?? "—")) +
      kv("Number", esc(p.company_no ?? "—")) +
      kv("Incorporated", `${esc(p.incorporated_in ?? "—")}${p.incorporated_on
        ? `, ${esc(p.incorporated_on)}` : ""}`)
    : kv("Legal name", esc(p.legal_name ?? "—")) +
      kv("Date of birth", esc(p.date_of_birth ?? "—")) +
      kv("Nationality", esc(p.nationality ?? "—")) +
      kv("Resides in", esc(p.residence_country ?? "—"));

  const docList = docs.length
    ? `<table><tr><th>Document</th><th>File</th><th>Size</th><th>SHA-256</th></tr>` +
      docs.map((d) => `<tr>
        <td>${esc(d.kind.replace(/_/g, " "))}</td>
        <td><a href="/doc/${esc(d.id)}">${esc(d.filename ?? d.id)}</a></td>
        <td class="muted">${Math.round((d.bytes ?? 0) / 1024)}KB</td>
        <td class="log muted">${esc(String(d.sha256).slice(0, 16))}…</td></tr>`).join("") +
      `</table>`
    : `<p class="muted">Nothing uploaded.</p>`;

  const peopleList = p.kind === "company"
    ? `<h2>Directors and owners</h2><div class="panel">${people.length
        ? `<table><tr><th>Who</th><th>Role</th><th>Owns</th><th>Verified</th></tr>` +
          people.map((x) => `<tr>
            <td><a href="/p/${esc(x.id)}">${esc(x.display_name)}</a>
              <div class="muted">${esc(x.email)}</div></td>
            <td>${esc(x.relation)}</td>
            <td>${x.ownership_bps ? (x.ownership_bps / 100).toFixed(2) + "%" : "—"}</td>
            <td class="muted">${x.kyc_submitted_at ? "submitted" : "not yet"}</td>
          </tr>`).join("") + `</table>`
        : `<p class="muted">None recorded.</p>`}</div>`
    : "";

  const decision = `
    <h2>Decide</h2>
    <div class="panel">
      ${missing.length
        ? `<p class="muted">Still outstanding: ${esc(missing.join(", "))}.</p>` : ""}
      <form method="post" action="/p/${esc(partyId)}/decide">
        <label for="ceil">Cleared up to (GBP, blank for no ceiling)</label>
        <input id="ceil" name="ceiling" placeholder="500,000.00">
        <label for="months">Good for (months)</label>
        <input id="months" name="months" value="12" style="max-width:110px">
        <label for="dn">What you concluded, and from what</label>
        <input id="dn" name="note" placeholder="Themis check clear, passport and bill match">
        <div class="row">
          <button class="go" name="passed" value="1">Pass</button>
          <button class="plain" name="passed" value="0">Refuse</button>
        </div>
        <p class="muted">A ceiling and an expiry are required because a clearance
          that never lapses is how somebody checked for a small deal gets waved
          through a large one two years later.</p>
      </form>
    </div>`;

  const pastList = past.length
    ? `<table class="log"><tr><th>When</th><th>Kind</th><th>By</th><th>State</th><th>Notes</th></tr>` +
      past.map((v) => `<tr><td>${esc((v.verified_at ?? v.created_at ?? "").slice(0, 16))}</td>
        <td>${esc(v.kind)}</td><td>${esc(v.provider)}</td>
        <td><span class="tag">${esc(v.status)}</span></td>
        <td>${esc(v.notes ?? "")}</td></tr>`).join("") + `</table>`
    : `<p class="muted">Nothing yet.</p>`;

  return page(p.display_name, `
    <h1>${esc(p.legal_name || p.display_name)}</h1>
    <div class="panel"><table>
      ${kv("Email", esc(p.email))}
      ${kv("Kind", esc(p.kind))}
      ${detail}
      ${kv("Address", esc(p.address ?? "—"))}
      ${kv("Sent to us", esc(p.kyc_submitted_at ?? "not yet"))}
      ${kv("Standing clearance", cleared
        ? `to ${cleared.band_ceiling_minor === null ? "no ceiling"
            : "GBP " + format(cleared.band_ceiling_minor, 2)}, until
           ${esc((cleared.expires_at ?? "").slice(0, 10))}`
        : `<span class="muted">none</span>`)}
    </table></div>

    <h2>Documents</h2>
    <div class="panel" style="max-width:none">${docList}
      <p class="muted">Each hash was taken as the file arrived, not from our copy —
         so it proves the file has not changed since.</p></div>
    ${peopleList}
    ${decision}

    <h2>Everything concluded so far</h2>
    <div class="panel" style="max-width:none">${pastList}</div>`,
    { nav: nav("/kyc", admin.name) });
}

async function kycDecide(request: Request, env: Env, actor: Actor,
                         partyId: string): Promise<Response> {
  const f = await request.formData();
  const passed = String(f.get("passed") ?? "") === "1";
  const months = Math.max(1, Math.min(60, Number(f.get("months")) || 12));
  const raw = String(f.get("ceiling") ?? "").trim();
  let ceiling: number | null = null;
  if (raw) {
    try { ceiling = parse(raw, 2); }
    catch { return new Response("That ceiling is not an amount", { status: 400 }); }
  }
  await decide(env, actor, partyId, {
    passed, ceilingMinor: ceiling, months,
    note: String(f.get("note") ?? "").trim(),
  });
  return Response.redirect(new URL(`/p/${partyId}`, request.url).toString(), 302);
}

/**
 * Hand a stored document back.
 *
 * Every retrieval is logged. Somebody's passport being looked at is an event,
 * and the dossier should be able to say who looked and when.
 */
async function serveDocument(env: Env, actor: Actor, artefactId: string): Promise<Response> {
  const doc = await fetchDocument(env, artefactId);
  if (!doc) return new Response("Not found", { status: 404 });
  await log(env.DB, actor, "artefact.viewed", "artefacts", artefactId);
  return new Response(doc.body, {
    headers: {
      "Content-Type": doc.contentType,
      "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}


/**
 * Record what each recipient gets.
 *
 * Which column is authoritative depends on the fee mode, and the two are never
 * both set: under 'deducted' the sender's figure is fixed and recipients take
 * percentages of what is left; under 'grossed_up' the recipients' figures are
 * fixed and the sender's total is derived from them. Storing both would be
 * storing a disagreement waiting to happen.
 */
async function setSplit(request: Request, env: Env, actor: Actor,
                        txId: string): Promise<Response> {
  const f = await request.formData();
  const t = await env.DB.prepare("SELECT fee_mode, decimals_out FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!t) return new Response("Not found", { status: 404 });

  const { results } = await env.DB.prepare(
    "SELECT id, amount_minor, share_bps FROM participations WHERE transaction_id = ? AND role = 'recipient'")
    .bind(txId).all<any>();

  for (const p of results ?? []) {
    const raw = String(f.get(`v_${p.id}`) ?? "").trim();
    let amount: number | null = null, share: number | null = null;
    if (raw) {
      if (t.fee_mode === "deducted") {
        const pct = Number(raw.replace(/[%\s]/g, ""));
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return new Response(`"${raw}" is not a percentage between 0 and 100`, { status: 400 });
        }
        share = Math.round(pct * 100);
      } else {
        try { amount = parse(raw, t.decimals_out); }
        catch (e) { return new Response((e as Error).message, { status: 400 }); }
      }
    }
    await update(env.DB, actor, "participation.split_set", "participations", p.id,
      { amount_minor: amount, share_bps: share },
      { amount_minor: p.amount_minor, share_bps: p.share_bps });
  }
  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * The settlement sheet: what arrived, what our fee was, and what went out to
 * each recipient — each with the document that proves it.
 */
async function settlePage(env: Env, admin: { name: string }, txId: string,
                          error = ""): Promise<Response> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!t) return new Response("Not found", { status: 404 });

  const state = await assess(env, txId);
  const got = await arrival(env, txId);
  const all = await legs(env, txId);
  const history = await custodyEvents(env, txId);
  const { checks, complete } = await settlementChecks(env, txId);
  const holder = holderFor(t);
  const today = new Date().toISOString().slice(0, 10);

  const holderName = {
    thepaymaster_hsbc: "our HSBC account", otc_desk: "the OTC desk",
    client: "the client", none: "nobody — it never rests anywhere",
  }[holder];

  const variance = got && got.expectedMinor !== null && got.receivedMinor > 0 && !got.ok
    ? `<div class="err">
        <strong>What arrived is not what was expected.</strong><br>
        Expected ${esc(t.currency_in)} ${format(got.expectedMinor, t.decimals_in)},
        received ${format(got.receivedMinor, t.decimals_in)} —
        ${got.varianceMinor > 0 ? "over" : "short"} by
        ${format(Math.abs(got.varianceMinor), t.decimals_in)}.
        Nothing will be distributed on this until somebody decides what to do and
        records why.
       </div>
       <form method="post" action="/t/${esc(txId)}/settle">
         <input type="hidden" name="action" value="variance">
         <label for="vn">What are we doing about it, and why</label>
         <input id="vn" name="note" required
           placeholder="Sender rounded down; agreed with them to absorb it from our fee">
         <div class="row"><button class="go">Record the decision</button></div>
       </form>`
    : "";

  const arrived = `
    <h2>Money in</h2>
    <div class="panel">
      <p class="muted">Into ${esc(holderName)}. Expected
        ${state.settlement
          ? `${esc(t.currency_in)} ${format(state.settlement.grossMinor, t.decimals_in)}`
          : "an amount not yet worked out"}.</p>
      ${t.variance_note ? `<p class="muted">Variance decided
        ${esc((t.variance_decided_at ?? "").slice(0, 16))}: ${esc(t.variance_note)}</p>` : ""}
      ${variance}
      <form method="post" action="/t/${esc(txId)}/settle" enctype="multipart/form-data">
        <input type="hidden" name="action" value="received">
        <label for="ra">Amount received (${esc(t.currency_in)})</label>
        <input id="ra" name="amount" required
          value="${state.settlement ? format(state.settlement.grossMinor, t.decimals_in) : ""}">
        <label for="rd">When</label>
        <input id="rd" name="on" type="date" value="${today}" required>
        <label for="rf">Evidence — the credit advice, statement line or MT103</label>
        <input id="rf" name="file" type="file">
        <label for="rn">Note</label><input id="rn" name="note">
        <div class="row"><button class="go">Record the receipt</button></div>
      </form>
    </div>`;

  const fee = `
    <h2>Our fee</h2>
    <div class="panel">
      <form method="post" action="/t/${esc(txId)}/settle" enctype="multipart/form-data">
        <input type="hidden" name="action" value="fee">
        <label for="fa">Fee taken (${esc(t.currency_in)})</label>
        <input id="fa" name="amount" required
          value="${state.settlement ? format(state.settlement.feeMinor, t.decimals_in) : ""}">
        <label for="fd">When</label>
        <input id="fd" name="on" type="date" value="${today}" required>
        <label for="ff">Evidence</label><input id="ff" name="file" type="file">
        <div class="row"><button class="go">Record the fee</button></div>
      </form>
      <p class="muted" style="margin-bottom:0">${t.fee_mode === "deducted"
        ? "Deducted from what arrived, so the recipients share what is left."
        : "Added on top, so the recipients receive their figures in full."}</p>
    </div>`;

  const payouts = `
    <h2>Money out</h2>
    <div class="panel" style="max-width:none">
      <table><tr><th>Recipient</th><th>Owed</th><th>Sent</th><th>Evidence</th><th></th></tr>
      ${all.map((l) => `<tr>
        <td>${esc(l.name)}</td>
        <td>${esc(t.currency_out)} ${format(l.expectedMinor, t.decimals_out)}</td>
        <td>${l.sentMinor === null ? `<span class="muted">not yet</span>`
          : `${esc(t.currency_out)} ${format(l.sentMinor, t.decimals_out)}
             <div class="muted">${esc((l.sentAt ?? "").slice(0, 10))}</div>`}</td>
        <td>${l.evidenceId ? `<a href="/doc/${esc(l.evidenceId)}">document</a>`
          : l.sentMinor !== null ? `
            <form method="post" action="/t/${esc(txId)}/settle" enctype="multipart/form-data">
              <input type="hidden" name="action" value="evidence">
              <input type="hidden" name="participation" value="${esc(l.participationId)}">
              <input name="file" type="file" required style="max-width:170px">
              <button class="plain">Attach</button>
            </form>`
          : `<span class="muted">none</span>`}</td>
        <td>${l.sentMinor === null ? `
          <form method="post" action="/t/${esc(txId)}/settle" enctype="multipart/form-data">
            <input type="hidden" name="action" value="payout">
            <input type="hidden" name="participation" value="${esc(l.participationId)}">
            <input name="amount" value="${format(l.expectedMinor, t.decimals_out)}"
              style="max-width:130px">
            <input name="on" type="date" value="${today}" style="max-width:150px">
            <input name="file" type="file" style="max-width:190px">
            <button class="plain">Record</button>
          </form>` : ""}</td></tr>`).join("")}
      </table>
    </div>`;

  const ledger = history.length ? `
    <h2>Everything that moved</h2>
    <div class="panel" style="max-width:none"><table class="log">
      <tr><th>When</th><th>What</th><th>Held by</th><th>Amount</th><th>Evidence</th></tr>
      ${history.map((e) => `<tr>
        <td>${esc((e.occurred_at ?? "").slice(0, 16))}</td>
        <td>${esc(e.event)}</td><td>${esc(e.holder)}</td>
        <td>${esc(e.currency)} ${format(e.amount_minor, e.decimals)}</td>
        <td>${e.artefact ? `<a href="/doc/${esc(e.artefact)}">${esc(e.filename ?? "file")}</a>
          <div class="muted log">${esc(String(e.sha256).slice(0, 16))}…</div>`
          : `<span class="muted">none</span>`}</td></tr>`).join("")}
    </table></div>` : "";

  const closing = `
    <h2>Is it finished?</h2>
    <div class="panel"><table>
      ${checks.map((c) => `<tr><td style="width:26px">${c.met ? "&#10003;" : "&#8212;"}</td>
        <td><strong>${esc(c.label)}</strong>
        <div class="muted">${esc(c.detail)}</div></td></tr>`).join("")}
    </table>
    ${complete && t.status !== "settled" && t.status !== "closed"
      ? `<form method="post" action="/t/${esc(txId)}/move">
           <input type="hidden" name="to" value="settled">
           <input name="note" placeholder="Anything to record" style="margin:10px 0">
           <div class="row"><button class="go">Mark it settled</button></div></form>`
      : `<p class="muted" style="margin-bottom:0">${t.status === "settled" || t.status === "closed"
          ? "Settled." : "Not yet."}</p>`}
    </div>`;

  return page(`${t.ref} settlement`, `
    <h1>${esc(t.ref)} — settlement</h1>
    <p class="muted">${esc(t.name)} · <a href="/t/${esc(txId)}">back to the transaction</a></p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    ${arrived}${fee}${payouts}${ledger}${closing}`,
    { nav: nav("", admin.name) });
}

async function recordSettlement(request: Request, env: Env, actor: Actor,
                                txId: string): Promise<Response> {
  const f = await request.formData();
  const action = String(f.get("action") ?? "");
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!t) return new Response("Not found", { status: 404 });

  const back = () => Response.redirect(new URL(`/t/${txId}/settle`, request.url).toString(), 302);
  const holder = holderFor(t);
  const on = String(f.get("on") ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const file = f.get("file");
  const asFile = file instanceof File && file.size > 0 ? file : null;

  if (action === "variance") {
    await update(env.DB, actor, "transaction.variance_decided", "transactions", txId, {
      variance_note: String(f.get("note") ?? "").trim(),
      variance_decided_by: actor.id,
      variance_decided_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    }, { variance_note: t.variance_note });
    return back();
  }

  if (action === "evidence") {
    // A payment recorded without its document can otherwise never be
    // completed, which turns a sensible requirement into a dead end.
    const participation = String(f.get("participation") ?? "");
    if (!asFile) return settlePage(env, { name: "" }, txId, "No file arrived.");
    const leg = await env.DB.prepare(
      `SELECT c.id FROM custody_events c
         JOIN payout_legs l ON l.event_id = c.id
        WHERE c.transaction_id = ? AND l.participation_id = ?
        ORDER BY c.created_at DESC LIMIT 1`).bind(txId, participation).first<any>();
    if (!leg) return settlePage(env, { name: "" }, txId, "No payment recorded for them yet.");
    try {
      const stored = await store(env, actor, asFile, {
        kind: "payment_confirmation", transactionId: txId,
        label: "attached after the payment was recorded",
      });
      await update(env.DB, actor, "custody.evidence_attached", "custody_events", leg.id,
        { evidence_id: stored.artefactId }, { evidence_id: null });
    } catch (err) {
      if (err instanceof DocumentProblem) {
        return settlePage(env, { name: "" }, txId, err.message);
      }
      throw err;
    }
    return back();
  }

  let amountMinor: number;
  try {
    amountMinor = parse(String(f.get("amount") ?? ""),
      action === "payout" ? t.decimals_out : t.decimals_in);
  } catch (e) {
    return settlePage(env, { name: "" }, txId, (e as Error).message);
  }

  if (action === "received") {
    const result = await recordCustody(env, actor, txId, {
      holder, event: "received", amountMinor,
      currency: t.currency_in, decimals: t.decimals_in, occurredAt: on,
      note: String(f.get("note") ?? "").trim() || undefined,
      file: asFile, evidenceKind: "receipt_advice",
    });
    if (typeof result === "object") return settlePage(env, { name: "" }, txId, result.problem);
    await update(env.DB, actor, "transaction.funds_received", "transactions", txId,
      { gross_received_minor: (t.gross_received_minor ?? 0) + amountMinor },
      { gross_received_minor: t.gross_received_minor });

    // Recording that money has arrived is the transaction entering settlement.
    // This is still a person pressing a button — it is not the system deciding
    // something on its own — so the rule that nothing advances itself holds.
    if (t.status === "ready") {
      await update(env.DB, actor, "transaction.settling", "transactions", txId,
        { status: "settling",
          updated_at: new Date().toISOString().replace("T", " ").slice(0, 19) },
        { status: t.status }, { note: "funds recorded as received" });
    }
    return back();
  }

  if (action === "fee") {
    const result = await recordCustody(env, actor, txId, {
      holder, event: "fee_taken", amountMinor,
      currency: t.currency_in, decimals: t.decimals_in, occurredAt: on,
      file: asFile, evidenceKind: "fee_note",
    });
    if (typeof result === "object") return settlePage(env, { name: "" }, txId, result.problem);
    return back();
  }

  if (action === "payout") {
    const participation = String(f.get("participation") ?? "");
    // A payout on a transaction whose arrival does not reconcile is exactly
    // the thing the variance step exists to stop.
    const got = await arrival(env, txId);
    if (got && !got.ok && !t.variance_note) {
      return settlePage(env, { name: "" }, txId,
        "What arrived does not match what was expected. Record what you are doing " +
        "about that before paying anybody.");
    }
    const result = await recordCustody(env, actor, txId, {
      holder, event: "sent", amountMinor,
      currency: t.currency_out, decimals: t.decimals_out, occurredAt: on,
      file: asFile, evidenceKind: "payment_confirmation",
    });
    if (typeof result === "object") return settlePage(env, { name: "" }, txId, result.problem);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO payout_legs (event_id, participation_id) VALUES (?, ?)")
      .bind(result, participation).run();
    await log(env.DB, actor, "payout.recorded", "participations", participation,
      { note: `${t.currency_out} ${format(amountMinor, t.decimals_out)}` });
    return back();
  }

  return new Response("Unknown action", { status: 400 });
}
