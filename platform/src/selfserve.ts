/**
 * Self-serve distributions.
 *
 * The person with the USDT starts the distribution themselves: who they are,
 * what it is for, how much, and who receives what share. They confirm their
 * email, and every recipient is invited. Each party verifies and signs in
 * their own account; recipients give and prove their wallets. From there the
 * platform moves the transaction on by itself — screening each wallet against
 * the US sanctions list and the issuer's frozen list, locking addresses that
 * are confirmed, proved, screened and signed for, moving to ready when every
 * check is green, and sealing the record when the last payment lands.
 *
 * Staff do only what must be a person's decision, and are emailed with a link
 * each time: deciding each party's identity check, and looking at any wallet
 * the screen flags. The payments themselves are the tested route: the sender
 * pays our fee first, then each recipient, from their own wallet.
 */

import { type Env, type Actor, id, insert, update, nextRef, log, canMove } from "./db.ts";
import { esc } from "./views.ts";
import { format, parse } from "./money.ts";
import { mint } from "./tokens.ts";
import { send, invite, staffEmails } from "./email.ts";
import { assess } from "./readiness.ts";
import { railByKey, railFor } from "./rail.ts";
import { DEFAULT_TOKENS } from "./chain.ts";
import { feeWalletFor } from "./housewallets.ts";
import { lock as lockDestination } from "./destinations.ts";
import { proved as provedAddress } from "./attest.ts";
import { standing } from "./walletscreen.ts";
import { status as agreementStatus } from "./agreements.ts";
import { seal, seals } from "./dossier.ts";
import { readyToSend, recipientsInvited, sealed as sealedNotify } from "./notify.ts";
import { get as getSetting } from "./switches.ts";
import { ACKNOWLEDGEMENT } from "./enquiry.ts";
import { visitorId } from "./traffic.ts";
import { human, sitekey, SITEKEY, SCRIPT as TURNSTILE_SCRIPT, HUMAN_CHECK_FAILED } from "./turnstile.ts";

const SYSTEM: Actor = { kind: "system", id: null };
const ADMIN = "https://admin.thepaymaster.co.uk";
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const MAX_RECIPIENTS = 10;

export async function selfServeOn(env: Env): Promise<boolean> {
  return (await getSetting(env, "self_serve")) !== "off";
}
/** The rail a self-serve distribution runs on: USDT on Ethereum, or (for rehearsals) whatever is set. */
async function selfServeRail(env: Env): Promise<{ key: string; token: string | null }> {
  const key = (await getSetting(env, "self_serve_rail")) || "eth:1:usdt";
  const chainId = Number(key.split(":")[1]);
  const token = (await getSetting(env, "self_serve_token")) || DEFAULT_TOKENS[chainId]?.[key.split(":")[2]] || null;
  return { key, token };
}

/** Where client links point: the client host, or this machine while developing. */
function clientLinkBase(env: Env, request: Request): string {
  if (env.CLIENT_BASE) return env.CLIENT_BASE;
  const u = new URL(request.url);
  return ["localhost", "127.0.0.1"].includes(u.hostname) ? `http://localhost:${u.port}` : "https://client.thepaymaster.co.uk";
}

// ---------------------------------------------------------------------------
// The start page
// ---------------------------------------------------------------------------

