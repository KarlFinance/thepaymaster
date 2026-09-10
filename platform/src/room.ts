/**
 * The data room.
 *
 * A party's Peaceful Enjoyment dossier, shown to somebody who is not a party —
 * their bank's compliance officer, their accountant — through a link that
 * names the viewer, expires, and can be revoked. Every opening is logged. The
 * PDFs are the same ones the party holds, regenerated with the viewer's name
 * and the time watermarked through every page.
 *
 * The room shows only what the party could download themselves, and the
 * documents only when the inviter chose to include them. It never shows the
 * transaction's other parties.
 */

import { type Env, type Actor, id, log } from "./db.ts";
import { esc } from "./views.ts";
import { folderData, statementPdf, statementStatus, ownRecordPdf, documentLabel, type FolderData } from "./folder.ts";
import { roomShared, roomOpened } from "./notify.ts";
import { VERIFY_URL } from "./verify.ts";

export const ROOM_BASE = "https://client.thepaymaster.co.uk/room";

// --- tokens -----------------------------------------------------------------

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export interface Invite {
  id: string; transaction_id: string; party_id: string; viewer_name: string; viewer_email: string | null;
  include_documents: number; created_by_kind: string; created_by: string; expires_at: string;
  revoked_at: string | null; opens: number; first_opened_at: string | null; created_at: string;
}

// --- creating and managing invitations -------------------------------------------

export async function invite(env: Env, actor: Actor, o: {
  transactionId: string; partyId: string; viewerName: string; viewerEmail?: string | null;
  days: number; includeDocuments: boolean;
}): Promise<{ id: string; url: string } | { problem: string }> {
  const name = o.viewerName.trim().slice(0, 120);
  if (name.length < 2) return { problem: "Say who the link is for — a name, and their organisation." };
  const email = (o.viewerEmail ?? "").trim().toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { problem: "That email address does not look right." };
  const days = [7, 30, 90].includes(o.days) ? o.days : 30;

  const token = randomToken();
  const inviteId = id("room");
  const expires = new Date(Date.now() + days * 86400_000).toISOString().replace("T", " ").slice(0, 19);
  await env.DB.prepare(
    `INSERT INTO room_invites (id, transaction_id, party_id, token_hash, viewer_name, viewer_email,
       include_documents, created_by_kind, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(inviteId, o.transactionId, o.partyId, await sha256(token), name, email,
          o.includeDocuments ? 1 : 0, actor.kind, actor.id ?? "unknown", expires).run();
  await log(env.DB, actor, "room.invited", "room_invites", inviteId,
    { note: `for ${name}${email ? ` <${email}>` : ""}, ${days} days${o.includeDocuments ? ", with documents" : ""}` });

  const url = `${ROOM_BASE}/${token}`;
  if (email) await roomShared(env, actor, inviteId, url);
  return { id: inviteId, url };
}

export async function revoke(env: Env, actor: Actor, inviteId: string, partyId?: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT * FROM room_invites WHERE id = ?").bind(inviteId).first<Invite>();
  if (!row) return "No such invitation.";
  if (partyId && row.party_id !== partyId) return "That invitation is not yours.";
  if (row.revoked_at) return null;
  await env.DB.prepare("UPDATE room_invites SET revoked_at = ? WHERE id = ?").bind(stamp(), inviteId).run();
  await log(env.DB, actor, "room.revoked", "room_invites", inviteId, { note: `for ${row.viewer_name}` });
  return null;
}

export async function invitesFor(env: Env, transactionId: string, partyId: string): Promise<(Invite & { live: boolean })[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM room_invites WHERE transaction_id = ? AND party_id = ? ORDER BY created_at DESC`)
    .bind(transactionId, partyId).all<Invite>();
  const now = stamp();
  return (results ?? []).map((r: Invite) => ({ ...r, live: !r.revoked_at && r.expires_at > now }));
}

