/**
 * Everything a client sees: setting a transaction up, joining one, and their
 * own account.
 *
 * Deliberately plain. The people using this are moving large sums between
 * parties who may not have met, often under time pressure, and frequently on a
 * phone. Every screen answers three questions — what is this, what do you need
 * from me, and what happens next — and nothing else competes for attention.
 */

import { type Env, type Actor, id, log, insert, update, typeName } from "./db.ts";
import { mint, peek, redeem, sessionCookie, clearSession, whoIs, endSession } from "./tokens.ts";
import { send, returnLink } from "./email.ts";
import { esc, REVEAL_CSS, REVEAL_JS } from "./views.ts";
import { SITE, FAVICON, thisYear } from "./chrome.ts";
import { format } from "./money.ts";
import { ownRecord } from "./dossier.ts";
import { clientHelp, HELP_CSS } from "./help.ts";
import { proved as provedAddress, cannotSign } from "./attest.ts";
import { railForTransaction, type Rail } from "./rail.ts";
import { folderData, statementPdf, statementStatus, ownRecordPdf, partyFolder } from "./folder.ts";
import { verifyBody, checkRecord, checkReference, VERIFY_CSS, VERIFY_URL } from "./verify.ts";
import { invite as roomInvite, revoke as roomRevoke, invitesFor, invitePanel } from "./room.ts";
import { cloneTransaction, startOwn, counterparties } from "./loop.ts";
import { principals, roleFor, atLeast, membersOf, inviteMember, revokeMember, teamPanel, type Role } from "./team.ts";
import { annualData, annualPdf, annualJson, yearsFor } from "./annual.ts";
import { badgesFor, explorerToken } from "./badge.ts";
import { recipientJourney, senderJourney, recipientProgress, outcome, strip, line,
         progressTable, STAGE, JOURNEY_CSS } from "./journey.ts";
import { staffAddressConfirmed } from "./notify.ts";
import { plan } from "./execute.ts";
import { standing as standingMandate, history as mandateHistory,
         sign as signMandate, revoke as revokeMandate } from "./mandate.ts";
import { executeBody, recordLeg, recordTest, prepare } from "./executeview.ts";
import { verifyForm, receiveVerification, whatIsMissing, kycStyles,
         peopleOf, standingCheck } from "./kyc.ts";
import { documentsFor } from "./documents.ts";
import { forParticipation, save as saveDestination, confirm as confirmDestination,
         problemWith, describe, type Kind } from "./destinations.ts";
import { proofForm, PROOF_CSS, challengeForDestination, proveDestination,
         removeSendingWallet,
         sendingWallets, addSendingWallet, proveSendingWallet,
         challengeForSendingWallet } from "./proof.ts";

const MAX_RECIPIENTS = 10;

const CSS = `
:root{--ink:#0C1524;--accent:#FF8159;--panel:#F5F7FA;--text:#4A5567;--rule:#DBDFEA;--good:#1B8A5A}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:17px/1.6 "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--panel)}
a{color:var(--ink)}

/* The same shape as the staff panel: a rail down the left, the work centred
   in the rest of the width. */
body{display:flex;min-height:100vh;align-items:stretch}
.rail{background:var(--ink);color:#C9D1DD;width:236px;flex:0 0 236px;
  display:flex;flex-direction:column;padding:22px 0;font-size:15px}
.rail .mark{padding:0 22px 26px}
.rail .mark img{width:158px;height:auto;display:block}
.rail nav{display:flex;flex-direction:column}
.rail a{color:#C9D1DD;text-decoration:none;font-weight:600;font-size:14.5px;
  padding:10px 22px;border-left:3px solid transparent}
.rail a:hover{color:#fff;background:#131F33}
.rail a[aria-current]{color:#fff;background:#131F33;border-left-color:var(--accent)}
.rail .who{margin-top:auto;padding:18px 22px 0;border-top:1px solid #1E2A3C;
  font-size:13px;color:#8C99AC}
.rail .who b{display:block;color:#fff;font-size:14px;margin-bottom:8px;font-weight:700}
.rail .who a{display:block;padding:5px 0;border-left:0;font-size:13.5px}
.rail .who a:hover{background:none;color:var(--accent)}
.sheet{flex:1;min-width:0;display:flex;flex-direction:column}
main{flex:1;width:100%;max-width:780px;margin:0 auto;padding:34px 24px 44px}
.panelfoot{padding:16px 24px 26px;text-align:center;font-size:13px;color:#8C99AC}
@media(max-width:860px){
  body{display:block}
  .rail{width:auto;flex:none;flex-direction:row;flex-wrap:wrap;align-items:center;
    gap:2px;padding:12px 14px}
  .rail .mark{padding:0 14px 0 0}
  .rail .mark img{width:118px}
  .rail nav{flex-direction:row;flex-wrap:wrap}
  .rail a{padding:7px 11px;border-left:0;border-bottom:3px solid transparent;font-size:13.5px}
  .rail a[aria-current]{border-left:0;border-bottom-color:var(--accent)}
  .rail .who{margin:0 0 0 auto;padding:0 0 0 12px;border:0}
  .rail .who b{display:inline;margin:0}
  .rail .who a{display:inline;padding:0 0 0 10px}
  main{padding:22px 16px 32px}
}
.card{background:#fff;border:1px solid var(--rule);border-radius:12px;padding:24px 26px;margin-bottom:18px}
h1{margin:0 0 6px;font-size:clamp(24px,3.6vw,32px);color:var(--ink);font-weight:800;letter-spacing:-.02em}
.sub{margin:0 0 26px;font-size:16px}
h2{margin:0 0 4px;font-size:17px;color:var(--ink);font-weight:700}
h3{margin:24px 0 6px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink)}
label{display:block;margin:16px 0 5px;font-weight:600;color:var(--ink);font-size:15px}
input,textarea,select{width:100%;padding:11px 13px;border:1px solid var(--rule);border-radius:9px;font:inherit;background:#fff}
input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
input[readonly]{background:var(--panel);color:var(--text)}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.wording{white-space:pre-wrap;font:13.5px/1.62 ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--panel);border:1px solid var(--rule);border-radius:10px;
  padding:16px 18px;margin:14px 0;overflow-x:auto}
.card.ask{border-left:4px solid var(--accent)}
.rcpt{border:1px solid var(--rule);border-radius:10px;padding:4px 16px 18px;margin-bottom:12px;background:#fff}
button{background:var(--accent);color:var(--ink);border:0;border-radius:9px;padding:13px 26px;font:inherit;font-weight:700;cursor:pointer}
button.plain{background:#fff;border:1px solid var(--rule);color:var(--ink);padding:10px 18px;font-size:15px}
.muted{color:var(--text);font-size:14px}
.err{background:#FDECEA;border:1px solid #F5C2BC;color:#8A1F11;padding:12px 15px;border-radius:9px;margin-bottom:18px}
.ok{background:#EAF7F0;border:1px solid #B7E0C9;color:#12603D;padding:12px 15px;border-radius:9px;margin-bottom:18px}
table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:10px 0;border-bottom:1px solid var(--rule);font-size:15px}
tr:last-child td{border-bottom:0}
th{width:38%;color:var(--ink);font-weight:600}
.tag{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700;background:var(--panel);border:1px solid var(--rule);color:var(--ink)}
.tag.wait{background:#FFF6EC;border-color:#F2C79A;color:#8A5A1E}
.deal{display:block;padding:16px 0;border-bottom:1px solid var(--rule);text-decoration:none}
.deal:last-child{border-bottom:0}
.deal .ref{font-size:12px;font-weight:700;color:var(--accent);letter-spacing:.04em}
.deal .nm{color:var(--ink);font-weight:700;margin:3px 0}
@media(max-width:560px){.pair{grid-template-columns:1fr}}
`;