const CSS = `
body{margin:0;font:16px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;background:#F5F7FA;color:#4A5567}
main{max-width:760px;margin:40px auto;padding:32px;background:#fff;border:1px solid #DBDFEA;border-radius:10px}
h1{color:#0C1524;font-size:28px;margin:0 0 6px} h2{color:#0C1524;font-size:19px;margin:28px 0 10px}
label{display:block;font-weight:600;color:#0C1524;margin:14px 0 6px;font-size:14px}
input,textarea,select{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #CBD2DC;border-radius:6px;font:inherit;font-size:15px}
.row{display:grid;grid-template-columns:1.4fr 1.6fr .8fr;gap:10px;margin-bottom:8px}
.row input{margin:0}.muted{color:#6B7280;font-size:14px}.err{background:#FDECEC;color:#8B1E1E;padding:10px 14px;border-radius:6px;margin:12px 0}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;color:#4A5567}.check input{width:auto;margin-top:5px}
button{margin-top:22px;background:#FF8159;color:#0C1524;border:0;border-radius:6px;padding:12px 26px;font-weight:700;font-size:15px;cursor:pointer}
.hp{position:absolute;left:-9999px}
.steps{background:#F5F7FA;border-radius:8px;padding:14px 18px;margin:16px 0}.steps li{margin:4px 0}
@media(max-width:640px){.row{grid-template-columns:1fr}}`;

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ThePaymaster</title>
<style>${CSS}</style></head><body><main>${body}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function startForm(error = "", was: Record<string, string> = {}, key: string = SITEKEY): Response {
  const v = (k: string) => esc(was[k] ?? "");
  const rows = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `
    <div class="row">
      <input name="rname${i}" placeholder="Recipient ${i + 1} — full name" value="${v(`rname${i}`)}"${i === 0 ? " required" : ""}>
      <input name="remail${i}" type="email" placeholder="Their email" value="${v(`remail${i}`)}"${i === 0 ? " required" : ""}>
      <input name="rshare${i}" inputmode="decimal" placeholder="Share %" value="${v(`rshare${i}`)}"${i === 0 ? " required" : ""}>
    </div>`).join("");
  return page("Start a USDT distribution", `
    <h1>Start a USDT distribution</h1>
    <p>For a sender who holds USDT and needs to pay it to several people. You set it up here; every
       recipient is invited to their own account; you pay from your own wallet once everyone is verified.</p>
    <ol class="steps">
      <li>You give the distribution and the recipients' shares, and confirm your email.</li>
      <li>Everyone, you included, verifies their identity — name, address, date of birth, passport and proof of address — and signs their agreement.</li>
      <li>Each recipient gives and proves the wallet they will be paid into. You prove the wallet you will pay from.</li>
      <li>When every check is complete you are emailed. You pay our 1% fee first, then each recipient, from your wallet.</li>
      <li>Every payment is checked on the chain, and everyone receives their sealed record.</li>
    </ol>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <form method="post" action="/distribute">
      <h2>You</h2>
      <label for="sn">Your full name</label><input id="sn" name="sender_name" required value="${v("sender_name")}" autocomplete="name">
      <label for="se">Your email</label><input id="se" name="sender_email" type="email" required value="${v("sender_email")}" autocomplete="email">
      <label for="sp">Your phone or WhatsApp</label><input id="sp" name="sender_phone" value="${v("sender_phone")}" autocomplete="tel">
      <h2>The distribution</h2>
      <label for="dn">A name for it</label><input id="dn" name="name" required value="${v("name")}" placeholder="Proceeds of the Ashcroft sale">
      <label for="dd">What completed, and why these people are owed a share</label>
      <textarea id="dd" name="detail" rows="3" required>${v("detail")}</textarea>
      <label for="ga">Total USDT you will send, including our 1% fee</label>
      <input id="ga" name="gross" inputmode="decimal" required value="${v("gross")}" placeholder="25,000,000">
      <p class="muted">Our 1% comes out of this total; recipients share what remains in the proportions below. Paid in USDT on Ethereum.</p>
      <h2>Recipients</h2>
      <p class="muted">Each recipient's share of what remains after our fee. The shares must add up to 100.</p>
      ${rows}
      <label class="check"><input type="checkbox" name="acknowledged" value="1" required${was.acknowledged ? " checked" : ""}> <span>${esc(ACKNOWLEDGEMENT)}</span></label>
      <div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>
      <div class="cf-turnstile" data-sitekey="${key}" data-action="distribute" style="margin-top:18px"></div>
      ${TURNSTILE_SCRIPT}
      <button type="submit">Start the distribution</button>
      <p class="muted">We email you a link to confirm. Nobody else hears from us until you have.</p>
    </form>`);
}

async function partyFor(env: Env, actor: Actor, name: string, email: string, phone: string | null): Promise<string> {
  const found = await env.DB.prepare("SELECT id FROM parties WHERE lower(email) = ?").bind(email.toLowerCase()).first<any>();
  if (found) return found.id;
  const pid = id("pty");
  await insert(env.DB, actor, "party.created", "parties", pid, { kind: "individual", display_name: name, email: email.toLowerCase(), phone });
  return pid;
}

