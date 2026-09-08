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
import { esc, REVEAL_CSS, REVEAL_JS } from "./views.ts";
import { format } from "./money.ts";
import { verifyForm, receiveVerification, whatIsMissing, kycStyles,
         peopleOf, standingCheck } from "./kyc.ts";
import { documentsFor } from "./documents.ts";
import { forParticipation, save as saveDestination, confirm as confirmDestination,
         problemWith, describe, type Kind } from "./destinations.ts";

const MAX_RECIPIENTS = 10;

const CSS = `
:root{--ink:#0C1524;--accent:#FF8159;--panel:#F5F7FA;--text:#4A5567;--rule:#DBDFEA;--good:#1B8A5A}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:17px/1.6 "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--panel)}
a{color:var(--ink)}
header{background:var(--ink);color:#fff;padding:16px 22px;display:flex;align-items:center;gap:18px}
header b{font-weight:800;letter-spacing:-.01em}
header .who{margin-left:auto;color:#B6C0D0;font-size:14px}
header a{color:#B6C0D0;text-decoration:none;font-size:14px;font-weight:600}
main{max-width:720px;margin:0 auto;padding:32px 20px 72px}
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

function shell(title: string, body: string, who?: string): Response {
  const bar = who
    ? `<header><b>ThePaymaster</b><span class="who">${esc(who)}</span>
       <a href="/signout">Sign out</a></header>`
    : `<header><b>ThePaymaster</b></header>`;
  return new Response(`<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ThePaymaster</title><meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="https://thepaymaster.co.uk/wp-content/uploads/elementor/google-fonts/css/plusjakartasans.css">