function shell(title: string, body: string, who?: string,
               current = ""): Response {
  const item = (href: string, label: string) =>
    `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  // The white logo on the dark rail, as on the site's own footer.
  const bar = `<aside class="rail">
    <div class="mark"><a href="${SITE}/"><img
      src="${SITE}/wp-content/uploads/2024/05/b-logo.png"
      alt="ThePaymaster" width="158" height="45"></a></div>
    ${who ? `<nav>${item("/", "Your transactions")}${item("/verify", "Your details")}${item("/help", "Help")}</nav>
      <div class="who"><b>${esc(who)}</b><a href="/signout">Sign out</a></div>` : ""}
  </aside>`;
  return new Response(`<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ThePaymaster</title><meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="https://thepaymaster.co.uk/wp-content/uploads/elementor/google-fonts/css/plusjakartasans.css">
${FAVICON}
<style>${CSS}${REVEAL_CSS}${kycStyles()}${PROOF_CSS}${JOURNEY_CSS}${HELP_CSS}${VERIFY_CSS}
.card.now{border-color:var(--accent);box-shadow:0 0 0 3px #FFF3ED}</style></head>
<body>${bar}<div class="sheet"><main>${body}</main>
<div class="panelfoot">&copy; ThePaymaster Ltd &reg; ${thisYear()} All Rights Reserved</div>
</div>${REVEAL_JS}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

function gone(reason: string): Response {
  return shell("Link no longer works", `<div class="card">
    <h1>This link no longer works</h1>
    <p class="sub">${esc(reason)}</p>
    <p>Ask us for a new one — <a href="mailto:info@thepaymaster.co.uk">info@thepaymaster.co.uk</a>
       or +44 20 7088 8267.</p></div>`);
}

// ---------------------------------------------------------------------------
// A sender sets their transaction up
// ---------------------------------------------------------------------------

export async function startPage(env: Env, value: string, error = ""): Promise<Response> {
  const tok = await peek(env, value);
  if (!tok || tok.purpose !== "start") {
    return gone("It may have been used already, or it may have expired.");
  }
  const tx = tok.transactionId
    ? await env.DB.prepare("SELECT ref, name, detail FROM transactions WHERE id = ?")
        .bind(tok.transactionId).first<any>()
    : null;

  const rows = Array.from({ length: MAX_RECIPIENTS }, (_, n) => `
    <div class="rcpt" data-row="${n}"${n > 1 ? ' hidden' : ''}>
      <h3>Recipient ${n + 1}</h3>
      <div class="pair">
        <div><label for="rn${n}">Name</label><input id="rn${n}" name="rname${n}" autocomplete="off"></div>
        <div><label for="re${n}">Email</label><input id="re${n}" name="remail${n}" type="email" autocomplete="off"></div>
      </div>
    </div>`).join("");

  return shell("Set up your transaction", `
  <h1>Set up your transaction</h1>
  <p class="sub">${tx ? `Reference <strong>${esc(tx.ref)}</strong>. ` : ""}Tell us who is
     involved. We will check it over before anyone is contacted.</p>
  ${error ? `<div class="err">${error}</div>` : ""}

  <form method="post">
    <div class="card">
      <h2>You</h2>
      <label for="sname">Your name</label>
      <input id="sname" name="sender_name" required autocomplete="name">
      <label for="semail">Your email</label>
      <input id="semail" value="${esc(tok.email)}" readonly>
      <p class="muted">This is the address the transaction is tied to. Tell us if it should
         be a different one.</p>
    </div>

    <div class="card">
      <h2>The transaction</h2>
      <label for="name">Give it a name</label>
      <input id="name" name="name" required value="${esc(tx?.name ?? "")}"
        placeholder="Ashcroft plant sale — completion proceeds">
      <p class="muted">Something you will recognise on a statement in two years.</p>
      <label for="detail">Anything we should know</label>
      <textarea id="detail" name="detail" rows="4"
        placeholder="What the underlying transaction is, why the money is being split this way, anything unusual about timing.">${esc(tx?.detail ?? "")}</textarea>
    </div>

    <div class="card">
      <h2>Who needs paying</h2>
      <p class="muted">Names and email addresses only for now. We will ask each of them for
         their own details directly — you should never send us someone else's bank details
         or wallet address.</p>
      ${rows}
      <noscript><p class="muted">All ten slots are shown. Leave the ones you do not need empty.</p></noscript>
      <button type="button" class="plain" id="more">Add another recipient</button>
    </div>

    <div class="card">
      <button type="submit">Send this to ThePaymaster</button>
      <p class="muted" style="margin-bottom:0">Nothing is sent to any recipient until we have
         checked this over and released it.</p>
    </div>
  </form>
  <script>
    // Rows past the second are hidden rather than absent, so the form works
    // identically with scripting off — every slot is simply visible.
    document.querySelectorAll('.rcpt[hidden]').forEach(function(el){ el.hidden = true });
    var more = document.getElementById('more');
    more.addEventListener('click', function () {
      var next = document.querySelector('.rcpt[hidden]');
      if (next) next.hidden = false;
      if (!document.querySelector('.rcpt[hidden]')) more.hidden = true;
    });
  </script>`);
}

export async function startSubmit(env: Env, value: string, request: Request,
                                  later: (p: Promise<unknown>) => void): Promise<Response> {
  const tok = await peek(env, value);
  if (!tok || tok.purpose !== "start" || !tok.transactionId) {
    return gone("It may have been used already, or it may have expired.");
  }
  const f = await request.formData();
  const s = (k: string) => String(f.get(k) ?? "").trim();
  const ip = request.headers.get("CF-Connecting-IP") ?? undefined;
  const actor: Actor = { kind: "party", id: null, ip };

  if (!s("sender_name")) return startPage(env, value, "We need your name.");
  if (!s("name")) return startPage(env, value, "Please give the transaction a name.");

  // Collect the recipients that were actually filled in.
  const people: { name: string; email: string }[] = [];
  for (let n = 0; n < MAX_RECIPIENTS; n++) {
    const name = s(`rname${n}`), email = s(`remail${n}`).toLowerCase();
    if (!name && !email) continue;
    if (!name || !email) {
      return startPage(env, value, `Recipient ${n + 1} needs both a name and an email.`);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return startPage(env, value, `“${esc(email)}” does not look like an email address.`);
    }
    if (people.some((p) => p.email === email)) {
      return startPage(env, value, `${esc(email)} is listed twice.`);
    }
    people.push({ name, email });
  }
  if (people.length === 0) {
    return startPage(env, value, "Add at least one recipient.");
  }

  const txId = tok.transactionId;
  const senderId = await upsertParty(env, actor, tok.email, s("sender_name"));
  await addParticipation(env, actor, txId, senderId, "sender");
  for (const p of people) {
    const pid = await upsertParty(env, actor, p.email, p.name);
    await addParticipation(env, actor, txId, pid, "recipient");
  }

  const before = await env.DB.prepare(
    "SELECT name, detail, submitted_at FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  await update(env.DB, actor, "transaction.submitted", "transactions", txId, {
    name: s("name"), detail: s("detail") || null,
    submitted_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    submitted_by: tok.email,
  }, before ?? {}, { note: `${people.length} recipient${people.length === 1 ? "" : "s"}` });

  await env.DB.prepare("UPDATE tokens SET used_at = datetime('now') WHERE id = ?")
    .bind(tok.tokenId).run();

  later(notifyStaffOfSubmission(env, actor, txId, tok.email, people.length));

  return shell("Thank you", `<div class="card">
    <h1>Thank you</h1>
    <p class="sub">We have your transaction and will check it over.</p>
    <p>Once we have, everyone involved — including you — gets an email with a link
       to their own account, where we will ask for what we need from each of them.</p>
    <p class="muted">Nothing has been sent to your recipients yet.</p></div>`);
}

async function upsertParty(env: Env, actor: Actor, email: string, name: string): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT id FROM parties WHERE lower(email) = ?").bind(email.toLowerCase()).first<any>();
  if (existing) return existing.id;
  const pid = id("pty");
  await insert(env.DB, actor, "party.created", "parties", pid, {
    kind: "individual", display_name: name, email: email.toLowerCase(),
  });
  return pid;
}

async function addParticipation(env: Env, actor: Actor, txId: string,
                                partyId: string, role: string): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT id FROM participations WHERE transaction_id = ? AND party_id = ? AND role = ?")
    .bind(txId, partyId, role).first<any>();
  if (existing) return;
  await insert(env.DB, actor, "participation.added", "participations", id("par"), {
    transaction_id: txId, party_id: partyId, role,
  });
}