export async function startSubmit(env: Env, request: Request, later: (p: Promise<unknown>) => void): Promise<Response> {
  if (!(await selfServeOn(env))) return Response.redirect(new URL("/enquiry", request.url).toString(), 303);
  const f = await request.formData();
  const s = (k: string) => String(f.get(k) ?? "").trim();
  const was = Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)]));
  if (s("website")) return page("Thank you", "<h1>Thank you</h1><p>Please check your email.</p>");
  if (!(await human(env, request, f, "distribute"))) return startForm(HUMAN_CHECK_FAILED, was, sitekey(env));
  const email = s("sender_email").toLowerCase();
  if (!s("sender_name") || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return startForm("Your name and a valid email are needed.", was, sitekey(env));
  if (!s("name") || !s("detail")) return startForm("Give the distribution a name and say what it is for.", was, sitekey(env));
  if (!f.get("acknowledged")) return startForm("Please tick to confirm you understand that every party will be verified.", was, sitekey(env));
  let gross: number;
  try { gross = parse(s("gross"), 6); } catch { return startForm(`We could not read "${s("gross")}" as an amount.`, was, sitekey(env)); }
  if (gross <= 0) return startForm("Enter the total you will send.", was, sitekey(env));

  const recipients: { name: string; email: string; bps: number }[] = [];
  for (let i = 0; i < MAX_RECIPIENTS; i++) {
    const n = s(`rname${i}`), e = s(`remail${i}`).toLowerCase(), sh = s(`rshare${i}`);
    if (!n && !e && !sh) continue;
    if (!n || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || !sh) return startForm(`Recipient ${i + 1} needs a name, a valid email and a share.`, was, sitekey(env));
    let bps: number;
    try { bps = parse(sh.replace("%", ""), 2); } catch { return startForm(`Recipient ${i + 1}'s share "${sh}" is not a number.`, was, sitekey(env)); }
    if (bps <= 0) return startForm(`Recipient ${i + 1}'s share must be more than zero.`, was, sitekey(env));
    if (e === email) return startForm("You cannot be a recipient of your own distribution.", was, sitekey(env));
    if (recipients.some((r) => r.email === e)) return startForm(`${e} is listed twice.`, was, sitekey(env));
    recipients.push({ name: n, email: e, bps });
  }
  if (!recipients.length) return startForm("Add at least one recipient.", was, sitekey(env));
  const total = recipients.reduce((a, r) => a + r.bps, 0);
  if (total !== 10000) return startForm(`The shares add up to ${format(total, 2)}%. They must add up to 100.`, was, sitekey(env));

  // A little restraint: a link to start a distribution is not a way to email strangers in bulk.
  const recent = await env.DB.prepare(
    `SELECT count(*) AS n FROM transactions WHERE self_serve = 1 AND submitted_by = ? AND created_at > datetime('now','-1 day')`).bind(email).first<any>();
  if ((recent?.n ?? 0) >= 3) return startForm("You have started several distributions today. Please contact us and we will help.", was, sitekey(env));

  const actor: Actor = { kind: "system", id: null, ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  const rail = await selfServeRail(env);
  const choice = railByKey(rail.key)!;
  const fee = await feeWalletFor(env, rail.key);
  const senderId = await partyFor(env, actor, s("sender_name"), email, s("sender_phone") || null);
  const txId = id("tx");
  const ref = await nextRef(env.DB);
  await insert(env.DB, actor, "transaction.created", "transactions", txId, {
    ref, name: s("name").slice(0, 160), detail: s("detail").slice(0, 2000),
    inbound: "crypto", outbound: "crypto", converts: 0,
    currency_in: "USDT", currency_out: "USDT", decimals_in: 6, decimals_out: 6,
    fee_bps: 100, fee_mode: "deducted", acting_for: "payer", gross_expected_minor: gross,
    status: "draft", created_by: "adm_system", submitted_at: stamp(), submitted_by: email,
    rail: rail.key, chain_id: choice.chainId, token_address: rail.token, fee_wallet: fee?.address ?? null,
    execution: "sender", self_serve: 1,
  }, { note: `self-serve: ${recipients.length} recipient(s), USDT ${format(gross, 6)}` });
  const senderPart = id("par");
  await insert(env.DB, actor, "participation.added", "participations", senderPart, { transaction_id: txId, party_id: senderId, role: "sender" });
  for (const r of recipients) {
    const pid = await partyFor(env, actor, r.name, r.email, null);
    await insert(env.DB, actor, "participation.added", "participations", id("par"), { transaction_id: txId, party_id: pid, role: "recipient", share_bps: r.bps });
  }
  // On the enquiry queue too, so it is seen where everything else is seen.
  await insert(env.DB, actor, "enquiry.received", "enquiries", id("enq"), {
    name: s("sender_name"), email, phone: s("sender_phone") || null, whatsapp_ok: 0,
    amount_minor: gross, currency: "USDT", inbound: "crypto", outbound: "crypto", converts: 0,
    detail: `Self-serve distribution ${ref}: ${s("name")}\n${s("detail")}\n\n` + recipients.map((r) => `${r.name} <${r.email}> ${format(r.bps, 2)}%`).join("\n"),
    source: "Self-serve distribution", status: "converted", transaction_id: txId,
    visitor: await visitorId(env, request),
    acknowledged_at: stamp(), acknowledged_text: ACKNOWLEDGEMENT,
  });

  const base = clientLinkBase(env, request);
  const { url } = await mint(env, actor, { purpose: "join", email, base, transactionId: txId, participationId: senderPart });
  later((async () => {
    await send(env, actor, {
      to: email, subject: `${ref}: confirm your distribution and invite your recipients`,
      text: [`Hello ${s("sender_name").split(/\s+/)[0]},`, ``,
        `You have set up ${ref}, "${s("name")}": USDT ${format(gross, 6)} to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}.`,
        `Open this link to confirm it. That invites your recipients and opens your own account, where you verify yourself, sign your agreement and add the wallet you will pay from:`,
        ``, `  ${url}`, ``,
        `If you did not set this up, ignore this email and nothing happens.`].join("\n"),
      about: { kind: "transactions", id: txId },
    });
    const staff = await staffEmails(env);
    if (staff.length) await send(env, actor, {
      to: staff, subject: `${ref}: new self-serve distribution — USDT ${format(gross, 6)} from ${s("sender_name")}`,
      text: [`${s("sender_name")} <${email}> has started a self-serve USDT distribution.`, ``,
        ...recipients.map((r) => `  ${r.name} <${r.email}> — ${format(r.bps, 2)}%`), ``,
        `Nothing is needed from you yet. You will be emailed when each person's identity documents are in and need your decision.`,
        ``, `${ADMIN}/t/${txId}`].join("\n"),
      about: { kind: "transactions", id: txId },
    });
  })());

  return page("Check your email", `<h1>Check your email</h1>
    <p>We have sent a link to <b>${esc(email)}</b>. Open it to confirm <b>${esc(ref)}</b> and invite your recipients.</p>
    <p class="muted">Nobody else is contacted until you do. The link lasts seven days.</p>`);
}

// ---------------------------------------------------------------------------
// The sender confirms: invite everyone
// ---------------------------------------------------------------------------

/** Called when the sender follows their confirmation link. */
export async function senderConfirmed(env: Env, txId: string, participationId: string | null, base: string): Promise<void> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!t || !t.self_serve || t.status !== "draft") return;
  const part = participationId ? await env.DB.prepare("SELECT role FROM participations WHERE id = ?").bind(participationId).first<any>() : null;
  if (part?.role !== "sender") return;
  await update(env.DB, SYSTEM, "transaction.released", "transactions", txId,
    { status: "awaiting_parties", updated_at: stamp() }, { status: t.status }, { note: "self-serve: the sender confirmed; recipients invited" });
  await env.DB.prepare("UPDATE participations SET invited_at = datetime('now') WHERE id = ?").bind(participationId).run();
  const { results } = await env.DB.prepare(
    `SELECT p.id AS participation_id, p.role, y.display_name, y.email FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ? AND p.role = 'recipient'`).bind(txId).all<any>();
  const sender = await env.DB.prepare(
    "SELECT y.display_name FROM participations p JOIN parties y ON y.id = p.party_id WHERE p.transaction_id = ? AND p.role = 'sender'").bind(txId).first<any>();
  for (const p of results ?? []) {
    const { url } = await mint(env, SYSTEM, { purpose: "join", email: p.email, base, transactionId: txId, participationId: p.participation_id });
    await env.DB.prepare("UPDATE participations SET invited_at = datetime('now') WHERE id = ?").bind(p.participation_id).run();
    await send(env, SYSTEM, { ...invite({ ref: t.ref, name: t.name, role: "recipient", senderName: sender?.display_name ?? "A client", url }),
      to: p.email, about: { kind: "participations", id: p.participation_id } });
  }
  await recipientsInvited(env, SYSTEM, txId);
}