<style>${CSS}${REVEAL_CSS}${kycStyles()}</style></head><body>${bar}<main>${body}</main>${REVEAL_JS}</body></html>`,
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

export async function clientHome(env: Env, request: Request): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) {
    return shell("Sign in", `<div class="card">
      <h1>Your account</h1>
      <p class="sub">Accounts here are opened by invitation.</p>
      <p>If you are expecting to be part of a transaction, use the link in the email
         we sent you. If that link has expired, ask us for another —
         <a href="mailto:info@thepaymaster.co.uk">info@thepaymaster.co.uk</a>.</p></div>`);
  }

  const party = await env.DB.prepare(
    "SELECT id, display_name, email FROM parties WHERE id = ?")
    .bind(who.partyId).first<any>();
  if (!party) return signOut(env, request);

  const { results } = await env.DB.prepare(
    `SELECT t.id, t.ref, t.name, t.status, t.inbound, t.outbound, t.converts,
            t.currency_out, t.decimals_out, p.role, p.amount_minor
       FROM participations p JOIN transactions t ON t.id = p.transaction_id
      WHERE p.party_id = ? ORDER BY t.updated_at DESC`).bind(who.partyId).all<any>();

  const deals = (results ?? []).map((t) => `
    <a class="deal" href="/d/${esc(t.id)}">
      <div class="ref">${esc(t.ref)}</div>
      <div class="nm">${esc(t.name)}</div>
      <div class="muted">You are the ${esc(t.role)} · ${esc(typeName(t))}
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

  return shell("Your account", `
    <h1>Your transactions</h1>
    <p class="sub">Everything you are part of, and what each one needs from you.</p>
    ${verify}
    <div class="card">${deals || `<p class="muted">Nothing here yet.</p>`}</div>`,
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
function destinationCard(part: any, dest: any, kind: Kind, error: string): string {
  if (dest?.status === "locked") {
    return `<div class="card"><h2>Payment details settled</h2>
      <pre style="white-space:pre-wrap;font:inherit;margin:0 0 10px">${esc(describe(dest))}</pre>
      <p class="muted" style="margin-bottom:0">These are locked. If anything is wrong,
         telephone us on +44 20 7088 8267 — we will never change them on the strength
         of an email, and neither should anyone else.</p></div>`;
  }

  if (dest && dest.status === "confirmed") {
    return `<div class="card"><h2>Thank you</h2>
      <pre style="white-space:pre-wrap;font:inherit;margin:0 0 10px">${esc(describe(dest))}</pre>
      <p class="muted">Confirmed. We will check it over and lock it.</p>
      <form method="post"><button name="action" value="edit" class="plain">
        Change these</button></form></div>`;
  }

  if (dest && dest.status === "draft") {
    return `<div class="card"><h2>Read this back</h2>
      <p>This is where the money will go. Read every character — once it is locked
         it takes two of us and a call to change it.</p>
      <pre style="white-space:pre-wrap;font:inherit;background:var(--panel);
        border:1px solid var(--rule);border-radius:9px;padding:14px;margin:0 0 14px"
        >${esc(describe(dest))}</pre>
      <form method="post">
        <button name="action" value="confirm">That is correct</button>
        <button name="action" value="edit" class="plain" style="margin-left:8px">
          Something is wrong</button>
      </form></div>`;
  }

  const bank = `
    <label for="an">Name on the account</label>
    <input id="an" name="account_name" required>
    <label for="bn">Bank</label><input id="bn" name="bank_name" required>
    <label for="bc">Country the account is held in</label>
    <input id="bc" name="bank_country" required>
    <label for="ib">IBAN</label><input id="ib" name="iban">
    <p class="muted">Or, for a UK account without an IBAN:</p>
    <div class="pair">
      <div><label for="ac">Account number</label><input id="ac" name="account_number"></div>
      <div><label for="sc">Sort code</label><input id="sc" name="sort_code"></div>
    </div>
    <label for="bi">BIC or SWIFT, if you have it</label><input id="bi" name="bic">`;

  const wallet = `
    <label for="ch">Chain</label>
    <input id="ch" name="chain" placeholder="Ethereum" required>
    <label for="ad">Wallet address</label>
    <input id="ad" name="address" required spellcheck="false">
    <p class="muted">Copy and paste it. Do not type it out.</p>`;

  return `<div class="card">
    <h2>Where should your money go?</h2>
    <p>${part.outbound === "fiat"
      ? "The account you want to be paid into."
      : "The wallet you want to be paid to."}</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <form method="post">
      ${kind === "bank" ? bank : wallet}
      <div style="margin-top:18px"><button name="action" value="save">Continue</button></div>
      <p class="muted">Only you can enter this. We will never accept payment details
         for you from anybody else, including the sender.</p>
    </form></div>`;
}

export async function clientDeal(env: Env, request: Request, txId: string): Promise<Response> {
  const who = await whoIs(env, request);
  if (!who) return Response.redirect(new URL("/", request.url).toString(), 302);

  // A party sees a transaction only if they are on it. Checked here rather
  // than assumed from the link they followed.
  const part = await env.DB.prepare(
    `SELECT p.id AS participation_id, p.role, p.amount_minor, t.*
       FROM participations p JOIN transactions t ON t.id = p.transaction_id
      WHERE p.transaction_id = ? AND p.party_id = ?`)
    .bind(txId, who.partyId).first<any>();
  if (!part) return new Response("Not found", { status: 404 });

  const actor: Actor = { kind: "party", id: who.partyId,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  let error = "";
  if (request.method === "POST" && part.role === "recipient") {
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
    } else if (action === "edit") {
      const d = await forParticipation(env, part.participation_id);
      if (d && d.status !== "locked") {
        await env.DB.prepare(
          "UPDATE destinations SET status='draft', confirmed_at=NULL WHERE id=?")
          .bind(d.id).run();
      }
    }
  }

  const party = await env.DB.prepare("SELECT display_name FROM parties WHERE id = ?")
    .bind(who.partyId).first<any>();

  const kind: Kind = part.outbound === "fiat" ? "bank" : "wallet";
  const dest = part.role === "recipient"
    ? await forParticipation(env, part.participation_id) : null;
  const cleared = await standingCheck(env, who.partyId);

  const kv = (k: string, v: string) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  return shell(part.ref, `
    <h1>${esc(part.ref)}</h1>
    <p class="sub">${esc(part.name)}</p>
    <div class="card"><table>
      ${kv("Your part", `You are the <strong>${esc(part.role)}</strong>`)}
      ${kv("Type", esc(typeName(part)))}
      ${kv("Stage", `<span class="tag wait">${esc(part.status)}</span>`)}
      ${part.amount_minor ? kv("Your amount",
        `${esc(part.currency_out)} ${format(part.amount_minor, part.decimals_out)}`) : ""}
    </table></div>
    ${!cleared
      ? `<div class="card"><h2>First, verify yourself</h2>
          <p>We cannot ask for payment details until we know who you are.</p>
          <p><a href="/verify"><button>Verify</button></a></p></div>`
      : part.role === "recipient"
        ? destinationCard(part, dest, kind, error)
        : `<div class="card"><h2>Nothing needed yet</h2>
            <p class="muted" style="margin-bottom:0">We will email you when there is.</p>
          </div>`}`, party?.display_name);
}