async function notifyStaffOfSubmission(env: Env, actor: Actor, txId: string,
                                       from: string, count: number): Promise<void> {
  const { send, staffEmails } = await import("./email.ts");
  const tx = await env.DB.prepare("SELECT ref, name FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  const staff = await staffEmails(env);
  if (!staff.length || !tx) return;
  await send(env, actor, {
    to: staff,
    subject: `${tx.ref} set up by ${from} — ready to check`,
    text: [
      `${from} has finished setting up ${tx.ref}.`,
      "",
      `Name:       ${tx.name}`,
      `Recipients: ${count}`,
      "",
      "Nothing has gone to the recipients. Check it over, then release it to",
      "send everyone their invitation.",
      "",
      `https://admin.thepaymaster.co.uk/t/${txId}`,
    ].join("\n"),
    about: { kind: "transactions", id: txId },
  });
}

// ---------------------------------------------------------------------------
// Joining, and the account itself
// ---------------------------------------------------------------------------

export async function joinLink(env: Env, value: string, request: Request): Promise<Response> {
  const tok = await peek(env, value);
  if (!tok || tok.purpose !== "join") {
    return gone("It may have been used already, or it may have expired.");
  }
  const party = await env.DB.prepare("SELECT id FROM parties WHERE lower(email) = ?")
    .bind(tok.email.toLowerCase()).first<any>();
  if (!party) return gone("We cannot find the account this link belongs to.");

  const session = await redeem(env, value, party.id, request);
  if (!session) return gone("It has already been used.");

  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": sessionCookie(session) },
  });
}

export async function signOut(env: Env, request: Request): Promise<Response> {
  const who = await whoIs(env, request);
  if (who) await endSession(env, who.sessionId);
  return new Response(null, {
    status: 302, headers: { Location: "/", "Set-Cookie": clearSession },
  });
}

/** The annual statement — one's own, or an organisation's one acts for (any role may read). */
export async function clientAnnual(env: Env, request: Request, year: number, what: "pdf" | "json"): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);
  const forId = new URL(request.url).searchParams.get("for") || who.partyId;
  const mine = await principals(env, who.partyId);
  if (!mine.includes(forId)) return new Response("Not found", { status: 404 });
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return new Response("Not found", { status: 404 });
  const d = await annualData(env, forId, year);
  if (!d) return new Response("Not found", { status: 404 });
  const name = (d.party.legal_name || d.party.display_name).replace(/[^A-Za-z0-9._ -]+/g, "_").trim().replace(/\s+/g, "_");
  await log(env.DB, { kind: "party", id: who.partyId, ip: request.headers.get("CF-Connecting-IP") ?? undefined },
            "annual.downloaded", "parties", forId, { note: `${year} ${what}` });
  if (what === "json") return new Response(annualJson(d), { headers: { "content-type": "application/json", "cache-control": "no-store",
    "content-disposition": `attachment; filename="${name}-${year}-statement.json"` } });
  return new Response(annualPdf(d), { headers: { "content-type": "application/pdf", "cache-control": "no-store",
    "content-disposition": `inline; filename="${name}-${year}-statement.pdf"` } });
}

/** An organisation's own login manages who may act for it. */
export async function clientTeam(env: Env, request: Request): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);
  const party = await env.DB.prepare("SELECT id, display_name, kind FROM parties WHERE id = ?").bind(who.partyId).first<any>();
  if (!party) return signOut(env, request);
  if (party.kind !== "company") {
    return shell("Your team", `<div class="card"><h1>Your team</h1><p>Teams belong to organisations. This account is an individual's.</p>
      <p><a href="/">Back</a></p></div>`, party.display_name);
  }
  const actor: Actor = { kind: "party", id: who.partyId, ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  let error: string | undefined;
  if (request.method === "POST") {
    const f = await request.formData();
    if (f.get("revoke")) error = (await revokeMember(env, actor, String(f.get("revoke")), who.partyId)) ?? undefined;
    else error = (await inviteMember(env, actor, {
      partyId: who.partyId, email: String(f.get("email") ?? ""), name: String(f.get("name") ?? ""),
      role: String(f.get("role") ?? "") as Role, base: new URL(request.url).origin, invitedByName: party.display_name,
    })) ?? undefined;
  }
  return shell("Your team", `
    <h1>Your team</h1>
    <p class="sub">People who may act for ${esc(party.display_name)}. Each has their own login and identity check;
      every action is recorded under their own name with ${esc(party.display_name)} named.</p>
    <div class="card">${teamPanel(await membersOf(env, who.partyId), "/team", { error, canManage: true })}</div>
    <p class="muted"><a href="/">Back to your transactions</a></p>`, party.display_name, "/team");
}

/** A verified party starts a distribution of their own: a draft, and the start form. */
export async function clientStartOwn(env: Env, request: Request): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);
  if (!await standingCheck(env, who.partyId)) return Response.redirect(new URL("/", request.url).toString(), 303);
  const actor: Actor = { kind: "party", id: who.partyId, ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  const made = await startOwn(env, actor, who.partyId, new URL(request.url).origin);
  if ("problem" in made) return new Response(made.problem, { status: 400 });
  return Response.redirect(made.url, 303);
}

/** The sender asks to run a finished distribution again. */
export async function clientAgain(env: Env, request: Request, txId: string): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);
  const actor: Actor = { kind: "party", id: who.partyId, ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  const made = await cloneTransaction(env, actor, txId, { requestedBy: "party", partyId: who.partyId });
  if ("problem" in made) return new Response(made.problem, { status: 400 });
  return Response.redirect(new URL(`/d/${made.id}`, request.url).toString(), 303);
}

/** Everyone this sender has paid, and whether each is still cleared. */
export async function clientCounterparties(env: Env, request: Request): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);
  const party = await env.DB.prepare("SELECT display_name FROM parties WHERE id = ?").bind(who.partyId).first<any>();
  const rows = await counterparties(env, who.partyId);
  const table = rows.length ? `<table class="progress">
      <tr><th>Recipient</th><th>Paid</th><th>Last paid</th><th>Cleared</th><th>Locked address</th></tr>
      ${rows.map((c) => `<tr>
        <td>${esc(c.name)}<div class="muted">${esc(c.email)}</div></td>
        <td>${c.transactions} time${c.transactions === 1 ? "" : "s"}<div class="muted">last ${esc(c.lastRef)}</div></td>
        <td>${c.lastPaidAt ? `${esc(String(c.lastPaidAt).slice(0, 10))}<div class="muted">${c.lastAmountMinor !== null ? `${esc(c.currency ?? "")} ${format(c.lastAmountMinor, c.decimals)}` : ""}</div>` : `<span class="muted">—</span>`}</td>
        <td>${c.cleared ? `<span class="good">&#10003; until ${esc(String(c.clearedUntil).slice(0, 10))}</span>` : `<span class="muted">needs re-verifying</span>`}</td>
        <td class="mono" style="font-size:12px">${c.address ? `${esc(c.address)}${c.addressProved ? ` <span class="good">&#10003; proved</span>` : ""}` : "—"}</td>
      </tr>`).join("")}</table>`
    : `<p class="muted">Nobody yet — once you have sent a distribution, everyone you paid appears here.</p>`;
  return shell("Everyone you have paid", `
    <h1>Everyone you have paid</h1>
    <p class="sub">Across every distribution you have sent. A recipient who is still cleared and has a locked,
      proved address can be paid again without being asked for anything.</p>
    <div class="card">${table}</div>
    <p class="muted"><a href="/">Back to your transactions</a></p>`, party?.display_name, "/counterparties");
}

/** The public verifier: no login, nothing stored, nothing revealed. */
export async function verifyRecordPage(env: Env, request: Request): Promise<Response> {
  const who = await whoIs(env, request);
  const party = who ? await env.DB.prepare("SELECT display_name FROM parties WHERE id = ?")
    .bind(who.partyId).first<any>() : null;
  let outcome; const was: { record?: string; ref?: string } = {};
  if (request.method === "POST") {
    const f = await request.formData();
    const record = String(f.get("record") ?? "").trim();
    const ref = String(f.get("ref") ?? "").trim();
    if (record) { was.record = record.length > 200_000 ? "" : record; outcome = await checkRecord(env, record); }
    else if (ref) { was.ref = ref; outcome = await checkReference(env, ref); }
    else outcome = { ok: false, headline: "Nothing to check.", lines: ["Paste a record.json, or enter a reference or root."] };
  }
  return shell("Verify a record", verifyBody(outcome, was), party?.display_name, "/verify-record");
}