// ---------------------------------------------------------------------------
// Moving on by itself
// ---------------------------------------------------------------------------

const LISTS: Record<string, string[]> = {
  eth: ["ETH", "USDT", "USDC"], tron: ["TRX", "USDT"], btc: ["XBT"],
};
let listCache: { at: number; family: string; set: Set<string> }[] = [];

/** Addresses on the US Treasury (OFAC) sanctions list, as published per asset and refreshed from it daily. */
async function sanctioned(family: string): Promise<Set<string> | null> {
  const hit = listCache.find((c) => c.family === family && Date.now() - c.at < 6 * 3600_000);
  if (hit) return hit.set;
  const set = new Set<string>();
  for (const sym of LISTS[family] ?? []) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_${sym}.txt`);
      if (!res.ok) return null;
      for (const line of (await res.text()).split(/\s+/)) if (line) set.add(line.toLowerCase());
    } catch { return null; }
  }
  listCache = listCache.filter((c) => c.family !== family).concat([{ at: Date.now(), family, set }]);
  return set;
}

/** Screen one address: the sanctions list, and the token issuer's own frozen list. */
async function basicScreen(env: Env, t: any, address: string, partyName: string): Promise<"clear" | "flagged" | null> {
  const txId = t.id as string;
  // Built from the transaction, so the rail knows the token contract it moves.
  const rail = railFor(t);
  const deferred = async (why: string) => {
    await log(env.DB, SYSTEM, "self_serve.screen_deferred", "transactions", txId, { note: `${partyName} ${address}: ${why}; tried again on the next visit` });
    return null;
  };
  const list = await sanctioned(String(t.rail).split(":")[0]);
  if (!list) return deferred("the sanctions list could not be fetched");   // never "clear" by default
  const onList = list.has(address.toLowerCase());
  let frozen: boolean | null = null;
  if (rail.canFreeze) { try { frozen = (await rail.inspect(env, address, partyName)).frozen; } catch { frozen = null; } }
  if (rail.canFreeze && frozen === null) return deferred("the issuer's freeze list could not be read");
  const verdict = onList || frozen ? "flagged" : "clear";
  const findings = onList ? "On the US Treasury (OFAC) sanctions list."
    : frozen ? "Frozen by the token issuer — cannot receive."
    : `Not on the US Treasury (OFAC) sanctions list${rail.canFreeze ? "; not frozen by the token issuer" : ""}. Automatic basic screen.`;
  const now = new Date();
  await insert(env.DB, SYSTEM, `wallet.${verdict}`, "wallet_screens", id("scr"), {
    address, chain_id: rail.chainId, transaction_id: txId, provider: "sanctions-list", verdict, findings,
    screened_at: now.toISOString().replace("T", " ").slice(0, 19),
    expires_at: new Date(now.getTime() + 30 * 86_400_000).toISOString().replace("T", " ").slice(0, 19),
  }, { note: `${partyName}: ${findings}` });
  if (verdict === "flagged") {
    const staff = await staffEmails(env);
    const t = await env.DB.prepare("SELECT ref FROM transactions WHERE id = ?").bind(txId).first<any>();
    if (staff.length) await send(env, SYSTEM, {
      to: staff, subject: `${t?.ref}: a wallet was flagged — look at it`,
      text: [`The automatic screen flagged ${partyName}'s address on ${t?.ref}:`, ``, `  ${address}`, ``, findings, ``,
        `The transaction cannot proceed while it stands. Look at it, and record your own verdict on the transaction page if it is wrong.`, ``,
        `${ADMIN}/t/${txId}`].join("\n"),
      about: { kind: "transactions", id: txId },
    });
  }
  return verdict;
}