/** The form and list, shared by the party's page and the staff page. */
export function invitePanel(invites: (Invite & { live: boolean })[], action: string, o: { justMade?: string; error?: string } = {}): string {
  const rows = invites.map((i) => `<tr>
    <td>${esc(i.viewer_name)}${i.viewer_email ? `<div class="muted">${esc(i.viewer_email)}</div>` : ""}</td>
    <td class="muted">${esc(i.created_at.slice(0, 10))}</td>
    <td class="muted">${esc(i.expires_at.slice(0, 10))}</td>
    <td>${i.revoked_at ? `<span class="muted">revoked</span>` : !i.live ? `<span class="muted">expired</span>`
        : `<span class="good">live</span>`}${i.include_documents ? ` <span class="muted">· with documents</span>` : ""}</td>
    <td class="muted">${i.opens ? `${i.opens} × , first ${esc(String(i.first_opened_at).slice(0, 16))}` : "not yet opened"}</td>
    <td>${i.live ? `<form method="post" action="${esc(action)}" style="margin:0">
        <input type="hidden" name="revoke" value="${esc(i.id)}"><button class="plain small">Revoke</button></form>` : ""}</td>
  </tr>`).join("");
  return `
    ${o.error ? `<div class="err">${esc(o.error)}</div>` : ""}
    ${o.justMade ? `<div class="note" style="margin-bottom:12px"><b>The link is ready.</b> Copy it and send it, or it has already gone by email if you gave an address.
      <div style="margin-top:6px"><input readonly value="${esc(o.justMade)}" style="width:100%;font-family:ui-monospace,monospace;font-size:12px" onclick="this.select()"></div>
      <p class="muted" style="margin:6px 0 0;font-size:13px">The link is shown once. If it is lost, revoke it and make another.</p></div>` : ""}
    ${invites.length ? `<table class="log" style="margin-bottom:12px"><tr><th>For</th><th>Made</th><th>Expires</th><th>State</th><th>Opened</th><th></th></tr>${rows}</table>` : ""}
    <form method="post" action="${esc(action)}">
      <label for="vn">Who it is for</label>
      <input id="vn" name="viewer_name" required maxlength="120" placeholder="J. Patel, Compliance, HSBC London">
      <label for="ve">Their email <span class="muted">(optional — we send them the link)</span></label>
      <input id="ve" name="viewer_email" type="email" placeholder="compliance@bank.example">
      <label for="vd">The link works for</label>
      <select id="vd" name="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select>
      <label class="check"><input type="checkbox" name="include_documents" value="1" style="width:auto">
        Include the documents on file (passport, proof of address, shared reports) — not just the certification and record</label>
      <div class="row"><button class="go">Create the link</button></div>
      <p class="muted" style="font-size:13px">Every page they open is watermarked with their name and the time, and every opening is
        recorded. You can revoke a link at any time.</p>
    </form>`;
}

// --- the room itself -----------------------------------------------------------------

async function resolve(env: Env, token: string): Promise<Invite | null> {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT * FROM room_invites WHERE token_hash = ?")
    .bind(await sha256(token)).first<Invite>();
  if (!row || row.revoked_at || row.expires_at <= stamp()) return null;
  return row;
}

async function opened(env: Env, inv: Invite, what: string, request: Request): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") ?? null;
  await env.DB.prepare("INSERT INTO room_access (id, invite_id, ip, what) VALUES (?, ?, ?, ?)")
    .bind(id("acc"), inv.id, ip, what).run();
  const first = inv.opens === 0;
  await env.DB.prepare(
    "UPDATE room_invites SET opens = opens + 1, first_opened_at = COALESCE(first_opened_at, ?) WHERE id = ?")
    .bind(stamp(), inv.id).run();
  const actor: Actor = { kind: "system", id: null, ip: ip ?? undefined };
  // A read, so it stays out of the record (see dossier.facts) but in the audit log.
  await log(env.DB, actor, "room.viewed", "room_invites", inv.id, { note: `${inv.viewer_name}: ${what}` });
  if (first && what === "room") await roomOpened(env, actor, inv.id);
}

const gone = (why: string) => new Response(`<!doctype html><meta charset="utf-8"><title>Link not available</title>
<body style="font:16px/1.5 -apple-system,Helvetica,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#1B2430">
<h1 style="font-size:22px">This link is not available</h1><p>${esc(why)}</p>
<p>Ask the person who shared it with you for a new one. ThePaymaster Ltd, info@thepaymaster.co.uk.</p></body>`,
  { status: 410, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });

/** GET /room/:token[/what] */
export async function room(env: Env, request: Request, token: string, what: string): Promise<Response> {
  const inv = await resolve(env, token);
  if (!inv) return gone("It has expired, been revoked, or never existed.");
  const d = await folderData(env, inv.transaction_id, inv.party_id, "party");
  if (!d) return gone("The record it pointed at is no longer here.");
  const watermark = `Prepared for ${inv.viewer_name} — opened ${stamp().slice(0, 16)} UTC — ThePaymaster data room ${inv.id.slice(-6)}`;
  const pdfHeaders = (name: string) => ({ "content-type": "application/pdf", "cache-control": "no-store",
    "content-disposition": `inline; filename="${name}"`, "x-robots-tag": "noindex" });

  if (what === "certification.pdf") {
    await opened(env, inv, "certification", request);
    return new Response(statementPdf(d, { watermark }), { headers: pdfHeaders(`${d.tx.ref}-certification.pdf`) });
  }
  if (what === "record.pdf") {
    await opened(env, inv, "record", request);
    return new Response((await ownRecordPdf(env, d, { watermark })).pdf, { headers: pdfHeaders(`${d.tx.ref}-record.pdf`) });
  }
  if (what === "record.json") {
    await opened(env, inv, "record.json", request);
    return new Response((await ownRecordPdf(env, d)).json, { headers: { "content-type": "application/json",
      "cache-control": "no-store", "content-disposition": `attachment; filename="${d.tx.ref}-record.json"` } });
  }
  const doc = what.match(/^doc\/([A-Za-z0-9_]+)$/);
  if (doc) {
    if (!inv.include_documents) return gone("This link does not include the documents.");
    const a = d.documents.find((x: any) => x.id === doc[1]);
    if (!a) return gone("That document is not part of this dossier.");
    const obj = await env.DOCS?.get(a.r2_key);
    if (!obj) return gone("That document could not be retrieved.");
    await opened(env, inv, `doc:${a.id}`, request);
    return new Response(obj.body, { headers: { "content-type": a.content_type ?? "application/octet-stream",
      "cache-control": "no-store", "x-robots-tag": "noindex",
      "content-disposition": `inline; filename="${(a.filename ?? a.id).replace(/[^A-Za-z0-9._-]+/g, "_")}"` } });
  }
  if (what !== "room") return gone("There is nothing at that address.");

  await opened(env, inv, "room", request);
  return new Response(roomPage(inv, d, token), { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" } });
}

function roomPage(inv: Invite, d: FolderData, token: string): string {
  const st = statementStatus(d);
  const who = d.party.legal_name || d.party.display_name;
  const base = `/room/${token}`;
  const docs = inv.include_documents ? d.documents.map((a: any) => `<li><a href="${base}/doc/${esc(a.id)}" target="_blank">${esc(documentLabel(a))}</a>
      <span class="muted">— ${esc(String(a.uploaded_at).slice(0, 10))}, sha256 ${esc(String(a.sha256).slice(0, 16))}…</span></li>`).join("") : "";
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Data room — ${esc(d.tx.ref)}</title><meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="https://thepaymaster.co.uk/wp-content/uploads/elementor/google-fonts/css/plusjakartasans.css">
<style>
body{margin:0;font:15px/1.55 "Plus Jakarta Sans",-apple-system,Helvetica,sans-serif;color:#1B2430;background:#F4F6F9}
header{background:#0F1A2B;color:#fff;padding:18px 28px;display:flex;align-items:center;gap:18px}
header img{width:140px;height:auto}header .t{font-size:13px;color:#9FB0C6;letter-spacing:.04em;text-transform:uppercase}
main{max-width:820px;margin:0 auto;padding:30px 20px 50px}
.card{background:#fff;border-radius:12px;padding:22px 24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}
.muted{color:#5A6B80}.good{color:#1B7F4B;font-weight:700}.warn{color:#9A6700;font-weight:700}
ul{padding-left:18px}li{margin:6px 0}
a.btn{display:inline-block;background:#F26A21;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px;margin:4px 8px 4px 0}
a.btn.plain{background:#fff;color:#1B2430;border:1.5px solid #1B2430}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
footer{text-align:center;color:#8C99AC;font-size:13px;padding:10px 20px 30px}
</style></head><body>
<header><img src="https://thepaymaster.co.uk/wp-content/uploads/2024/05/b-logo.png" alt="ThePaymaster"><div><div class="t">Data room</div><div>Prepared for <b>${esc(inv.viewer_name)}</b></div></div></header>
<main>
  <div class="card">
    <h1>Peaceful Enjoyment dossier — ${esc(who)}</h1>
    <p class="muted" style="margin:0 0 10px">Transaction ${esc(d.tx.ref)}${d.tx.name ? ` — ${esc(d.tx.name)}` : ""}. Shared by ${inv.created_by_kind === "party" ? esc(who) : "ThePaymaster"} on ${esc(inv.created_at.slice(0, 10))}; this link works until ${esc(inv.expires_at.slice(0, 10))}.</p>
    <p class="${st.final ? "good" : "warn"}">${st.final ? "Final — the transaction is complete and the record is sealed." : `Provisional — ${esc(st.why)}.`}</p>
    <p>This room holds what ThePaymaster® can state about ${esc(who)}'s part in this transaction, drawn from a record made at the time and sealed. Every page you open is watermarked with your name and the time, and each opening is recorded.</p>
    <p><a class="btn" href="${base}/certification.pdf" target="_blank">Counterparty Certification</a>
       <a class="btn plain" href="${base}/record.pdf" target="_blank">The record, with proofs</a>
       <a class="btn plain" href="${base}/record.json">record.json</a></p>
  </div>
  ${inv.include_documents ? `<div class="card"><h2>Documents on file</h2>${docs ? `<ul>${docs}</ul>` : `<p class="muted">None.</p>`}
    <p class="muted" style="font-size:13px">Each file's SHA-256 was taken as it arrived; the certification lists the same values.</p></div>` : ""}
  <div class="card">
    <h2>Check it without trusting us</h2>
    <p>Download <b>record.json</b> and paste it at <a href="${VERIFY_URL}" target="_blank">${esc(VERIFY_URL.replace("https://", ""))}</a>: every entry is recomputed from its contents and matched to the sealed root, and ThePaymaster's signature over the seal is verified.
       ${d.latestSeal ? `Record root <span class="mono">${esc(d.latestSeal.root)}</span>, sealed ${esc(String(d.latestSeal.sealed_at).slice(0, 16))} UTC.` : "The record is not yet sealed."}</p>
  </div>
</main>
<footer>ThePaymaster Ltd, 85 Great Portland Street, First Floor, London W1W 7LT · info@thepaymaster.co.uk · +44 20 7088 8267<br>
ThePaymaster® acts exclusively as the sender's agent under a distinct appointment for each transaction (PSR 2017, Sch 1, para 2(b)).</footer>
</body></html>`;
}