/** Help is readable signed in or not — a person with a dead link needs it most. */
export async function clientHelpPage(env: Env, request: Request): Promise<Response> {
  const who = await whoIs(env, request);
  const party = who ? await env.DB.prepare("SELECT display_name FROM parties WHERE id = ?")
    .bind(who.partyId).first<any>() : null;
  return shell("Help", `<div class="card">${clientHelp()}</div>`, party?.display_name, "/help");
}

export async function clientHome(env: Env, request: Request): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) {
    const sent = new URL(request.url).searchParams.has("sent");
    return shell("Sign in", `<div class="card">
      <h1>Your account</h1>
      <p class="sub">Accounts here are opened by invitation.</p>
      <p>If you have not been invited yet, start
         <a href="${SITE}/enquiry">with an enquiry</a>. If you have, and you are
         on a different computer or your invitation link has been used, ask for
         a link back in.</p>
      ${sent
        ? `<div class="ok">If that address is on a transaction with us, a link
             is on its way. It works once and expires in 24 hours.</div>`
        : `<form method="post" action="/back">
             <label for="em">Your email address</label>
             <input id="em" name="email" type="email" required autocomplete="email"
                    placeholder="you@example.com">
             <button class="go" type="submit">Email me a link</button>
           </form>`}
      <p class="muted">We will not tell you whether an address is on a
         transaction — that would let anybody find out who we work with.</p>
      </div>`);
  }

  const party = await env.DB.prepare(
    "SELECT id, display_name, email FROM parties WHERE id = ?")
    .bind(who.partyId).first<any>();
  if (!party) return signOut(env, request);

  const mine = await principals(env, who.partyId);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.ref, t.name, t.status, t.inbound, t.outbound, t.converts,
            t.currency_out, t.decimals_out, p.role, p.amount_minor, p.party_id,
            y.display_name AS for_name
       FROM participations p JOIN transactions t ON t.id = p.transaction_id JOIN parties y ON y.id = p.party_id
      WHERE p.party_id IN (${mine.map(() => "?").join(",")}) ORDER BY t.updated_at DESC`).bind(...mine).all<any>();

  const deals = (results ?? []).map((t) => `
    <a class="deal" href="/d/${esc(t.id)}">
      <div class="ref">${esc(t.ref)}</div>
      <div class="nm">${esc(t.name)}</div>
      <div class="muted">${t.party_id === who.partyId ? "You are" : `${esc(t.for_name)} is`} the ${esc(t.role)} · ${esc(typeName(t))}
        ${t.amount_minor ? ` · ${esc(t.currency_out)} ${format(t.amount_minor, t.decimals_out)}` : ""}</div>
    </a>`).join("");

  const cleared = await standingCheck(env, party.id);
  const missing = cleared ? [] : await whatIsMissing(env, party);
  const verify = cleared
    ? `<div class="card"><h2>You are verified</h2>
        <p class="muted" style="margin-bottom:0">Checked on
          ${esc((cleared.verified_at ?? "").slice(0, 10))}${cleared.expires_at
            ? `, good until ${esc(cleared.expires_at.slice(0, 10))}` : ""}.
          You will not be asked again unless something changes.</p></div>`
    : party.kyc_submitted_at
      ? `<div class="card"><h2>With us for checking</h2>
          <p class="muted" style="margin-bottom:0">Sent
            ${esc(party.kyc_submitted_at.slice(0, 10))}. Nothing needed from you.</p></div>`
      : `<div class="card"><h2>Verify yourself</h2>
          <p>Before anything can move we need to know who you are.</p>
          ${missing.length ? `<p class="muted">Outstanding: ${esc(missing.join(", "))}.</p>` : ""}
          <p><a href="/verify"><button>Start</button></a></p></div>`;

  const hasSent = (results ?? []).some((t) => t.role === "sender");
  const statementLinks: string[] = [];
  for (const pid of mine) {
    const ys = await yearsFor(env, pid);
    if (!ys.length) continue;
    const label = pid === who.partyId ? "" : ` for ${esc((results ?? []).find((t) => t.party_id === pid)?.for_name ?? "the organisation")}`;
    statementLinks.push(...ys.map((y) => `<a href="/annual/${y}.pdf${pid === who.partyId ? "" : `?for=${esc(pid)}`}" target="_blank"><button type="button" class="plain">${y}${label}</button></a>`));
  }
  const statements = statementLinks.length ? `
    <div class="card">
      <h2>Annual statements</h2>
      <p>Every payment you sent or received through ThePaymaster in a year, with the chain transaction and the sealed
        record each belongs to, totals per asset, and our signature. For your accountant, your bank, or your files.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">${statementLinks.join("")}</div>
    </div>` : "";
  const orgRow = await env.DB.prepare("SELECT kind FROM parties WHERE id = ?").bind(who.partyId).first<any>();
  const team = orgRow?.kind === "company" ? `
    <div class="card">
      <h2>Your team</h2>
      <p>Colleagues can act for ${esc(party.display_name)} with their own logins — an approver who sends, a
        preparer who enters details, a viewer who reads. <a href="/team">Manage the team</a>.</p>
    </div>` : "";
  const loop = cleared ? `
    <div class="card">
      <h2>${hasSent ? "Send another distribution" : "Start a distribution of your own"}</h2>
      <p>You are verified with us, so you can be a sender in one step: name your recipients and their
        amounts, and we take it from there. Your identity clearance carries over; nothing is asked twice.</p>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <form method="post" action="/start-own" style="margin:0"><button class="go">Start a new distribution</button></form>
        ${hasSent ? `<a href="/counterparties"><button type="button" class="plain">Everyone you have paid</button></a>` : ""}
      </div>
    </div>` : "";
  return shell("Your account", `
    <h1>Your transactions</h1>
    <p class="sub">Everything you are part of, and what each one needs from you.</p>
    ${verify}
    <div class="card">${deals || `<p class="muted">Nothing here yet.</p>`}</div>
    ${statements}
    ${team}
    ${loop}`,
    party.display_name);
}

export async function clientVerify(env: Env, request: Request,
                                   later: (p: Promise<unknown>) => void): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);
  let party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?")
    .bind(who.partyId).first<any>();
  if (!party) return signOut(env, request);

  const actor: Actor = { kind: "party", id: party.id,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined };

  let error = "", saved = false, submitted = false;
  if (request.method === "POST") {
    const result = await receiveVerification(env, actor, party, request);
    error = result.error ?? "";
    saved = Boolean(result.saved);
    submitted = Boolean(result.submitted);
    party = await env.DB.prepare("SELECT * FROM parties WHERE id = ?")
      .bind(who.partyId).first<any>();
  }

  if (submitted) {
    return shell("Sent", `<div class="card">
      <h1>Thank you</h1>
      <p class="sub">We have everything we asked for.</p>
      <p>One of us will check it and come back to you. You do not need to do
         anything else for now, and you will not be asked for this again.</p>
      <p><a href="/">Back to your transactions</a></p></div>`, party.display_name);
  }

  const docs = await documentsFor(env, party.id);
  const people = party.kind === "company" ? await peopleOf(env, party.id) : [];
  return shell("Verify", verifyForm(party, docs, people, error, saved),
    party.display_name);
}

/**
 * Where a recipient tells us where their money goes, reads it back, and
 * confirms it.
 *
 * The read-back is a separate, deliberate step rather than a checkbox beside
 * the form. Somebody who has just typed sixteen digits will not spot a
 * transposed pair in the same glance; shown the whole thing again, out of the
 * boxes they typed it into, they often do.
 */
function destinationCard(part: any, dest: any, kind: Kind, error: string,
                         editing = false): string {
  if (dest?.status === "locked") {
    return `<div class="card"><h2>Payment details settled</h2>
      <pre style="white-space:pre-wrap;font:inherit;margin:0 0 10px">${esc(describe(dest))}</pre>
      <p class="muted" style="margin-bottom:0">These are locked. If anything is wrong,
         telephone us on +44 20 7088 8267 — we will never change them on the strength
         of an email, and neither should anyone else.</p></div>`;
  }

  // A correction jumps past the states below to the form, pre-filled. Without
  // this, "something is wrong" only ever redrew the screen that was wrong.
  if (editing && dest && dest.status !== "locked") {
    // fall through to the form at the end
  } else if (dest && dest.status === "confirmed") {
    return `<div class="card"><h2>Thank you</h2>
      <pre style="white-space:pre-wrap;font:inherit;margin:0 0 10px">${esc(describe(dest))}</pre>
      <p class="muted">Confirmed. We will check it over and lock it.</p>
      <form method="post"><button name="action" value="edit" class="plain"
        formaction="?edit=1">Change these</button></form></div>`;
  } else if (dest && dest.status === "draft") {
    return `<div class="card"><h2>Read this back</h2>
      <p>This is where the money will go. Read every character — once it is locked
         it takes two of us and a call to change it.</p>
      <pre style="white-space:pre-wrap;font:inherit;background:var(--panel);
        border:1px solid var(--rule);border-radius:9px;padding:14px;margin:0 0 14px"
        >${esc(describe(dest))}</pre>
      <form method="post">
        <button name="action" value="confirm">That is correct</button>
        <button name="action" value="edit" class="plain" style="margin-left:8px"
          formaction="?edit=1">Something is wrong — change it</button>
      </form></div>`;
  }

  // Pre-filled when correcting something already entered: being made to type
  // a whole account back in because one character was wrong is how the second
  // attempt acquires its own mistake.
  const was = (k: string) => esc(String((dest as any)?.[k] ?? ""));
  const bank = `
    <label for="an">Name on the account</label>
    <input id="an" name="account_name" required value="${was("account_name")}">
    <label for="bn">Bank</label><input id="bn" name="bank_name" required value="${was("bank_name")}">
    <label for="bc">Country the account is held in</label>
    <input id="bc" name="bank_country" required value="${was("bank_country")}">
    <label for="ib">IBAN</label><input id="ib" name="iban" value="${was("iban")}">
    <p class="muted">Or, for a UK account without an IBAN:</p>
    <div class="pair">
      <div><label for="ac">Account number</label>
        <input id="ac" name="account_number" value="${was("account_number")}"></div>
      <div><label for="sc">Sort code</label>
        <input id="sc" name="sort_code" value="${was("sort_code")}"></div>
    </div>
    <label for="bi">BIC or SWIFT, if you have it</label>
    <input id="bi" name="bic" value="${was("bic")}">`;

  const wallet = `
    <label for="ch">Chain</label>
    <input id="ch" name="chain" placeholder="Ethereum" required value="${was("chain")}">
    <label for="ad">Wallet address</label>
    <input id="ad" name="address" required spellcheck="false" value="${was("address")}">
    <p class="muted">Copy and paste it. Do not type it out.</p>`;

  return `<div class="card">
    <h2>${dest ? "Change where your money goes" : "Where should your money go?"}</h2>
    <p>${part.outbound === "fiat"
      ? "The account you want to be paid into."
      : "The wallet you want to be paid to."}</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <!-- action="?" drops the edit flag, so a successful save lands on the
         read-back rather than redrawing the form it just came from. -->
    <form method="post" action="?">
      ${kind === "bank" ? bank : wallet}
      <div style="margin-top:18px"><button name="action" value="save">Continue</button></div>
      <p class="muted">Only you can enter this. We will never accept payment details
         for you from anybody else, including the sender.</p>
    </form></div>`;
}

/**
 * The sender's side of a crypto transaction: which wallets the funds will
 * leave from, each proved by signature.
 *
 * More than one is allowed because large holdings are rarely in one place, and
 * knowing all of them in advance is what lets the arriving funds be matched to
 * a party rather than guessed at afterwards.
 */
async function senderWallets(env: Env, part: any, wallets: any[], error: string,
                             errorWallet = "", rail: Rail): Promise<string> {
  const list = (await Promise.all(wallets.map(async (w) => `
    <div class="wallet${w.proved_at ? " proved" : ""}">
      <code>${esc(w.address)}</code>
      <div class="muted">${esc(w.chain)}${w.label ? ` · ${esc(w.label)}` : ""}</div>
      <form method="post" class="rm">
        <input type="hidden" name="action" value="remove_wallet">
        <input type="hidden" name="wallet" value="${esc(w.id)}">
        <button class="plain small" type="submit">Remove this wallet</button>
      </form>
      ${w.proved_at
        ? `<div class="muted">Proved ${esc(w.proved_at.slice(0, 16))}</div>`
        : proofForm({
            action: "", message: await challengeForSendingWallet(env, w, part.ref),
            address: w.address, rail, hidden: { action: "prove_wallet", wallet: w.id },
            error: w.id === errorWallet ? error : undefined,
          })}
    </div>`))).join("");

  return `<div class="card">
    <h2>Where will you be sending from?</h2>
    <p>Tell us every wallet the funds will leave from, and prove you hold each one.
       You can add more than one.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    ${list}
    <form method="post">
      <input type="hidden" name="action" value="add_wallet">
      <label for="wa">Wallet address</label>
      <input id="wa" name="address" required spellcheck="false" placeholder="0x…">
      <div class="pair">
        <div><label for="wc">Chain</label>
          <input id="wc" name="chain" value="${esc(part.chain ?? "")}" placeholder="Ethereum"></div>
        <div><label for="wl">A name for it, if you like</label>
          <input id="wl" name="label" placeholder="Treasury"></div>
      </div>
      <div style="margin-top:14px"><button>Add this wallet</button></div>
    </form>
  </div>`;
}

export async function clientDeal(env: Env, request: Request, txId: string): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);

  // A party sees a transaction only if they are on it. Checked here rather
  // than assumed from the link they followed.
  const mine = await principals(env, who.partyId);
  const part = await env.DB.prepare(
    `SELECT p.party_id AS principal_party_id, p.id AS participation_id, p.role, p.amount_minor, t.*
       FROM participations p JOIN transactions t ON t.id = p.transaction_id
      WHERE p.transaction_id = ? AND p.party_id IN (${mine.map(() => "?").join(",")})
      ORDER BY CASE WHEN p.party_id = ? THEN 0 ELSE 1 END LIMIT 1`)
    .bind(txId, ...mine, who.partyId).first<any>();
  if (!part) return new Response("Not found", { status: 404 });
  const principalId = String(part.principal_party_id);
  const memberRole: Role = (await roleFor(env, who.partyId, principalId)) ?? "viewer";
  const actingFor = principalId === who.partyId ? null
    : await env.DB.prepare("SELECT id, display_name, kind FROM parties WHERE id = ?").bind(principalId).first<any>();

  const actor: Actor = { kind: "party", id: who.partyId,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  let error = "";
  // Which wallet a failure belongs to. With several sending wallets on the
  // page, an error shown against all of them is as unhelpful as one shown
  // against none — and none is what happened.
  let errorWallet = "";
  const isRoomPost = request.method === "POST" && new URL(request.url).pathname.endsWith("/room");
  const canPrepare = atLeast(memberRole, "preparer");
  if (request.method === "POST" && !canPrepare) {
    error = "Your role on this account is viewer: you can read everything here but not change it.";
  }
  if (request.method === "POST" && !isRoomPost && canPrepare && part.role === "sender") {
    const f = await request.formData();
    const action = String(f.get("action") ?? "");
    if (action === "add_wallet") {
      error = await addSendingWallet(env, actor, {
        transactionId: txId, partyId: principalId,
        chain: String(f.get("chain") ?? part.chain ?? "ethereum"),
        address: String(f.get("address") ?? ""),
        label: String(f.get("label") ?? ""),
      }) ?? "";
    } else if (action === "remove_wallet") {
      error = await removeSendingWallet(env, actor,
        String(f.get("wallet") ?? "")) ?? "";
    } else if (action === "prove_wallet") {
      errorWallet = String(f.get("wallet") ?? "");
      error = await proveSendingWallet(env, actor, String(f.get("wallet") ?? ""),
        part.ref, String(f.get("signature") ?? "")) ?? "";
    }
  }

  if (request.method === "POST" && !isRoomPost && canPrepare && part.role === "recipient") {
    const f = await request.formData();
    const action = String(f.get("action") ?? "");
    const kindNow: Kind = part.outbound === "fiat" ? "bank" : "wallet";
    if (action === "save") {
      error = await saveDestination(env, actor, part.participation_id, kindNow, {
        account_name: String(f.get("account_name") ?? ""),
        account_number: String(f.get("account_number") ?? ""),
        sort_code: String(f.get("sort_code") ?? ""),
        iban: String(f.get("iban") ?? ""),
        bic: String(f.get("bic") ?? ""),
        bank_name: String(f.get("bank_name") ?? ""),
        bank_country: String(f.get("bank_country") ?? ""),
        chain: String(f.get("chain") ?? ""),
        address: String(f.get("address") ?? ""),
      }) ?? "";
    } else if (action === "confirm") {
      const d = await forParticipation(env, part.participation_id);
      if (d) await confirmDestination(env, actor, d.id, "read back in their own account");
      if (d) await staffAddressConfirmed(env, actor, d.id);
    } else if (action === "prove") {
      const d = await forParticipation(env, part.participation_id);
      if (d) {
        error = await proveDestination(env, actor, d.id, part.ref,
          String(f.get("signature") ?? "")) ?? "";
      }
    } else if (action === "cant_sign") {
      const d = await forParticipation(env, part.participation_id);
      if (d) error = await cannotSign(env, actor, d.id, String(f.get("note") ?? "")) ?? "";
    } else if (action === "edit") {
      const d = await forParticipation(env, part.participation_id);
      if (d && d.status !== "locked") {
        await env.DB.prepare(
          "UPDATE destinations SET status='draft', confirmed_at=NULL WHERE id=?")
          .bind(d.id).run();
      }
    }
  }

  const party = await env.DB.prepare(
    "SELECT display_name, kyc_submitted_at FROM parties WHERE id = ?")
    .bind(principalId).first<any>();

  const kind: Kind = part.outbound === "fiat" ? "bank" : "wallet";
  const dest = part.role === "recipient"
    ? await forParticipation(env, part.participation_id) : null;
  const cleared = await standingCheck(env, principalId);
  const sending = part.role === "sender" && part.inbound === "crypto"
    ? await sendingWallets(env, txId) : [];
  const rail = await railForTransaction(env, txId);
  const destProof = dest ? await provedAddress(env, dest as any) : null;
  const proofMessage = (kind === "wallet" && dest?.address && !destProof?.ok)
    ? await challengeForDestination(env, actor, dest, part.ref) : "";

  // Any authority we have asked this sender for, signed or not.
  const askedFor = part.role === "sender"
    ? (await mandateHistory(env, txId)).find((m) => !m.revoked_at)
    : undefined;
  const mandateError = new URL(request.url).searchParams.get("mandate_error") ?? "";
  const editing = new URL(request.url).searchParams.has("edit");

  // Where they are. Decided from the record, never from what was last shown.
  const out = await outcome(env, txId);
  const progress = part.role === "sender" ? await recipientProgress(env, txId) : [];
  const steps = part.role === "recipient"
    ? recipientJourney({
        cleared, submittedAt: party?.kyc_submitted_at ?? null, kind,
        dest: dest ? { ...dest, attested: destProof?.attestation ?? null } : null,
        paidHash: out.paidFor(part.participation_id), sealed: out.sealed })
    : senderJourney({
        cleared, submittedAt: party?.kyc_submitted_at ?? null, wallets: sending,
        recipients: progress, status: part.status, allPaid: out.allPaid,
        sealed: out.sealed, onChain: part.inbound === "crypto" });

  // The one card that is open: whatever the current step needs. Everything
  // else is a line, so a finished thing reads as finished and a waiting thing
  // says who it is waiting on.
  const open = async (key: string): Promise<string> => {
    switch (key) {
      case "verify":
        return `<div class="card now"><h2>Verify yourself</h2>
          <p>Before anything can move we need to know who you are: your details,
             a passport and a proof of address, uploaded here.</p>
          <p><a href="/verify"><button>Start</button></a></p></div>`;
      case "details":
        return destinationCard(part, dest, kind, error, editing);
      case "prove":
        return `<div class="card now"><h2>Prove it is yours</h2>${proofForm({
          action: "", message: proofMessage, address: dest.address, rail,
          hidden: { action: "prove" }, error })}
          <details class="cantsign" style="margin-top:18px;border-top:1px solid #E6EAF0;padding-top:12px">
            <summary style="cursor:pointer;font-weight:700">I cannot sign from this address</summary>
            <p class="muted" style="margin:10px 0 6px">If this is a deposit address at an exchange
              (Binance, Kraken, Coinbase…) the exchange holds the key and you cannot sign with it.
              The simplest route is to give us a wallet you control and move the money on afterwards.
              If that is not possible, tell us here: we can accept an exchange address on evidence
              that it is yours — a screenshot of the deposit page showing your name and the address —
              and the record will say it was accepted that way.</p>
            <form method="post" action="?">
              <input type="hidden" name="action" value="cant_sign">
              <label for="cs">Tell us about it</label>
              <textarea id="cs" name="note" rows="2" maxlength="500"
                placeholder="It is my Kraken deposit address. I can send a screenshot of the deposit page."></textarea>
              <div class="row"><button class="plain">Send this to ThePaymaster</button></div>
            </form>
          </details></div>`;
      case "wallets":
        return await senderWallets(env, part, sending, error, errorWallet, rail);
      case "send":
        return `<div class="card now"><h2>Ready to send</h2>
          <p>Everyone is verified, every address is proved, screened and locked,
             and the amounts add up. You will see every recipient, their full
             address and their amount on one screen before anything moves.</p>
          <p><a href="/d/${esc(txId)}/send"><button>Review and send</button></a></p></div>`;
      default:
        return "";
    }
  };

  const body: string[] = [];
  for (const step of steps) {
    if (step.state === "now") body.push(await open(step.key));
    else if (editing && step.key === "details") body.push(destinationCard(part, dest, kind, error, true));
    else body.push(line(step));
    // The sender's recipients are worth a table whatever state they are in:
    // "2 of 3 ready" is the headline, who the third is is the question.
    if (step.key === "recipients" && progress.length) {
      body.push(`<div class="card"><h2>Your recipients</h2>
        ${progressTable(progress, part.inbound === "crypto")}
        <p class="muted" style="margin:12px 0 0">Each of them has their own account
          and is doing their own part. You cannot do it for them, and neither can we.</p>
      </div>`);
    }
  }

  // A data-room invitation made from this page: create it, or revoke one.
  let roomLink: string | undefined, roomError: string | undefined;
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/room") && cleared && !atLeast(memberRole, "approver")) {
    roomError = "Only an approver or owner can share the dossier with a third party.";
  } else if (request.method === "POST" && new URL(request.url).pathname.endsWith("/room") && cleared) {
    const f = await request.formData();
    if (f.get("revoke")) {
      roomError = (await roomRevoke(env, actor, String(f.get("revoke")), principalId)) ?? undefined;
    } else {
      const made = await roomInvite(env, actor, {
        transactionId: txId, partyId: principalId, viewerName: String(f.get("viewer_name") ?? ""),
        viewerEmail: String(f.get("viewer_email") ?? ""), days: Number(f.get("days") ?? 30),
        includeDocuments: f.get("include_documents") === "1",
      });
      if ("problem" in made) roomError = made.problem; else roomLink = made.url;
    }
  }

  // A finished distribution can be run again by its sender: same recipients,
  // shares, addresses and proofs; only the amount and the fresh checks remain.
  if (part.role === "sender" && ["settled", "closed"].includes(part.status)) {
    body.push(`<div class="card">
      <h2>Run this distribution again</h2>
      <p>Same recipients and shares, their addresses and proofs carried over, chain settings kept.
        We set the new amount with you, screen the addresses again, and release it — usually the same day.
        Nothing is asked of your recipients that they have already given.</p>
      <form method="post" action="/d/${esc(txId)}/again"><button class="go">Set up the same distribution again</button></form>
    </div>`);
  }

  // The folder is theirs from the moment they are verified: the statement
  // says "provisional" until the money has moved and the record is sealed,
  // and is reissued as final by the same link.
  if (cleared) {
    const fd = await folderData(env, txId, principalId, "party");
    const st = fd ? statementStatus(fd) : { final: false, why: "" };
    body.push(`<div class="card folder">
      <h2>Your Peaceful Enjoyment dossier</h2>
      <p>Everything you may need later to show where ${part.role === "recipient" ? "these funds came from" : "these funds went"}:
        our <b>Counterparty Certification</b>, <b>your own record</b> with the proofs that tie it to the
        sealed whole, and ${fd?.documents.length ? `the ${fd.documents.length} document${fd.documents.length === 1 ? "" : "s"} on your file` : "your documents"}.
        Keep it with your records; banks and accountants ask for exactly this.</p>
      <p class="${st.final ? "good" : "muted"}" style="margin:6px 0 10px">${st.final
        ? "Final — the transaction is complete and the record is sealed."
        : `Provisional for now — ${esc(st.why)}. The same links give you the final version when it is.`}</p>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <a href="/d/${esc(txId)}/folder.zip"><button type="button" class="go">Download my dossier</button></a>
        <a href="/d/${esc(txId)}/certification.pdf" target="_blank"><button type="button" class="plain">Open the certification</button></a>
        <a href="/d/${esc(txId)}/record.pdf" target="_blank"><button type="button" class="plain">Open my record</button></a>
      </div>
      ${await (async () => {
        const mine = (await badgesFor(env, txId)).filter((b) => b.party_id === principalId);
        return mine.length ? `<p style="margin:10px 0 0"><b>Your certificate is on chain.</b> A soulbound token in your wallet
          <span class="mono" style="font-size:12px">${esc(mine[0].to_address)}</span> carries the sealed record's root —
          <a href="${esc(explorerToken(mine[0].chain_id, mine[0].contract, mine[0].token_id))}" target="_blank" rel="noopener">see it on the explorer</a>.</p>` : "";
      })()}
      <p class="muted" style="margin:10px 0 0;font-size:13px">Anyone you give it to can check it without asking us:
        <a href="/verify-record">${VERIFY_URL.replace("https://", "")}</a> recomputes every entry against the sealed record.</p>
    </div>
    <div class="card">
      <h2>Share it with your bank</h2>
      <p>Rather than emailing PDFs, give your bank or accountant a private link to a <b>data room</b>: they see your
        certification and record (and your documents, if you choose), watermarked with their name, for a set time.
        You are told the first time it is opened, and you can revoke it whenever you like.</p>
      ${invitePanel(await invitesFor(env, txId, principalId), `/d/${esc(txId)}/room`, { justMade: roomLink, error: roomError })}
    </div>`);
  }

  const stageOk = ["ready", "settled", "closed"].includes(part.status);
  return shell(part.ref, `
    <h1>${esc(part.ref)}</h1>
    ${actingFor ? `<p class="muted" style="margin:-8px 0 10px">You are acting for <b>${esc(actingFor.display_name)}</b> as ${esc(memberRole)}.</p>` : ""}
    ${error && !canPrepare ? `<div class="err">${esc(error)}</div>` : ""}
    <p class="sub">${esc(part.name)} &middot;
      <span class="stage${stageOk ? " ok" : ""}">${esc(STAGE[part.status] ?? part.status)}</span>
      &middot; You are the ${esc(part.role)}${part.amount_minor
        ? ` &middot; ${esc(part.currency_out)} ${format(part.amount_minor, part.decimals_out)}` : ""}</p>
    ${strip(steps)}
    ${askedFor ? mandateBlock(askedFor, txId, mandateError) : ""}
    ${body.join("")}
    <p class="muted" style="margin-top:22px"><a href="/d/${esc(txId)}/record">Your record</a>
      — what is on file about your part, and proof it has not been altered.</p>`,
    party?.display_name);
}

/**
 * A recipient's own record, and the arithmetic that ties it to the whole.
 *
 * A party sees what they did and nothing else — not the other recipients, not
 * their addresses, not their amounts. What they can still do is prove their own
 * entry belongs to the sealed record, by folding a short list of hashes into
 * their own. That is enough for their bank or accountant, and discloses
 * nothing about anybody else.
 */
export async function clientRecord(env: Env, request: Request,
                                   txId: string): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);

  const mine = await principals(env, who.partyId);
  const part = await env.DB.prepare(
    `SELECT p.party_id AS principal_party_id, t.ref, t.name FROM participations p
       JOIN transactions t ON t.id = p.transaction_id
      WHERE p.transaction_id = ? AND p.party_id IN (${mine.map(() => "?").join(",")})
      ORDER BY CASE WHEN p.party_id = ? THEN 0 ELSE 1 END LIMIT 1`)
    .bind(txId, ...mine, who.partyId).first<any>();
  if (!part) return new Response("Not found", { status: 404 });
  const principalId = String(part.principal_party_id);
  const memberRole: Role = (await roleFor(env, who.partyId, principalId)) ?? "viewer";
  const actingFor = principalId === who.partyId ? null
    : await env.DB.prepare("SELECT id, display_name, kind FROM parties WHERE id = ?").bind(principalId).first<any>();

  const record = await ownRecord(env, txId, principalId);

  const entries = record.facts.map((f, n) => `<section class="fact">
    <h3>${n + 1}. ${esc(f.title)}</h3>
    <table class="kv">${Object.entries(f.data)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `<tr><th>${esc(k.replace(/_/g, " "))}</th>
        <td>${esc(String(v))}</td></tr>`).join("")}</table>
    <p class="leaf mono">leaf ${esc(f.leaf)}</p>
    <details><summary>Proof that this entry is in the sealed record</summary>
      <ol class="path">${f.path.map((step) =>
        `<li><span class="muted">${step.side}</span>
           <span class="mono">${esc(step.hash)}</span></li>`).join("")}</ol>
      <p class="muted">Fold each hash into your own, in order: where it says
        left, put it before yours; where it says right, put it after. Take the
        SHA-256 of the two 32-byte values joined together, and repeat. You will
        arrive at the record root below.</p>
    </details>
  </section>`).join("");

  return shell(`Your record — ${part.ref}`, `
    <h1>Your record</h1>
    <p class="muted">${esc(part.ref)}${part.name ? " — " + esc(part.name) : ""}</p>
    <div class="panel">
      <table class="kv">
        <tr><th>Record root</th><td><span class="mono big">${esc(record.root)}</span></td></tr>
        <tr><th>Sealed</th><td>${record.sealedAt
          ? esc(record.sealedAt)
          : "Not yet sealed — this transaction is still in progress."}</td></tr>
        <tr><th>Your entries</th><td>${record.facts.length}</td></tr>
        <tr><th>Other parties' entries</th><td>${record.others}
          <span class="muted">— counted, never shown</span></td></tr>
      </table>
    </div>
    ${entries}`, who.name);
}

/**
 * The sender's execution screen. Sender only — a recipient has no business
 * seeing the other legs, and says so by getting a 404 rather than a lecture.
 */
export async function clientSend(env: Env, request: Request,
                                 txId: string): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);

  const mine = await principals(env, who.partyId);
  const part = await env.DB.prepare(
    `SELECT p.party_id AS principal_party_id, p.role, t.ref FROM participations p
       JOIN transactions t ON t.id = p.transaction_id
      WHERE p.transaction_id = ? AND p.party_id IN (${mine.map(() => "?").join(",")})
      ORDER BY CASE WHEN p.party_id = ? THEN 0 ELSE 1 END LIMIT 1`)
    .bind(txId, ...mine, who.partyId).first<any>();
  if (!part || part.role !== "sender") return new Response("Not found", { status: 404 });
  const principalId = String(part.principal_party_id);
  const memberRole: Role = (await roleFor(env, who.partyId, principalId)) ?? "viewer";
  const actingFor = principalId === who.partyId ? null
    : await env.DB.prepare("SELECT id, display_name, kind FROM parties WHERE id = ?").bind(principalId).first<any>();

  if (actingFor) {
    const okRole = atLeast(memberRole, "approver");
    const meCleared = okRole ? await standingCheck(env, who.partyId) /* self */ : null;
    if (!okRole || !meCleared) {
      const why = !okRole
        ? `Sending is an approver's act. Your role for ${esc(actingFor.display_name)} is ${esc(memberRole)}; ask an approver or the account owner to send.`
        : "An approver has to be verified in person before sending. Verify yourself under Your details, and this page opens.";
      if (new URL(request.url).pathname.endsWith("/prepare")) {
        return new Response(JSON.stringify({ problem: why.replace(/<[^>]+>/g, "") }), { status: 403, headers: { "content-type": "application/json" } });
      }
      return shell(`Send — ${part.ref}`, `<div class="card"><h1>Not yours to send</h1><p>${why}</p>
        <p><a href="/d/${esc(txId)}">Back to the transaction</a></p></div>`, who.name);
    }
  }
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/prepare")) {
    const f = await request.formData();
    return prepare(env, txId, String(f.get("leg") ?? ""), String(f.get("kind") ?? ""));
  }

  const actor: Actor = { kind: "party", id: who.partyId,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined };

  let notice = "";
  if (request.method === "POST") {
    const f = await request.formData();
    const leg = String(f.get("leg") ?? "");
    const hash = String(f.get("tx_hash") ?? "");
    notice = String(f.get("kind") ?? "") === "test"
      ? await recordTest(env, actor, txId, leg, hash)
      : await recordLeg(env, actor, txId, leg, hash);
  }

  const p = await plan(env, txId);
  return shell(`Send — ${part.ref}`, executeBody(p, txId, notice), who.name);
}