const fresh = (at: string | null | undefined, days: number) =>
  Boolean(at) && Date.now() - Date.parse(String(at).replace(" ", "T") + "Z") < days * 86_400_000;

/**
 * Move a self-serve transaction on as far as it can go without a person.
 * Safe to call any number of times: every step checks before it acts.
 */
export async function advance(env: Env, txId: string): Promise<void> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!t || !t.self_serve || ["draft", "closed", "abandoned", "declined"].includes(t.status)) return;
  try {
    const chainId = t.chain_id as number;

    // 1. Screen what needs screening: proved recipient wallets, the proved sending
    //    wallets, our fee wallet. Re-screened after six days, because a payment
    //    needs a screen under seven days old.
    const targets: { address: string; who: string; destinationId?: string; partyId?: string }[] = [];
    const { results: dests } = await env.DB.prepare(
      `SELECT d.*, y.display_name, y.id AS party_id FROM destinations d JOIN participations p ON p.id = d.participation_id
         JOIN parties y ON y.id = p.party_id WHERE p.transaction_id = ? AND d.kind = 'wallet' AND d.address IS NOT NULL`).bind(txId).all<any>();
    for (const d of dests ?? []) {
      if ((await provedAddress(env, d)).ok) targets.push({ address: d.address, who: d.display_name, destinationId: d.id, partyId: d.party_id });
    }
    const { results: sw } = await env.DB.prepare(
      "SELECT address FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL AND proved_at IS NOT NULL").bind(txId).all<any>();
    for (const w of sw ?? []) targets.push({ address: w.address, who: "the sender's wallet" });
    if (t.fee_wallet) targets.push({ address: t.fee_wallet, who: "ThePaymaster fee wallet" });
    for (const a of targets) {
      const s = await standing(env, a.address, chainId);
      if (s && s.verdict !== "clear") continue;                       // flagged: a person decides
      // Screened for this transaction, recently: the record of this
      // transaction must carry its own screen, not lean on another's.
      const here = await env.DB.prepare(
        `SELECT screened_at FROM wallet_screens WHERE transaction_id = ? AND lower(address) = lower(?) AND verdict = 'clear'
          ORDER BY screened_at DESC, rowid DESC LIMIT 1`).bind(txId, a.address).first<any>();
      if (here && fresh(here.screened_at, 6)) continue;
      await basicScreen(env, t, a.address, a.who);
    }

    // 2. Lock each recipient's address once it is confirmed, proved, screened
    //    clear and covered by their signed authorisation.
    for (const a of targets.filter((x) => x.destinationId)) {
      const d = (dests ?? []).find((x: any) => x.id === a.destinationId);
      if (!d || d.status !== "confirmed") continue;
      const s = await standing(env, a.address, chainId);
      if (!s || s.verdict !== "clear") continue;
      const ag = await agreementStatus(env, txId, a.partyId!);
      if (ag?.state !== "signed") continue;
      await lockDestination(env, SYSTEM, d.id);
    }

    // 3. Ready when the whole gate is green; the sender is emailed to pay.
    const now = await env.DB.prepare("SELECT status FROM transactions WHERE id = ?").bind(txId).first<any>();
    if (now && ["awaiting_parties", "kyc"].includes(now.status)) {
      const state = await assess(env, txId);
      if (state.ready) {
        let status = now.status;
        for (const to of ["kyc", "ready"]) {
          if (status === to || !canMove(status, to)) continue;
          await update(env.DB, SYSTEM, `transaction.${to}`, "transactions", txId, { status: to, updated_at: stamp() },
            { status }, { note: "self-serve: every check is complete" });
          status = to;
        }
        if (status === "ready") await readyToSend(env, SYSTEM, txId);
      }
    }

    // 4. Seal when the last payment has landed.
    const after = await env.DB.prepare("SELECT status FROM transactions WHERE id = ?").bind(txId).first<any>();
    if (after?.status === "settled" && !(await seals(env, txId)).length) {
      const s = await seal(env, SYSTEM, txId);
      await sealedNotify(env, SYSTEM, txId, s.root);
    }
  } catch (err) {
    await log(env.DB, SYSTEM, "self_serve.advance_failed", "transactions", txId, { note: (err as Error).message.slice(0, 200) });
  }
}

/** Every self-serve transaction a party is on, moved on (after an identity decision, say). */
export async function advanceForParty(env: Env, partyId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT t.id FROM transactions t JOIN participations p ON p.transaction_id = t.id
      WHERE p.party_id = ? AND t.self_serve = 1 AND t.status NOT IN ('draft','closed','abandoned','declined')`).bind(partyId).all<any>();
  for (const r of results ?? []) await advance(env, r.id);
}