/** The party's statement, record or whole folder — theirs to download, any time. */
export async function clientFolder(env: Env, request: Request, txId: string,
                                   what: "statement" | "record" | "folder"): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);
  // The party the dossier is about: the person, or an organisation they act for.
  const mine = await principals(env, who.partyId);
  const onTx = await env.DB.prepare(
    `SELECT party_id FROM participations WHERE transaction_id = ? AND party_id IN (${mine.map(() => "?").join(",")})
      ORDER BY CASE WHEN party_id = ? THEN 0 ELSE 1 END LIMIT 1`).bind(txId, ...mine, who.partyId).first<any>();
  if (!onTx) return new Response("Not found", { status: 404 });
  const principalId = String(onTx.party_id);
  const d = await folderData(env, txId, principalId, "party");
  if (!d) return new Response("Not found", { status: 404 });
  const name = (d.party.legal_name || d.party.display_name).replace(/[^A-Za-z0-9._ -]+/g, "_").trim().replace(/\s+/g, "_");
  const file = (bytes: Uint8Array, type: string, filename: string, inline: boolean) =>
    new Response(bytes, { headers: { "content-type": type, "cache-control": "no-store",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"` } });
  if (what === "statement") return file(statementPdf(d), "application/pdf", `${d.tx.ref}-certification-${name}.pdf`, true);
  if (what === "record") return file((await ownRecordPdf(env, d)).pdf, "application/pdf", `${d.tx.ref}-record-${name}.pdf`, true);
  const folder = await partyFolder(env, txId, principalId, "party");
  if (!folder) return new Response("Not found", { status: 404 });
  await log(env.DB, { kind: "party", id: who.partyId, ip: request.headers.get("CF-Connecting-IP") ?? undefined },
            "folder.downloaded", "participations", d.participation.id, { note: folder.final ? "final" : "provisional" });
  return file(folder.bytes, "application/zip", folder.name, false);
}

/**
 * A client asking to be let back in.
 *
 * The reply is identical whether or not the address is known to us. Saying
 * "no such client" would turn this box into a way of asking whether a given
 * person is one of our clients, which is not something a stranger should be
 * able to find out.
 *
 * A link is only ever sent to the address already on the party record, so the
 * worst an attacker achieves by guessing is to send that person an email.
 */
export async function requestReturn(env: Env, request: Request): Promise<Response> {
  const f = await request.formData();
  const email = String(f.get("email") ?? "").trim().toLowerCase();
  const ip = request.headers.get("CF-Connecting-IP") ?? undefined;
  const actor: Actor = { kind: "system", id: null, ip };
  const url = new URL(request.url);

  // Only a party who is actually on a transaction, and only to their own
  // address as we already hold it.
  const party = email
    ? await env.DB.prepare(
        `SELECT p.id, p.email, p.display_name FROM parties p
          WHERE lower(p.email) = ?
            AND EXISTS (SELECT 1 FROM participations x WHERE x.party_id = p.id)
          LIMIT 1`).bind(email).first<any>()
    : null;

  if (party) {
    const minted = await mint(env, actor, {
      purpose: "return", email: party.email,
      base: `${url.protocol}//${url.host}`, partyId: party.id,
    });
    await send(env, actor, {
      ...returnLink(minted.url), to: party.email,
      about: { kind: "parties", id: party.id },
    });
  } else {
    // Recorded so a burst of guesses is visible in the log, without saying
    // here whether any of them landed.
    await log(env.DB, actor, "client.return_unknown", "parties", email || "(blank)",
      { note: "no party on a transaction with that address" });
  }

  return Response.redirect(new URL("/?sent=1", request.url).toString(), 303);
}

/** Following a return link: sign the party back in. */
export async function followReturn(env: Env, value: string,
                                   request: Request): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? undefined;
  const tok = await peek(env, value);
  if (!tok || tok.purpose !== "return" || !tok.partyId) {
    return shell("That link has gone", `<div class="card">
      <h1>That link no longer works</h1>
      <p>Return links work once and last a day. Ask for another below.</p>
      <p><a href="/">Back to sign in</a></p></div>`);
  }
  // redeem marks the link spent and opens the session in one batch, so a
  // link cannot be used twice even if two tabs follow it at once.
  const session = await redeem(env, value, tok.partyId, request);
  if (!session) {
    return shell("That link has gone", `<div class="card">
      <h1>That link no longer works</h1>
      <p>It may already have been used. Ask for another below.</p>
      <p><a href="/">Back to sign in</a></p></div>`);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: "/", "Set-Cookie": sessionCookie(session) },
  });
}

/**
 * The authority, put in front of the sender to read and sign.
 *
 * Shown in full, as plain text in a fixed-width block, because a wall of
 * prose in a modal is how people come to sign things they have not read. The
 * button is not enabled by a checkbox — they type their own name, which is a
 * deliberate act rather than a reflex.
 */
export function mandateBlock(m: any, txId: string, error = ""): string {
  if (m.signed_at) {
    return `<div class="card">
      <h2>You asked us to prepare this for you</h2>
      <p class="muted">Signed by ${esc(m.signed_name)} on ${esc(m.signed_at)}.
        You can withdraw this at any time; it does not affect anything already
        agreed, and we stop at once.</p>
      <details><summary>Read what you signed</summary>
        <pre class="wording">${esc(m.wording)}</pre></details>
      <form method="post" action="/d/${esc(txId)}/mandate">
        <input type="hidden" name="action" value="withdraw">
        <input type="hidden" name="mandate" value="${esc(m.id)}">
        <button class="plain" type="submit">Withdraw this authority</button>
      </form>
    </div>`;
  }

  return `<div class="card ask">
    <h2>ThePaymaster has asked to prepare this transaction for you</h2>
    <p>You do not have to agree. If you would rather enter the recipients and
      amounts yourself, ignore this and carry on below — nothing is blocked
      either way.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <pre class="wording">${esc(m.wording)}</pre>
    <form method="post" action="/d/${esc(txId)}/mandate">
      <input type="hidden" name="action" value="sign">
      <input type="hidden" name="mandate" value="${esc(m.id)}">
      <label for="typed">Type your full name to sign</label>
      <input id="typed" name="typed_name" autocomplete="name" required
             placeholder="Your full name">
      <button class="go" type="submit">I agree, and this is my signature</button>
    </form>
    <p class="muted">Your name, the date, and the words above are recorded
      together in the transaction's dossier.</p>
  </div>`;
}

/** The sender signing or withdrawing it. */
export async function clientMandate(env: Env, request: Request,
                                    txId: string): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);

  const part = await env.DB.prepare(
    `SELECT role FROM participations WHERE transaction_id = ? AND party_id = ?`)
    .bind(txId, who.partyId).first<any>();
  if (!part || part.role !== "sender") return new Response("Not found", { status: 404 });

  const f = await request.formData();
  const actor: Actor = { kind: "party", id: who.partyId,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  const mandateId = String(f.get("mandate") ?? "");

  let problem: string | null = null;
  if (String(f.get("action") ?? "") === "withdraw") {
    problem = await revokeMandate(env, actor, mandateId, "Withdrawn by the sender");
  } else {
    problem = await signMandate(env, actor, mandateId, {
      typedName: String(f.get("typed_name") ?? ""),
      ip: request.headers.get("CF-Connecting-IP") ?? undefined,
      agent: request.headers.get("User-Agent") ?? undefined,
    });
  }
  const to = new URL(`/d/${txId}`, request.url);
  if (problem) to.searchParams.set("mandate_error", problem);
  return Response.redirect(to.toString(), 303);
}
