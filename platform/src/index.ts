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
import { dossierPage, sealNow, anchorNow } from "./dossierview.ts";
import { enquiryForm, submitEnquiry, inbox, enquiryDetail, enquiryStatus } from "./enquiry.ts";
import { startPage, startSubmit, joinLink, signOut, clientHome, clientDeal, clientPayments, clientAgreementPdf,
         clientRecord, clientSend, requestReturn, followReturn, clientMandate,
         clientVerify, clientHelpPage, clientFolder, verifyRecordPage,
         clientStartOwn, clientAgain, clientCounterparties, clientTeam, clientAnnual } from "./client.ts";
import { annualData, annualPdf, annualJson, yearsFor } from "./annual.ts";
import { attesterStatus, deployContract, mintCertificates, badgeMetadata, badgeSvg, BADGE_CHAINS } from "./badge.ts";
import { membersOf, revokeMember, teamPanel } from "./team.ts";
import { cloneTransaction } from "./loop.ts";
import { partyFolder, folderData, statementPdf } from "./folder.ts";
import { room, invite as roomInvite, revoke as roomRevoke, invitesFor, invitePanel } from "./room.ts";
import { reviewQueue, decide, whatIsMissing, peopleOf, standingCheck,
         history, documentsFor } from "./kyc.ts";
import { fetchDocument, store, DocumentProblem } from "./documents.ts";
import { assess, summarise } from "./readiness.ts";
import { screen as screenAddress, recordVerdict, forTransaction as screensFor,
         screenAll, nominis,
         standing as standingScreen } from "./walletscreen.ts";
import { txHashProblem, receipt as txReceipt, explorerLink, addressLink,
         CHAINS, USDT_MAINNET } from "./chain.ts";
import { arrival, legs, events as custodyEvents, settlementChecks,
         record as recordCustody, holderFor } from "./settlement.ts";
import { forTransaction, lock as lockDestination, requestChange,
         approveChange, describe as describeDestination } from "./destinations.ts";
import { mint } from "./tokens.ts";
import { recipientsInvited, readyToSend } from "./notify.ts";
import { resolve as resolveSettings, put as putSetting, clear as clearSetting,
         list as listSettings, noteCheck } from "./settings.ts";
import { request as requestMandate, revoke as revokeMandate,
         standing as standingMandate, history as mandateHistory,
         type Mandate as MandateRow } from "./mandate.ts";
import { send, startLink, invite } from "./email.ts";
import { dossierBundle, dossierPdfFor } from "./bundle.ts";
import { adminHelp, gateTip, tip, GATE_TIPS } from "./help.ts";
const GATE_TIPS_PROVED = GATE_TIPS.proved;
import { countryName } from "./countries.ts";
import { railFor, railByKey, railChoice, RAILS } from "./rail.ts";
import { ACCEPTED } from "./documents.ts";
import { grant as grantAttestation, revoke as revokeAttestation,
         forTransaction as attestationsFor } from "./attest.ts";
import { sendPenny, pennyReference, importStatement, reconcile as reconcileBank,
         expected as bankExpected, paymentsCsv, linesFor as bankLines, paysDirect, accountFromVar } from "./bank.ts";
import { forTransaction as agreementsFor, VERSION as AGREEMENT_VERSION } from "./agreements.ts";
import { fiatMode, FIAT_MODES, set as setSwitch, type FiatMode } from "./switches.ts";
import { agreementRequested, fundsReceived, paymentMade } from "./notify.ts";

/** The PDFs we hand to clients, by the name they are served under. */
const PAPERS = new Set([
  "distribution-without-custody.pdf",
  "sending-a-crypto-distribution.pdf",
  "client-information-sheet.pdf",          // the CIS: company, regulatory position, client account
]);

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
    // Credentials staff have stored are decrypted once and folded into env, so
    // everything downstream reads them exactly as it reads a Worker secret and
    // needs to know nothing about where they came from.
    env = await resolveSettings(env);
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
        if (url.pathname === "/back" && request.method === "POST") {
          return requestReturn(env, request);
        }
        if (url.pathname.startsWith("/back/")) {
          return followReturn(env, url.pathname.slice(6), request);
        }
        if (url.pathname === "/signout") return signOut(env, request);
        if (url.pathname === "/verify") {
          return clientVerify(env, request, (p) => ctx.waitUntil(p));
        }
        if (url.pathname === "/") return clientHome(env, request);
        if (url.pathname === "/help") return clientHelpPage(env, request);
        if (url.pathname === "/verify-record") return verifyRecordPage(env, request);
        if (url.pathname === "/start-own" && request.method === "POST") return clientStartOwn(env, request);
        if (url.pathname === "/counterparties") return clientCounterparties(env, request);
        if (url.pathname === "/team") return clientTeam(env, request);
        const annual = url.pathname.match(/^\/annual\/(\d{4})\.(pdf|json)$/);
        if (annual) return clientAnnual(env, request, Number(annual[1]), annual[2] as "pdf" | "json");
        const badge = url.pathname.match(/^\/badge\/([0-9a-fA-F]{64})\.(json|svg)$/);
        if (badge) {
          const body = badge[2] === "json" ? await badgeMetadata(env, badge[1]) : await badgeSvg(env, badge[1]);
          if (!body) return new Response("Not found", { status: 404 });
          return new Response(body, { headers: { "content-type": badge[2] === "json" ? "application/json" : "image/svg+xml",
            "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
        }
        if (url.pathname.startsWith("/room/")) {
          const [token, ...rest] = url.pathname.slice(6).split("/");
          return room(env, request, token, rest.length ? rest.join("/") : "room");
        }
        // Published papers: public, read-only, viewed in the browser. Only
        // names from the list below are served, so the bucket is not browsable.
        if (url.pathname.startsWith("/papers/")) {
          const name = url.pathname.slice(8);
          if (!PAPERS.has(name)) return new Response("Not found", { status: 404 });
          const obj = await env.DOCS?.get(`papers/${name}`);
          if (!obj) return new Response("Not found", { status: 404 });
          return new Response(obj.body, { headers: {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename="${name}"`,
            "cache-control": "public, max-age=3600",
            "x-robots-tag": "noindex",
          } });
        }
        if (url.pathname.startsWith("/d/")) {
          const dealId = url.pathname.slice(3).split("/")[0];
          if (url.pathname.endsWith("/record")) {
            return clientRecord(env, request, dealId);
          }
          if (url.pathname.endsWith("/statement.pdf") || url.pathname.endsWith("/certification.pdf")) {
            return clientFolder(env, request, dealId, "statement");
          }
          if (url.pathname.endsWith("/record.pdf")) return clientFolder(env, request, dealId, "record");
          if (url.pathname.endsWith("/folder.zip")) return clientFolder(env, request, dealId, "folder");
          if (url.pathname.endsWith("/mandate") && request.method === "POST") {
            return clientMandate(env, request, dealId);
          }
          if (url.pathname.endsWith("/room") && request.method === "POST") {
            return clientDeal(env, request, dealId);
          }
          if (url.pathname.endsWith("/again") && request.method === "POST") {
            return clientAgain(env, request, dealId);
          }
          if (url.pathname.endsWith("/payments.csv")) return clientPayments(env, request, dealId);
          if (url.pathname.endsWith("/agreement.pdf")) return clientAgreementPdf(env, request, dealId);
          if (/\/(bank|agreement|sent|received)$/.test(url.pathname) && request.method === "POST") {
            return clientDeal(env, request, dealId);
          }
          if (url.pathname.endsWith("/send") || url.pathname.endsWith("/send/prepare")) {
            return clientSend(env, request, dealId);
          }
          return clientDeal(env, request, dealId);
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
      if (url.pathname === "/help") {
        return page("Help", adminHelp(), { nav: nav("/help", admin.name) });
      }
      if (url.pathname === "/badges") return badgesPage(env, admin, actor, request);
      if (url.pathname === "/fiat") return fiatPage(env, admin, actor, request);
      if (url.pathname.startsWith("/p/")) {
        const pid = url.pathname.slice(3).split("/")[0];
        if (url.pathname.endsWith("/decide") && request.method === "POST") {
          return kycDecide(request, env, actor, pid);
        }
        if (url.pathname.endsWith("/upload") && request.method === "POST") {
          return upload(request, env, actor, { partyId: pid }, `/p/${pid}`);
        }
        const annualP = url.pathname.match(/\/annual\/(\d{4})\.(pdf|json)$/);
        if (annualP) {
          const d = await annualData(env, pid, Number(annualP[1]));
          if (!d) return new Response("Not found", { status: 404 });
          await log(env.DB, actor, "annual.downloaded", "parties", pid, { note: `${annualP[1]} ${annualP[2]}, by staff` });
          return annualP[2] === "json"
            ? new Response(annualJson(d), { headers: { "content-type": "application/json", "cache-control": "no-store" } })
            : new Response(annualPdf(d), { headers: { "content-type": "application/pdf", "cache-control": "no-store",
                "content-disposition": `inline; filename="${d.party.display_name}-${annualP[1]}-statement.pdf"` } });
        }
        if (url.pathname.endsWith("/team") && request.method === "POST") {
          const f = await request.formData();
          const problem = await revokeMember(env, actor, String(f.get("revoke") ?? ""));
          return partyView(env, admin, pid, problem ?? "");
        }
        if (url.pathname.endsWith("/narrative") && request.method === "POST") {
          const f = await request.formData();
          const text = String(f.get("text") ?? "").trim().slice(0, 8000);
          const txFor = String(f.get("transaction_id") ?? "").trim() || null;
          if (text.length < 20) {
            return partyView(env, admin, pid, "A narrative needs at least a sentence.");
          }
          await insert(env.DB, actor, "narrative.written", "narratives", id("nar"), {
            party_id: pid, transaction_id: txFor, kind: "source_of_funds", text, written_by: actor.id,
          }, { note: `${text.length} characters${txFor ? `, for ${txFor}` : ""}` });
          return Response.redirect(new URL(`/p/${pid}`, url).toString(), 303);
        }
        return partyView(env, admin, pid, url.searchParams.get("err") ?? "");
      }
      if (url.pathname.startsWith("/doc/")) {
        return serveDocument(env, actor, url.pathname.slice(5));
      }
      if (url.pathname === "/log") return auditView(env, admin);
      if (url.pathname === "/chain") return chainView(env, admin);
      if (url.pathname === "/providers") {
        return request.method === "POST"
          ? saveProvider(env, actor, admin, request)
          : providersView(env, admin);
      }
      if (url.pathname.startsWith("/t/")) {
        const txId = url.pathname.slice(3).split("/")[0];
        if (url.pathname.endsWith("/dossier")) {
          return dossierPage(env, admin, txId);
        }
        // A party's folder, for staff to send on: /t/:id/party/:pid/folder.zip | statement.pdf
        const roomPath = url.pathname.match(/\/party\/([^/]+)\/room$/);
        if (roomPath) return staffRoom(env, admin, actor, request, txId, roomPath[1]);
        const partyPath = url.pathname.match(/\/party\/([^/]+)\/(folder\.zip|statement\.pdf|certification\.pdf)$/);
        if (partyPath) {
          const [, pid, what] = partyPath;
          if (what !== "folder.zip") {
            const d = await folderData(env, txId, pid, "staff");
            if (!d) return new Response("Not found", { status: 404 });
            return new Response(statementPdf(d), { headers: { "content-type": "application/pdf",
              "content-disposition": `inline; filename="${d.tx.ref}-certification.pdf"`, "cache-control": "no-store" } });
          }
          const folder = await partyFolder(env, txId, pid, "staff");
          if (!folder) return new Response("Not found", { status: 404 });
          await log(env.DB, actor, "folder.downloaded", "transactions", txId, { note: `party ${pid}, by staff` });
          return new Response(folder.bytes, { headers: { "content-type": "application/zip",
            "content-disposition": `attachment; filename="${folder.name}"`, "cache-control": "no-store" } });
        }
        if (url.pathname.endsWith("/dossier.pdf")) {
          const pdf = await dossierPdfFor(env, txId);
          if (!pdf) return new Response("Not found", { status: 404 });
          return new Response(pdf.bytes, { headers: {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename="${pdf.name}"`,
            "cache-control": "no-store",
          } });
        }
        if (url.pathname.endsWith("/dossier/download")) {
          const bundle = await dossierBundle(env, txId);
          if (!bundle) return new Response("Not found", { status: 404 });
          await log(env.DB, actor, "dossier.downloaded", "transactions", txId,
                    { note: `${bundle.bytes.length} bytes` });
          return new Response(bundle.bytes, { headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${bundle.name}"`,
            "cache-control": "no-store",
          } });
        }
        if (url.pathname.endsWith("/upload") && request.method === "POST") {
          return upload(request, env, actor, { transactionId: txId }, `/t/${txId}`);
        }
        if (url.pathname.endsWith("/badges/mint") && request.method === "POST") {
          const f = await request.formData();
          const chainId = Number(f.get("chain")) === BADGE_CHAINS.rehearsal ? BADGE_CHAINS.rehearsal : BADGE_CHAINS.live;
          const r = await mintCertificates(env, actor, txId, chainId);
          const note = [r.minted.length ? `Minted ${r.minted.length}: ${r.minted.join("; ")}.` : "",
                        r.skipped.length ? `Skipped: ${r.skipped.join("; ")}.` : "", r.problem ?? ""].filter(Boolean).join(" ");
          return dossierPage(env, admin, txId, note || "Nothing to mint.");
        }
        if (url.pathname.endsWith("/clone") && request.method === "POST") {
          const made = await cloneTransaction(env, actor, txId, { requestedBy: "admin" });
          if ("problem" in made) return detail(env, admin, txId, made.problem);
          return Response.redirect(new URL(`/t/${made.id}`, url).toString(), 303);
        }
        if (url.pathname.endsWith("/summary") && request.method === "POST") {
          const f = await request.formData();
          const text = String(f.get("summary") ?? "").trim().slice(0, 4000);
          const before = await env.DB.prepare("SELECT summary FROM transactions WHERE id = ?").bind(txId).first<any>();
          await update(env.DB, actor, "transaction.summary", "transactions", txId,
            { summary: text || null }, { summary: before?.summary ?? null }, { note: `${text.length} characters` });
          return Response.redirect(new URL(`/t/${txId}`, url).toString(), 303);
        }
        if (url.pathname.endsWith("/dossier/anchor") && request.method === "POST") {
          return anchorNow(env, actor, txId, request);
        }
        if (url.pathname.endsWith("/dossier/seal") && request.method === "POST") {
          return sealNow(env, actor, txId, request);
        }
        if (url.pathname.endsWith("/bank/payments.csv")) {
          const csv = await paymentsCsv(env, txId);
          const row = await env.DB.prepare("SELECT ref FROM transactions WHERE id = ?").bind(txId).first<any>();
          await log(env.DB, actor, "bank.payments_downloaded", "transactions", txId);
          return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${row?.ref ?? txId}-payments.csv"`, "cache-control": "no-store" } });
        }
        if (url.pathname.endsWith("/bank") && request.method === "POST") {
          return bankAction(request, env, admin, actor, txId);
        }
        if (url.pathname.endsWith("/agreements/remind") && request.method === "POST") {
          const f = await request.formData();
          const partyId = String(f.get("party") ?? "");
          const row = (await agreementsFor(env, txId)).find((a) => a.partyId === partyId);
          if (!row) return detail(env, admin, txId, "No such party on this transaction.");
          await agreementRequested(env, actor, txId, partyId, row.state === "stale");
          await log(env.DB, actor, "agreement.reminded", "transactions", txId, { note: `${row.name} asked to sign${row.state === "stale" ? " again" : ""}` });
          return detail(env, admin, txId, "", `${row.name} has been emailed to sign${row.state === "stale" ? " again" : ""}.`);
        }
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
        if (url.pathname.endsWith("/mandate") && request.method === "POST") {
          return askForMandate(env, actor, txId, request);
        }
        if (url.pathname.endsWith("/mandate/withdraw") && request.method === "POST") {
          const f = await request.formData();
          const problem = await revokeMandate(env, actor,
            String(f.get("mandate") ?? ""), String(f.get("reason") ?? ""));
          if (problem) return detail(env, { name: "" }, txId, problem);
          return Response.redirect(new URL(`/t/${txId}`, url).toString(), 302);
        }
        if (url.pathname.endsWith("/chain") && request.method === "POST") {
          return setChainSettings(env, actor, txId, request);
        }
        if (url.pathname.endsWith("/screenall") && request.method === "POST") {
          const out = await screenAll(env, actor, txId);
          return detail(env, admin, txId, out.problem
            ? `Nominis could not answer: ${out.problem}`
            : "");
        }
        if (url.pathname.endsWith("/screen") && request.method === "POST") {
          const f = await request.formData();
          const tx = await env.DB.prepare(
            "SELECT chain_id FROM transactions WHERE id = ?").bind(txId).first<any>();
          const address = String(f.get("address") ?? "");
          const verdict = String(f.get("verdict") ?? "") === "clear" ? "clear" : "flagged";
          // Always create the row through the provider first, so the record
          // says which provider was asked even when it was a person.
          const screenId = await screenAddress(env, actor, {
            address, chainId: tx?.chain_id ?? 1, transactionId: txId,
          });
          await recordVerdict(env, actor, screenId, {
            verdict, findings: String(f.get("findings") ?? "").trim(), months: 3,
          });
          return Response.redirect(new URL(`/t/${txId}`, url).toString(), 302);
        }
        if (url.pathname.endsWith("/attest") && request.method === "POST") {
          const f = await request.formData();
          const problem = await grantAttestation(env, actor, {
            destinationId: String(f.get("destination") ?? ""),
            custodian: String(f.get("custodian") ?? ""),
            basis: String(f.get("basis") ?? ""),
            evidence: f.get("evidence") as File | null,
          });
          const u = new URL(`/t/${txId}`, url);
          if (problem) u.searchParams.set("err", problem);
          return Response.redirect(u.toString(), 303);
        }
        if (url.pathname.endsWith("/attest/revoke") && request.method === "POST") {
          const f = await request.formData();
          const problem = await revokeAttestation(env, actor,
            String(f.get("attestation") ?? ""), String(f.get("reason") ?? ""));
          const u = new URL(`/t/${txId}`, url);
          if (problem) u.searchParams.set("err", problem);
          return Response.redirect(u.toString(), 303);
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
        return detail(env, admin, txId, url.searchParams.get("err") ?? "");
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
  return page("Pipeline", `${await attention(env)}${board(results ?? [])}`,
              { nav: nav("/", admin.name) });
}

/**
 * Everything waiting on a member of staff, with a link to where it is done.
 *
 * The board shows where each transaction is; it does not say what is stuck on
 * us. Notifications say so by email, but an email is read once, and the
 * person who reads it may not be the one who acts. This is the same list,
 * always current, at the top of the first page anyone opens.
 */
async function attention(env: Env): Promise<string> {
  const q = async (sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(sql).bind(...binds).all<any>()).results ?? [];

  const [enquiries, kyc, toLock, settledOpen, live, cantSign] = await Promise.all([
    q(`SELECT id, name, created_at FROM enquiries WHERE status = 'new' ORDER BY created_at`),
    q(`SELECT p.id, p.display_name, p.kyc_submitted_at FROM parties p
        WHERE p.kyc_submitted_at IS NOT NULL
          AND COALESCE((SELECT status FROM verifications v WHERE v.party_id = p.id
                         ORDER BY v.created_at DESC LIMIT 1), 'pending') = 'pending'
        ORDER BY p.kyc_submitted_at`),
    q(`SELECT d.id, d.confirmed_at, y.display_name, t.id AS tx, t.ref
         FROM destinations d
         JOIN participations p ON p.id = d.participation_id
         JOIN parties y ON y.id = p.party_id
         JOIN transactions t ON t.id = p.transaction_id
        WHERE d.status = 'confirmed' ORDER BY d.confirmed_at`),
    q(`SELECT t.id, t.ref, t.name FROM transactions t
        WHERE t.status = 'settled'
          AND NOT EXISTS (SELECT 1 FROM dossier_seals s WHERE s.transaction_id = t.id)`),
    q(`SELECT id, ref, name, status, submitted_at FROM transactions
        WHERE status IN ('draft', 'awaiting_parties', 'kyc')`),
    q(`SELECT d.proof_unavailable_at, y.display_name, t.id AS tx, t.ref
         FROM destinations d
         JOIN participations p ON p.id = d.participation_id
         JOIN parties y ON y.id = p.party_id
         JOIN transactions t ON t.id = p.transaction_id
        WHERE d.proof_unavailable_at IS NOT NULL AND d.proved_at IS NULL
          AND t.status NOT IN ('settled', 'closed', 'abandoned', 'declined')
          AND NOT EXISTS (SELECT 1 FROM address_attestations a
                           WHERE a.destination_id = d.id AND a.revoked_at IS NULL
                             AND lower(a.address) = lower(d.address))
        ORDER BY d.proof_unavailable_at`),
  ]);

  // Gate-green transactions nobody has moved on. The gate is the expensive
  // check, so it runs only for transactions that could be waiting on it.
  const toMove: { id: string; ref: string; name: string; status: string }[] = [];
  const toRelease = live.filter((t: any) => t.status === "draft" && t.submitted_at);
  for (const t of live.filter((t: any) => t.status !== "draft")) {
    const s = await assess(env, t.id, { onChain: true });
    if (s.ready) toMove.push(t);
  }

  const items: string[] = [];
  const li = (href: string, what: string, when?: string) =>
    items.push(`<li><a href="${href}">${what}</a>${when
      ? `<span class="muted"> — ${esc(String(when).slice(0, 16))}</span>` : ""}</li>`);
  for (const e of enquiries) li(`/e/${e.id}`, `New enquiry from <b>${esc(e.name)}</b>`, e.created_at);
  for (const p of kyc) li(`/p/${p.id}`, `Decide <b>${esc(p.display_name)}</b>'s verification`, p.kyc_submitted_at);
  for (const t of toRelease) li(`/t/${t.id}`, `Release <b>${esc(t.ref)}</b> — the sender has submitted it`, t.submitted_at);
  for (const d of cantSign) li(`/t/${d.tx}`, `Review <b>${esc(d.display_name)}</b>'s address on ${esc(d.ref)} — they cannot sign from it`, d.proof_unavailable_at);
  for (const d of toLock) li(`/t/${d.tx}`, `Lock <b>${esc(d.display_name)}</b>'s confirmed details on ${esc(d.ref)}`, d.confirmed_at);
  for (const t of toMove) li(`/t/${t.id}`, `Move <b>${esc(t.ref)}</b> on — every gate line is met (now ${esc(t.status.replace(/_/g, " "))})`);
  for (const t of settledOpen) li(`/t/${t.id}/dossier`, `Seal the dossier for <b>${esc(t.ref)}</b> — every payment has landed`);

  return `<section class="panel attention" style="max-width:none;margin-bottom:22px;border-left:4px solid ${
      items.length ? "var(--accent)" : "#1B7F4B"}">
    <h2 style="margin-top:0">Needs attention${tip("Everything waiting on a member of staff, with a link to where it is done. Empty means nothing is waiting on us.")}</h2>
    ${items.length
      ? `<ul style="margin:0;padding-left:18px;line-height:1.9">${items.join("")}</ul>`
      : `<p class="good" style="margin:0">Nothing is waiting on us.</p>`}
  </section>`;
}

/** A file, against a party or a transaction. Same store as the client uploads. */
async function upload(request: Request, env: Env, actor: Actor,
                      about: { partyId?: string; transactionId?: string },
                      back: string): Promise<Response> {
  const f = await request.formData();
  const kind = String(f.get("kind") ?? "").trim().replace(/[^a-z0-9_]/gi, "_").toLowerCase() || "other";
  const label = String(f.get("label") ?? "").trim().slice(0, 160) || undefined;
  const shared = f.get("shared") === "1";
  try {
    await store(env, actor, f.get("file") as File, { kind, label, shared, ...about });
    return Response.redirect(new URL(back, request.url).toString(), 303);
  } catch (err) {
    if (err instanceof DocumentProblem) {
      const u = new URL(back, request.url);
      u.searchParams.set("err", err.message);
      return Response.redirect(u.toString(), 303);
    }
    throw err;
  }
}

/** The upload form staff see on a party or a transaction page. */
function uploadForm(action: string, kinds: [string, string][]): string {
  return `<form method="post" action="${esc(action)}" enctype="multipart/form-data" class="upload"
      style="margin-top:14px;padding-top:12px;border-top:1px solid #E6EAF0">
    <div class="row" style="align-items:flex-end;gap:12px;flex-wrap:wrap">
      <div><label for="uk">What it is</label>
        <select id="uk" name="kind">${kinds.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select></div>
      <div style="flex:1;min-width:180px"><label for="ul">Label <span class="muted">(optional)</span></label>
        <input id="ul" name="label" placeholder="Themis report, 9 Sep 2026"></div>
      <div><label for="uf">File</label>
        <input id="uf" name="file" type="file" accept="${ACCEPTED}" required></div>
      <button class="go">Upload</button>
    </div>
    ${action.startsWith("/p/") ? `<label class="check" style="margin-top:8px"><input type="checkbox" name="shared" value="1" style="width:auto">
      Share with the party — include it in the folder they download${tip("Their own uploads are always theirs. A report we add about them goes into their folder only if you tick this — some reports carry third-party information they have no right to.")}</label>` : ""}
    <p class="muted" style="margin:8px 0 0">PDF or a photograph, up to 15MB. Fingerprinted as it
      arrives and added to the dossier; it cannot be removed afterwards.</p>
  </form>`;
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
    <label for="fb">Our fee</label>
    <div class="row" style="margin-top:0">
      <input id="fb" name="fee_bps" value="100" inputmode="numeric"
             style="max-width:120px" aria-describedby="fbsays">
      <span id="fbsays" class="muted">basis points — <b>1%</b></span>
    </div>
    <p class="muted">A basis point is a hundredth of a percent: 100 is 1%,
      50 is 0.5%, 250 is 2.5%. Entered this way so a fee like 0.75% is 75,
      with no decimal point to lose.</p>
    <script>
    (function () {
      var box = document.getElementById("fb"), says = document.getElementById("fbsays");
      // Say the percentage back as it is typed, so nobody has to do the sum
      // in their head on a live transaction.
      function show() {
        var n = Number(box.value);
        says.innerHTML = !box.value.trim() ? "basis points"
          : !isFinite(n) || n < 0 ? "basis points — <b>not a number</b>"
          : n >= 10000 ? "basis points — <b>that is 100% or more</b>"
          : "basis points — <b>" + String(+(n / 100).toFixed(4)) + "%</b>";
      }
      box.addEventListener("input", show); show();
    })();
    </script>

    <h2>Agency</h2>
    <p class="muted" id="agencyfiat" hidden>Paragraph 2(b) is only available to
      an agent acting for one side. Recorded per transaction so it is a
      documented fact rather than a claim.</p>
    <p class="muted" id="agencycrypto" hidden>On this type the funds never reach
      us — the sender signs every transfer from their own wallet straight to
      each recipient — so the commercial agent exemption is not in question and
      is not relied on. This is recorded because who engaged us is worth
      knowing, not because anything turns on it.</p>
    <label for="af">Acting for</label>
    <select id="af" name="acting_for">
      <option value="">Not decided</option><option value="payer">The payer</option><option value="payee">The payee</option>
    </select>

    <div class="row"><button class="go">Create transaction</button>
      <a href="/" class="muted">Cancel</a></div>
  </form>
  <script>
  (function () {
    // The exemption belongs to the fiat legs. Claiming it where no payment
    // service is provided invites a reviewer to test whether it applies, when
    // the stronger answer is that the question does not arise.
    var inn = document.getElementById("i"), out = document.getElementById("o");
    var conv = document.querySelector("[name=converts]");
    var fiat = document.getElementById("agencyfiat");
    var crypto_ = document.getElementById("agencycrypto");
    function show() {
      var anyFiat = inn.value === "fiat" || out.value === "fiat";
      fiat.hidden = !anyFiat;
      crypto_.hidden = anyFiat;
    }
    [inn, out, conv].forEach(function (el) {
      if (el) el.addEventListener("change", show);
    });
    show();
  })();
  </script>`, { nav: nav("/new", admin.name) });
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

  // The form offers only valid options, so a bad value here means something
  // other than the form is posting — and a database CHECK failing produces a
  // 500 with nothing useful in it. Say what was wrong instead.
  const oneOf = (key: string, allowed: string[]) =>
    allowed.includes(s(key)) ? null
      : `${key.replace("_", " ")} must be one of: ${allowed.join(", ")}.`;
  const wrong = oneOf("inbound", ["fiat", "crypto"])
    ?? oneOf("outbound", ["fiat", "crypto"])
    ?? (s("acting_for") ? oneOf("acting_for", ["payer", "payee"]) : null);
  if (wrong) return newForm(admin, `<div class="err">${esc(wrong)}</div>`);

  let gross: number | null = null;
  if (s("gross")) {
    try { gross = parse(s("gross"), decimalsIn); }
    catch (e) { return newForm(admin, `<div class="err">${esc((e as Error).message)}</div>`); }
  }

  const txId = id("tx");
  const ref = await nextRef(env.DB);
  await insert(env.DB, actor, "transaction.created", "transactions", txId, {
    ref, name: s("name"), detail: s("detail") || null,
    inbound: s("inbound"), outbound: s("outbound"),
    // A checkbox is absent when unchecked, so presence would be enough — but
    // "0" and "false" are present and truthy, and reading either as yes would
    // silently make a non-converting transaction a converting one. That
    // changes who executes it, so it is worth being explicit.
    converts: ["", "0", "false", "off", "no"].includes(s("converts").toLowerCase())
      ? 0 : 1,
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

async function detail(env: Env, admin: { name: string }, txId: string,
                      error = "", bankNote = ""): Promise<Response> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(txId).first<Record<string, any>>();
  if (!t) return new Response("Not found", { status: 404 });

  const [liveMandate, pastMandates] = await Promise.all([
    standingMandate(env, txId), mandateHistory(env, txId),
  ]);
  const nominisOn = nominis.active(env);

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
    ? `<table><tr><th>Who</th><th>Role</th><th>Invited</th><th>Their dossier${tip("Each party's Peaceful Enjoyment dossier: the Counterparty Certification for their part of the transaction, their record with proofs, and their documents. The same thing they download from their account; download it here to send on.")}</th></tr>` +
      people!.map((p) => `<tr><td><a href="/p/${esc(p.party_id)}">${esc(p.display_name)}</a>
        <div class="muted">${esc(p.email)}</div></td>
        <td><span class="tag">${esc(p.role)}</span></td>
        <td class="muted">${esc(p.invited_at ?? "not yet")}</td>
        <td class="muted" style="white-space:nowrap"><a href="/t/${esc(txId)}/party/${esc(p.party_id)}/certification.pdf" target="_blank">Certification</a>
          &middot; <a href="/t/${esc(txId)}/party/${esc(p.party_id)}/folder.zip">Folder</a>
          &middot; <a href="/t/${esc(txId)}/party/${esc(p.party_id)}/room">Data room</a></td></tr>`).join("") + `</table>`
    : `<p class="muted">Nobody yet. Send the sender a start link and they will
        tell us who is involved.</p>`;

  const state = await assess(env, txId, { onChain: true });
  const gate = `
    <h2>Readiness</h2>
    <div class="panel"><table>
      ${state.checks.map((c) => `<tr>
        <td style="width:26px">${c.met
          ? '<span class="good" title="met">&#10003;</span>'
          : '<span class="warn" title="not yet">&#8212;</span>'}</td>
        <td><strong>${esc(c.label)}</strong>${gateTip(c.label)}<div class="muted">${esc(c.detail)}</div></td>
        <td class="muted">${esc(c.at ?? "")}</td></tr>`).join("")}
    </table>
    <p style="margin-bottom:0" class="${state.ready ? "good" : "muted"}">${state.ready
      ? "Every line is met. Move it on below — first to kyc, then to ready."
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

  // Screening, for a crypto transaction. Every address on it, in one place,
  // because a verdict recorded against an address nobody can find is not a
  // record anybody will read later.
  let screening = "";
  if (t.inbound === "crypto" || t.outbound === "crypto") {
    const chainId = railFor(t as any).chainId;
    const addrs: { address: string; role: string }[] = [];
    const { results: sw } = await env.DB.prepare(
      "SELECT address FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL").bind(txId).all<any>();
    for (const w of sw ?? []) addrs.push({ address: w.address, role: "sending" });
    for (const p of (people ?? []).filter((x) => x.role === "recipient")) {
      const d = await env.DB.prepare(
        "SELECT address FROM destinations WHERE participation_id = ? AND kind = 'wallet'")
        .bind(p.participation_id).first<any>();
      if (d?.address) addrs.push({ address: d.address, role: p.display_name });
    }
    if (t.fee_wallet) addrs.push({ address: t.fee_wallet, role: "our fee" });

    const rows = await Promise.all(addrs.map(async (a) => {
      const st = await standingScreen(env, a.address, chainId);
      return { ...a, st };
    }));

    screening = `
      <h2>Screening</h2>
      <div class="panel" style="max-width:none">
        ${nominisOn ? `<form method="post" action="/t/${esc(t.id)}/screenall">
            <button class="go" type="submit">Screen every address with Nominis</button>
            <span class="muted">One call for all of them. A machine verdict
              lasts thirty days; a considered one lasts three months.</span>
          </form>`
          : `<p class="muted">Nominis is not configured, so screening is by hand.
             Set NOMINIS_API_KEY and this becomes one button.</p>`}
        ${rows.length ? `<table>
          <tr><th>Address</th><th>Verdict</th><th>Findings</th><th></th></tr>
          ${rows.map((r) => `<tr>
            <td>${esc(r.role)}<div class="muted log">
              <a href="${esc(railFor(t as any).explorer.address(r.address))}" target="_blank"
                 rel="noopener">${esc(r.address)}</a></div></td>
            <td><span class="tag">${esc(r.st?.verdict ?? "not screened")}</span></td>
            <td class="muted">${esc(r.st?.findings ?? "")}</td>
            <td>
              <form method="post" action="/t/${esc(txId)}/screen">
                <input type="hidden" name="address" value="${esc(r.address)}">
                <input name="findings" placeholder="What the check said"
                  style="max-width:220px">
                <button class="plain" name="verdict" value="clear">Clear</button>
                <button class="plain" name="verdict" value="flagged">Flag</button>
              </form></td></tr>`).join("")}
        </table>
        <p class="muted" style="margin-bottom:0">Tether's blacklist is read live and
          says whether an address <em>can</em> receive. This says whether it
          <em>should</em>. Both, or neither is worth much.</p>`
        : `<p class="muted">No addresses yet.</p>`}
      </div>`;
  }

  const dests = await forTransaction(env, txId);
  const attestations = await attestationsFor(env, txId);
  const proofCell = (d: any): string => {
    if (d.id && d.kind === "bank" && (d.iban || d.account_number)) {
      if (d.proved_at) return `<div class="good" style="font-size:13px">Proved by penny test</div>`;
      if (d.status === "draft") return `<div class="muted" style="font-size:13px">Not confirmed by the recipient yet</div>`;
      return `<div class="muted" style="font-size:13px">${d.penny_code
          ? `Penny sent ${esc(String(d.penny_sent_at).slice(0, 16))} — reference <code>${esc(pennyReference(d.penny_code))}</code>${
              d.penny_attempts >= 3 ? ' <span class="bad">— three wrong codes</span>' : ""}`
          : "Not yet proved"}</div>
        <form method="post" action="/t/${esc(txId)}/bank" style="margin-top:6px">
          <input type="hidden" name="action" value="penny"><input type="hidden" name="destination" value="${esc(d.id)}">
          <button class="plain small">${d.penny_code ? "Send a fresh penny" : "Send the penny"}</button>${tip("Generates a six-character code and shows the reference to put on a 0.01 payment from the client mandated account to this account. Press it after you have made the payment — the recipient is emailed to watch for it and types the code from their statement to prove the account is theirs.")}
        </form>`;
    }
    if (!d.id || d.kind !== "wallet" || !d.address) return "";
    if (d.proved_at) return `<div class="good" style="font-size:13px">Proved by signature</div>`;
    const live = attestations.find((a) => a.destination_id === d.id && !a.revoked_at
      && a.address.toLowerCase() === String(d.address).toLowerCase());
    if (live) return `<div class="warn" style="font-size:13px">Accepted without signature —
        ${esc(live.custodian)} deposit address${tip("Accepted on evidence by a member of staff rather than proved by the key. The dossier says so in these words. Screening, locking and the dust test still apply.")}
        <div class="muted" style="font-weight:400">${esc(live.granted_at.slice(0, 16))} — ${esc(live.basis)}${
          live.evidence_artefact ? ` — <a href="/doc/${esc(live.evidence_artefact)}">evidence</a>` : ""}</div>
        <form method="post" action="/t/${esc(txId)}/attest/revoke" class="row" style="margin-top:6px;gap:6px">
          <input type="hidden" name="attestation" value="${esc(live.id)}">
          <input name="reason" placeholder="Why it is withdrawn" style="max-width:220px" required>
          <button class="plain">Revoke</button></form></div>`;
    const asked = d.proof_unavailable_at
      ? `<div class="bad" style="font-size:13px">Recipient says they cannot sign${
          d.proof_unavailable_note ? `: <span style="font-weight:400">“${esc(d.proof_unavailable_note)}”</span>` : ""}
          <span class="muted" style="font-weight:400"> — ${esc(String(d.proof_unavailable_at).slice(0, 16))}</span></div>`
      : `<div class="muted" style="font-size:13px">Not yet proved</div>`;
    if (d.status === "draft") return asked;
    return `${asked}<details${d.proof_unavailable_at ? " open" : ""} style="margin-top:6px">
      <summary style="cursor:pointer;font-size:13px;font-weight:600">Accept without a signature${tip(GATE_TIPS_PROVED)}</summary>
      <form method="post" action="/t/${esc(txId)}/attest" enctype="multipart/form-data" style="margin-top:6px">
        <input type="hidden" name="destination" value="${esc(d.id)}">
        <label>Custodian <input name="custodian" placeholder="Kraken" required style="max-width:200px"></label>
        <label>What you saw, and how it ties this address to ${esc(d.display_name)}
          <textarea name="basis" rows="2" required minlength="20"
            placeholder="Screenshot of the Kraken deposit page for USDT (ERC-20), account in the recipient's legal name, showing this address"></textarea></label>
        <label>Evidence file <input name="evidence" type="file" accept="${ACCEPTED}" required></label>
        <div class="row"><button class="plain">Accept on this evidence, under my name</button></div>
        <p class="muted" style="font-size:12.5px;margin:6px 0 0">Prefer a wallet they control. Only do this
          when that is not possible, and never on a recipient's word alone.</p>
      </form></details>`;
  };
  const destinations = dests.length ? `
    <h2>Where the money goes</h2>
    <div class="panel" style="max-width:none"><table>
      <tr><th>Recipient</th><th>Details</th><th>Proof</th><th>State</th><th></th></tr>
      ${dests.map((d) => `<tr>
        <td>${esc(d.display_name)}<div class="muted">${esc(d.email)}</div></td>
        <td><pre style="white-space:pre-wrap;font:inherit;margin:0;font-size:13.5px">${
          d.id ? esc(describeDestination(d as any)) : '<span class="muted">nothing yet</span>'}</pre></td>
        <td style="max-width:360px">${proofCell(d)}</td>
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
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <h1>${esc(t.ref)} — ${esc(t.name)}</h1>
    <p><a href="/t/${esc(t.id)}/dossier">Dossier</a> —
       the whole record, and the hash that proves it —
       <a href="/t/${esc(t.id)}/dossier/download">download it</a>${["settled", "closed"].includes(String(t.status))
         ? ` — <form method="post" action="/t/${esc(t.id)}/clone" style="display:inline"><button class="plain small" type="submit">Run it again</button></form>${tip("Clone this distribution: same recipients and shares, addresses and proofs carried over as confirmed (you screen and lock again), chain settings kept, amount blank. It arrives submitted and ready to release.")}`
         : ""}</p>
    ${await txDocuments(env, t.id)}
    ${await agreementsPanel(env, t, bankNote)}
    ${await bankPanel(env, t, bankNote)}
    <details class="panel"${t.summary ? "" : " open"}>
      <summary><strong>Executive summary</strong>${t.summary ? "" : ' — <span class="muted">not written yet</span>'}${tip("A paragraph a bank's compliance officer can read first: what this transaction is, who is paying whom and why. It opens the dossier PDF and appears in every party's Counterparty Certification. It is a fact in the record; each save is logged.")}</summary>
      <form method="post" action="/t/${esc(t.id)}/summary">
        <textarea name="summary" rows="5" maxlength="4000" placeholder="Distribution of the proceeds of … by … to … recipients, agreed on …">${esc(t.summary ?? "")}</textarea>
        <div class="row"><button class="plain">Save the summary</button></div>
      </form>
    </details>
    ${mandatePanel(t.id, liveMandate, pastMandates)}
    ${isOnChain(t as any) ? chainSettingsPanel(t) : ""}
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
      ${kv("Acting for", (t.acting_for
        ? `The ${esc(t.acting_for)}`
        : '<span class="muted">not decided</span>') +
        (t.inbound === "fiat" || t.outbound === "fiat"
          ? ' <span class="muted">— one side only, for the commercial agent' +
            ' exemption</span>'
          : ' <span class="muted">— recorded for the file; the funds never' +
            ' reach us on this type, so no exemption is relied on</span>'))}
      ${t.detail ? kv("Notes", esc(t.detail)) : ""}
    </table></div>

    <h2>Who is on it</h2>
    <div class="panel">${roster}</div>
    ${startForm}${releaseForm}

    ${splitForm}
    ${gate}
    ${screening}
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
  if (to === "ready") await readyToSend(env, actor, txId);
  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}

async function auditView(env: Env, admin: { name: string }): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT at, actor_kind, actor_id, action, entity_kind, entity_id, note
       FROM audit_log ORDER BY id DESC LIMIT 300`).all<any>();
  const names = await adminNames(env);
  return page("Audit log", `<h1>Audit log</h1>
    <p class="muted">Append-only. Nothing in this table is ever changed or removed.</p>
    <div class="panel" style="max-width:none"><div class="scroll"><table class="log">
      <tr><th>When</th><th>Who</th><th>What</th><th>On</th><th>Note</th></tr>
      ${(results ?? []).map((e) => `<tr><td>${esc(e.at)}</td>
        <td>${esc(names[e.actor_id] ?? e.actor_kind)}</td><td>${esc(e.action)}</td>
        <td>${esc(e.entity_kind)} ${esc(e.entity_id)}</td><td>${esc(e.note ?? "")}</td></tr>`).join("")}
    </table></div></div>`, { nav: nav("/log", admin.name) });
}

/**
 * Are we able to see the chain, and does everyone we ask see the same one?
 *
 * A confirmation is only worth what the endpoint behind it is worth, so the
 * state of those endpoints should be visible before a settlement rather than
 * discovered during one. Heads a block or two apart are normal — the chain
 * moves while the page loads. A different chain id, or a gap of any size, is
 * not.
 */
async function chainView(env: Env, admin: { name: string }): Promise<Response> {
  const seen = await Promise.all(RAILS.map(async (r) => {
    const rail = railByKey(r.key)!;
    return { key: r.key, name: rail.name, rows: await rail.health(env) };
  }));

  const block = seen.map((n) => {
    const heads = n.rows.filter((r) => r.ok && r.height !== null).map((r) => r.height!);
    const spread = heads.length > 1 ? Math.max(...heads) - Math.min(...heads) : 0;
    const wrong = n.rows.filter((r) => r.wrongNetwork);
    const answering = n.rows.filter((r) => r.ok).length;

    const verdict = wrong.length
      ? `<span class="bad">An endpoint is on the wrong network — do not settle</span>`
      : answering === 0 ? `<span class="bad">Nothing is answering</span>`
      : answering === 1 ? `<span class="warn">One endpoint only — no second opinion</span>`
      : spread > 3 ? `<span class="warn">Heads ${spread} blocks apart</span>`
      : `<span class="good">${answering} endpoints agree on the head</span>`;

    return `<div class="panel"><h2>${esc(n.name)} <span class="muted">${esc(n.key)}</span></h2>
      <p>${verdict}</p>
      <table class="log">
        <tr><th>Endpoint</th><th>Answering</th><th>Head</th></tr>
        ${n.rows.map((r) => `<tr><td>${esc(r.name)}</td>
          <td>${r.ok ? (r.wrongNetwork ? '<b class="bad">wrong network</b>' : "yes")
                     : esc("no — " + (r.note ?? "no answer"))}</td>
          <td>${r.height === null ? "&mdash;" : r.height.toLocaleString("en-GB")}</td></tr>`).join("")}
      </table></div>`;
  }).join("");

  const providers = [
    ["Nominis", "wallet screening", nominis.active(env),
     "NOMINIS_API_KEY", "Verdicts come back automatically; without it, by hand."],
    ["Themis", "identity checks", true, "—",
     "Checked by one of us and the conclusion recorded here."],
    ["Sumsub", "identity checks", Boolean(env.SUMSUB_TOKEN && env.SUMSUB_SECRET),
     "SUMSUB_TOKEN, SUMSUB_SECRET", "Written and switched off."],
    ["Resend", "email", Boolean(env.RESEND_API_KEY), "RESEND_API_KEY",
     "Invitations and notifications."],
  ] as const;

  return page("Chain connection", `<h1>Chain connection</h1>
    <div class="panel">
      <h2>Providers</h2>
      <table class="log">
        <tr><th>Provider</th><th>For</th><th>State</th><th>Notes</th></tr>
        ${providers.map(([name, what, on, key, note]) => `<tr>
          <td>${esc(name)}</td><td>${esc(what)}</td>
          <td>${on ? `<span class="good">on</span>`
                   : `<span class="muted">off — set ${esc(key)}</span>`}</td>
          <td>${esc(note)}</td></tr>`).join("")}
      </table>
    </div>
    <p class="muted">A confirmation is cross-checked against every endpoint listed here.
      Where they disagree, the transaction is not treated as confirmed.
      The primary and secondary are our own keys; the public node is a free
      fallback and should never be the only one answering before a settlement.</p>
    ${block}`, { nav: nav("/chain", admin.name) });
}

/**
 * The chain a crypto transaction runs on, the token, and where our fee goes.
 *
 * These three were readable from the start and writable nowhere, so every
 * transaction carried nulls: the token silently defaulted to USDT on mainnet
 * and the fee had no destination at all. Set deliberately, per transaction —
 * a fee address that lives in code is a fee address nobody reviews.
 */
async function setChainSettings(env: Env, actor: Actor, txId: string,
                                request: Request): Promise<Response> {
  const f = await request.formData();
  const before = await env.DB.prepare(
    "SELECT rail, chain_id, token_address, fee_wallet FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!before) return new Response("No such transaction", { status: 404 });

  // The rail by key; or, from the rehearsal script and anything else still
  // speaking the old dialect, an Ethereum chain id.
  const legacyChain = Number(f.get("chain_id") ?? 0) || null;
  const key = String(f.get("rail") ?? "").trim() || (legacyChain ? `eth:${legacyChain}:usdt` : "");
  const choice = railChoice(key);
  if (!choice) return detail(env, { name: "" }, txId, "Choose a rail.");
  const rail = railByKey(key)!;

  const token = String(f.get("token_address") ?? "").trim();
  const fee = String(f.get("fee_wallet") ?? "").trim();
  let tokenOk: string | null = null;
  if (choice.needsToken && token) {
    const n = rail.normalise(token);
    if (!n.ok) return detail(env, { name: "" }, txId, `token address: ${n.why}`);
    tokenOk = n.address;
  }
  let feeOk: string | null = null;
  if (fee) {
    const n = rail.normalise(fee);
    if (!n.ok) return detail(env, { name: "" }, txId, `fee wallet: ${n.why}`);
    feeOk = n.address;
  }

  await update(env.DB, actor, "transaction.chain_set", "transactions", txId, {
    rail: key,
    chain_id: choice.chainId,
    token_address: choice.needsToken ? tokenOk : null,
    fee_wallet: feeOk,
  }, before, { note: `${rail.name}, fee to ${feeOk || "nowhere"}` });

  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}

/**
 * Ask the sender for authority to prepare their transaction for them.
 *
 * Nothing changes until they sign it. The request is recorded either way, so
 * a mandate that was asked for and declined leaves a trace.
 */
async function askForMandate(env: Env, actor: Actor, txId: string,
                             request: Request): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT t.ref, y.id AS party_id, y.display_name
       FROM transactions t
       JOIN participations p ON p.transaction_id = t.id AND p.role = 'sender'
       JOIN parties y ON y.id = p.party_id
      WHERE t.id = ?`).bind(txId).first<any>();
  if (!row) {
    return detail(env, { name: "" }, txId,
      "There is no sender on this transaction yet, so there is nobody to ask.");
  }
  await requestMandate(env, actor, {
    transactionId: txId, partyId: row.party_id,
    senderName: row.display_name, ref: row.ref,
  });
  return Response.redirect(new URL(`/t/${txId}`, request.url).toString(), 302);
}

/** What staff see about acting for the sender. */
function mandatePanel(txId: string, live: MandateRow | null,
                      past: MandateRow[]): string {
  const waiting = past.find((m) => !m.signed_at && !m.revoked_at);

  const state = live
    ? `<p class="good">Signed by ${esc(live.signed_name ?? "")} on
         ${esc(live.signed_at ?? "")}. Anything you enter here is recorded as
         done on their behalf under that authority.</p>
       <form method="post" action="/t/${esc(txId)}/mandate/withdraw">
         <input type="hidden" name="mandate" value="${esc(live.id)}">
         <label for="wreason">Why it is being withdrawn</label>
         <input id="wreason" name="reason" placeholder="Sender asked us to stop">
         <button class="plain" type="submit">Withdraw it</button>
       </form>`
    : waiting
      ? `<p class="warn">Asked on ${esc(waiting.requested_at)} — waiting for the
           sender to sign it in their own account. Until they do, prepare
           nothing on their behalf.</p>`
      : `<p class="muted">You have no authority to prepare this transaction for
           the sender. Ask for it, and they will be shown the wording to sign
           when they next open their account.</p>
         <form method="post" action="/t/${esc(txId)}/mandate">
           <button class="go" type="submit">Ask the sender for authority</button>
         </form>`;

  const rows = past.filter((m) => m !== live).map((m) => `<tr>
      <td>${esc(m.requested_at)}</td>
      <td>${m.signed_at ? `signed by ${esc(m.signed_name ?? "")}`
            : m.revoked_at ? "withdrawn" : "waiting"}</td>
      <td>${esc(m.revoked_at ?? m.signed_at ?? "")}</td>
      <td>${esc(m.revoked_reason ?? "")}</td></tr>`).join("");

  return `<details class="panel"${live || waiting ? "" : ""}>
    <summary><strong>Acting for the sender</strong>${live
      ? ' — <span class="good">authorised</span>'
      : waiting ? ' — <span class="warn">asked, not yet signed</span>' : ""}</summary>
    <p class="muted">A sender who would rather not enter the detail themselves
      can ask us to do it. They sign a short authority first, and it goes into
      the dossier with everything else. It never covers moving money — every
      transfer is still made and signed by them.</p>
    ${state}
    ${rows ? `<h3>Earlier</h3><table class="log">
      <tr><th>Asked</th><th>What happened</th><th>When</th><th>Note</th></tr>
      ${rows}</table>` : ""}
  </details>`;
}

/** What can be configured here, and what each credential is for. */
const PROVIDERS: {
  key: string; name: string; what: string; label: string;
  second?: string; help: string;
}[] = [
  { key: "nominis", name: "Nominis", what: "Wallet screening", label: "API key",
    help: "Turns screening from a job into a button. Verdicts come back in " +
          "one call for every address on a transaction." },
  { key: "sumsub", name: "Sumsub", what: "Identity checks", label: "App token",
    second: "Secret key",
    help: "Automated KYC and KYB. Until this is on, Themis is used and the " +
          "conclusion is recorded here by one of us." },
  { key: "resend", name: "Resend", what: "Email", label: "API key",
    help: "Invitations and notifications. Without it, nothing is sent and " +
          "every attempt is logged as skipped." },
  { key: "eth_rpc", name: "Ethereum RPC", what: "Chain reads", label: "HTTPS endpoint",
    help: "The primary endpoint for confirming payments." },
  { key: "eth_rpc_2", name: "Ethereum RPC, second", what: "Chain reads",
    label: "HTTPS endpoint",
    help: "An independent second opinion. Confirmations must satisfy both." },
];

/**
 * Where staff manage credentials.
 *
 * A stored key is shown as its last four characters and nothing else. It can
 * be replaced or removed, never read back — including by the person who typed
 * it, who no longer needs it and might be reading over somebody's shoulder.
 */
async function providersView(env: Env, admin: { name: string },
                             notice = ""): Promise<Response> {
  const stored = await listSettings(env);
  const bySlug = new Map(stored.map((r) => [r.provider, r]));
  const noKey = !env.SETTINGS_KEY;

  const cards = PROVIDERS.map((p) => {
    const row = bySlug.get(p.key);
    const on = row?.enabled === 1;
    // A Worker secret still wins, and should be visible as the reason a
    // provider is on despite nothing being stored here.
    const fromSecret =
      (p.key === "nominis" && !row?.hint && Boolean(env.NOMINIS_API_KEY)) ||
      (p.key === "resend" && !row?.hint && Boolean(env.RESEND_API_KEY)) ||
      (p.key === "eth_rpc" && !row?.hint && Boolean(env.ETH_RPC_URL)) ||
      (p.key === "eth_rpc_2" && !row?.hint && Boolean(env.ETH_RPC_URL_2)) ||
      (p.key === "sumsub" && !row?.hint && Boolean(env.SUMSUB_TOKEN));

    return `<div class="panel">
      <h2>${esc(p.name)} <span class="muted">— ${esc(p.what)}</span></h2>
      <p class="muted">${esc(p.help)}</p>
      <table><tr><th>State</th><td>${
        fromSecret ? `<span class="good">on</span> <span class="muted">— set as a
            deployment secret, which takes precedence over anything here</span>`
        : on ? `<span class="good">on</span>`
        : row?.hint ? `<span class="warn">off</span> <span class="muted">— a key is
            stored but switched off</span>`
        : `<span class="muted">off — no credential</span>`}</td></tr>
        ${row?.hint ? `<tr><th>Stored key</th><td><span class="mono">${esc(row.hint)}</span>
          <span class="muted">set ${esc(row.updated_at)}</span></td></tr>` : ""}
        ${row?.second_hint ? `<tr><th>Second</th><td><span class="mono">${esc(row.second_hint)}</span></td></tr>` : ""}
        ${row?.checked_at ? `<tr><th>Last tried</th><td>${esc(row.checked_at)} —
          ${esc(row.checked_note ?? "")}</td></tr>` : ""}
      </table>
      <form method="post" action="/providers">
        <input type="hidden" name="provider" value="${esc(p.key)}">
        <label for="s-${esc(p.key)}">${esc(p.label)}${row?.hint ? " (replace)" : ""}</label>
        <div class="pw"><input id="s-${esc(p.key)}" name="secret" type="password"
          autocomplete="off" spellcheck="false" ${noKey ? "disabled" : ""}
          placeholder="${row?.hint ? "leave blank to keep the current one" : ""}"></div>
        ${p.second ? `<label for="t-${esc(p.key)}">${esc(p.second)}</label>
          <div class="pw"><input id="t-${esc(p.key)}" name="second" type="password"
            autocomplete="off" spellcheck="false" ${noKey ? "disabled" : ""}
            placeholder="${row?.second_hint ? "leave blank to keep it" : ""}"></div>` : ""}
        <div class="row">
          <button class="go" name="do" value="save" ${noKey ? "disabled" : ""}>Save</button>
          <button class="plain" name="do" value="${on ? "off" : "on"}">
            ${on ? "Switch off" : "Switch on"}</button>
          ${row?.hint ? `<button class="plain" name="do" value="clear">Remove the key</button>` : ""}
        </div>
      </form>
    </div>`;
  }).join("");

  return page("Providers", `<h1>Providers</h1>
    <p class="muted">Credentials for the services the platform uses. Stored
      encrypted, shown only as their last four characters, and never rendered
      back into a page.</p>
    ${notice ? `<div class="err">${esc(notice)}</div>` : ""}
    ${noKey ? `<div class="err"><strong>Credentials cannot be stored yet.</strong>
      A Worker secret called SETTINGS_KEY is what encrypts them, and it is not
      set. Until it is, providers can only be configured by deployment.</div>` : ""}
    ${cards}`, { nav: nav("/providers", admin.name) });
}

async function saveProvider(env: Env, actor: Actor, admin: { name: string },
                            request: Request): Promise<Response> {
  const f = await request.formData();
  const provider = String(f.get("provider") ?? "") as any;
  if (!PROVIDERS.some((p) => p.key === provider)) {
    return providersView(env, admin, "That is not a provider we configure here.");
  }
  const action = String(f.get("do") ?? "save");
  const secret = String(f.get("secret") ?? "").trim();
  const second = String(f.get("second") ?? "").trim();

  if (action === "clear") {
    await clearSetting(env, actor, provider);
    return providersView(env, admin);
  }
  const problem = await putSetting(env, actor, provider, {
    secret: secret || undefined,
    second: second || undefined,
    enabled: action === "on" ? true : action === "off" ? false : undefined,
  });
  return providersView(env, admin, problem ?? "");
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
    await recipientsInvited(env, actor, txId);
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

async function partyView(env: Env, admin: { name: string }, partyId: string,
                         error = ""): Promise<Response> {
  const p = await env.DB.prepare("SELECT * FROM parties WHERE id = ?")
    .bind(partyId).first<any>();
  if (!p) return new Response("Not found", { status: 404 });

  const docs = await documentsFor(env, partyId);
  const { results: narratives } = await env.DB.prepare(
    `SELECT n.*, t.ref FROM narratives n LEFT JOIN transactions t ON t.id = n.transaction_id
      WHERE n.party_id = ? ORDER BY n.created_at DESC`).bind(partyId).all<any>();
  const { results: onTx } = await env.DB.prepare(
    `SELECT t.id, t.ref FROM participations p JOIN transactions t ON t.id = p.transaction_id
      WHERE p.party_id = ? ORDER BY t.created_at DESC`).bind(partyId).all<any>();
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
      kv("Nationality", esc(countryName(p.nationality) || "—")) +
      kv("Resides in", esc(countryName(p.residence_country) || "—"));

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
    ${p.kind === "company" ? `<h2>Team${tip("People who may act for this organisation with their own logins: owner, approver (sends; must be verified in person), preparer (enters details), viewer (reads). The organisation's own login manages the team; staff can remove a member here.")}</h2>
    <div class="panel" style="max-width:none">${teamPanel(await membersOf(env, partyId), `/p/${partyId}/team`, { canManage: true })}</div>` : ""}

    ${(await yearsFor(env, partyId)).length ? `<h2>Annual statements${tip("Every payment this party sent or received through us in a year, with chain transactions, sealed roots, totals and our signature. The same document the party downloads from their account.")}</h2>
    <div class="panel"><div class="row" style="gap:8px;flex-wrap:wrap">${(await yearsFor(env, partyId)).map((y) =>
      `<a href="/p/${esc(partyId)}/annual/${y}.pdf" target="_blank"><button class="plain" type="button">${y} PDF</button></a>
       <a href="/p/${esc(partyId)}/annual/${y}.json"><button class="plain" type="button">${y} JSON</button></a>`).join("")}</div></div>` : ""}

    <h2>Source of funds and wealth${tip("The party's story in prose — where the money came from, referencing the documents on file. It goes into their Counterparty Certification and their record. Every version is kept: writing a new one does not erase the old, and the record shows both.")}</h2>
    <div class="panel">
      ${(narratives ?? []).length ? (narratives ?? []).map((n: any) => `<div class="fact" style="border-top:1px solid #E6EAF0;padding:10px 0">
          <div class="muted" style="font-size:12.5px">${esc(String(n.created_at).slice(0, 16))} — ${n.ref ? `for ${esc(n.ref)}` : "general"} — ${esc(n.written_by ?? "")}</div>
          <div style="white-space:pre-wrap">${esc(n.text)}</div></div>`).join("")
        : `<p class="muted">Nothing written yet.</p>`}
      <form method="post" action="/p/${esc(partyId)}/narrative" style="margin-top:10px">
        <label for="nt">${(narratives ?? []).length ? "A new version" : "The narrative"}</label>
        <textarea id="nt" name="text" rows="6" maxlength="8000" required
          placeholder="Funds derive from the sale of … completed on …, evidenced by the completion statement and bank statement on file. …"></textarea>
        <label for="ntx">About</label>
        <select id="ntx" name="transaction_id"><option value="">This party generally</option>
          ${(onTx ?? []).map((t: any) => `<option value="${esc(t.id)}">${esc(t.ref)} only</option>`).join("")}</select>
        <div class="row"><button class="plain">Record this narrative</button></div>
      </form>
    </div>

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
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
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

    <h2>Documents${tip("Everything the party sent, plus anything staff add — the Themis or other screening report goes here, before the decision, so it is in the dossier of every transaction this party is on.")}</h2>
    <div class="panel" style="max-width:none">${docList}
      <p class="muted">Each hash was taken as the file arrived, not from our copy —
         so it proves the file has not changed since.</p>
      ${uploadForm(`/p/${partyId}/upload`, [
        ["kyc_report", "Screening report (Themis or other)"],
        ["passport", "Passport or ID"], ["proof_of_address", "Proof of address"],
        ["company_register", "Company register extract"], ["other", "Other"]])}
    </div>
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
        ${t.inbound === "crypto" ? `
        <label for="rh">Transaction hash</label>
        <input id="rh" name="tx_hash" placeholder="0x…" spellcheck="false">
        <p class="muted">Checked against the chain — a hash that never landed, or
           landed and reverted, is refused.</p>`
        : `<label for="rf">Evidence — the credit advice, statement line or MT103</label>
        <input id="rf" name="file" type="file">`}
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
        <td>${l.txHash
          ? `<a href="${esc(railFor(t as any).explorer.tx(l.txHash))}" rel="noopener"
               target="_blank">${esc(l.txHash.slice(0, 14))}…</a>`
          : l.evidenceId ? `<a href="/doc/${esc(l.evidenceId)}">document</a>`
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
            ${t.outbound === "crypto"
              ? `<input name="tx_hash" placeholder="0x…" style="max-width:190px" spellcheck="false">`
              : `<input name="file" type="file" style="max-width:190px">`}
            <button class="plain">Record</button>
          </form>` : ""}</td></tr>`).join("")}
      </table>
    </div>`;

  const ledger = history.length ? `
    <h2>Everything that moved</h2>
    <div class="panel" style="max-width:none"><div class="scroll"><table class="log">
      <tr><th>When</th><th>What</th><th>Held by</th><th>Amount</th><th>Evidence</th></tr>
      ${history.map((e) => `<tr>
        <td>${esc((e.occurred_at ?? "").slice(0, 16))}</td>
        <td>${esc(e.event)}</td><td>${esc(e.holder)}</td>
        <td>${esc(e.currency)} ${format(e.amount_minor, e.decimals)}</td>
        <td>${e.tx_hash
          ? `<a href="${esc(railFor(t as any).explorer.tx(e.tx_hash))}" rel="noopener"
               target="_blank">${esc(e.tx_hash.slice(0, 18))}…</a>
             <div class="muted">block ${esc(e.tx_block ?? "?")}, checked
               ${esc((e.tx_verified_at ?? "").slice(0, 16))}</div>`
          : e.artefact
            ? `<a href="/doc/${esc(e.artefact)}">${esc(e.filename ?? "file")}</a>
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

/**
 * Bank operations, on a transaction with a fiat leg.
 *
 * The references every payment must carry, the bulk file to make them with,
 * and the statement: paste it in, reconcile, and the matching lines become
 * custody events. The manual settlement page still exists for anything a
 * statement cannot say.
 */
async function bankPanel(env: Env, t: any, note = ""): Promise<string> {
  if (t.inbound !== "fiat" && t.outbound !== "fiat") return "";
  const { items } = await bankExpected(env, t.id);
  const { matched, pool } = await bankLines(env, t.id);
  const outstanding = items.filter((i) => !i.paid && i.direction === "out" && i.amountMinor > 0).length;
  const direct = paysDirect(t);
  const acct = (i: any) => i.account
    ? esc(i.account.iban ? i.account.iban : `${i.account.sortCode ?? ""} ${i.account.accountNumber ?? ""}`)
    : i.what === "fee" ? (direct ? '<span class="bad">FEE_BANK_ACCOUNT not set</span>' : "our fee account")
    : i.what === "receipt" ? "client mandated account" : '<span class="bad">no account yet</span>';
  const anyPaid = items.some((i) => i.paid);
  const bothFiat = t.inbound === "fiat" && t.outbound === "fiat";
  const mode = await fiatMode(env);
  const flow = await fiatChecklist(env, t, items);
  const payerForm = bothFiat && (mode === "sender_direct" || direct) ? `<form method="post" action="/t/${esc(t.id)}/bank" class="row" style="gap:14px;align-items:center;margin:6px 0 10px">
      <input type="hidden" name="action" value="payer">
      <strong>Who makes the payments${tip("Mandated account: the sender pays us, we pay everyone from the client mandated account. Sender pays directly: the sender uploads our payment file to their own bank and pays every recipient and our fee themselves; nothing passes through an account we operate, and the certification says so. Fixed once any payment is on the record.")}</strong>
      <label style="display:inline-flex;gap:6px;align-items:center"><input type="radio" name="payer" value="mandated"${direct ? "" : " checked"}${anyPaid ? " disabled" : ""}> Client mandated account</label>
      <label style="display:inline-flex;gap:6px;align-items:center"><input type="radio" name="payer" value="sender"${direct ? " checked" : ""}${anyPaid ? " disabled" : ""}> The sender pays directly</label>
      ${anyPaid ? '<span class="muted">fixed — a payment is already recorded</span>' : '<button class="plain small">Save</button>'}
    </form>` : "";
  return `<details class="panel" open>
    <summary><strong>Bank operations</strong> — ${direct ? "sender pays directly — " : ""}${items.filter((i) => i.paid).length} of ${items.length} payments on the statement${
      tip(direct
        ? "The sender pays every recipient and our fee from their own bank, using the payment file and references from their page, and uploads their statement there. Reconcile (theirs or ours) turns each line with a matching reference and amount into a custody event held by the client. Nothing passes through an account we operate."
        : "Fiat moves through the client mandated account at HSBC, so the record is built from the statement. Every payment carries a reference we chose; import the statement and Reconcile turns each line with a matching reference and amount into a custody event. Anything that nearly matches is shown for a person to decide.")}</summary>
    ${note ? `<div class="good" style="white-space:pre-line">${esc(note)}</div>` : ""}
    ${flow}
    ${payerForm}
    <h3 style="margin:8px 0 4px">What we expect to see${tip("The reference is the whole matching rule: a statement line must carry it and the exact amount. Give the sender theirs to put on their payment; ours go on the bulk payment file.")}</h3>
    <table>
      <tr><th>Who</th><th>Direction</th><th>Reference</th><th>Account</th><th style="text-align:right">Amount</th><th></th></tr>
      ${items.map((i) => `<tr>
        <td>${esc(i.who)}</td><td>${i.direction === "in" ? "in" : "out"}</td>
        <td><code>${esc(i.reference)}</code></td><td class="muted">${acct(i)}</td>
        <td style="text-align:right">${format(i.amountMinor, i.decimals)} ${esc(i.currency)}</td>
        <td>${i.paid ? '<span class="good">on the statement</span>' : '<span class="muted">waiting</span>'}</td></tr>`).join("")}
    </table>
    ${outstanding ? `<p><a href="/t/${esc(t.id)}/bank/payments.csv"><button class="plain">Download the payment file (${outstanding} payment${outstanding === 1 ? "" : "s"})</button></a>${
      tip("A CSV with one row per outgoing payment still to make — beneficiary, account, amount, reference — for the bank's bulk payment upload. Recipients without a locked, proved account are still listed so you can see the gap; do not pay a row with no account.")}</p>` : ""}
    <h3 style="margin:14px 0 4px">The statement${direct ? ' <span class="muted" style="font-weight:400">— the sender\'s; they can upload it from their page, or you can here</span>' : ""}</h3>
    <form method="post" action="/t/${esc(t.id)}/bank" enctype="multipart/form-data">
      <input type="hidden" name="action" value="import">
      <label for="stmt">Paste the export, or upload the CSV${tip("Any bank CSV: the date, description and amount (or paid-in / paid-out) columns are found by their headings. A line imported twice is kept once. Lines are held across transactions, so one import covers every distribution on the account.")}</label>
      <textarea id="stmt" name="text" rows="4" placeholder="Date,Description,Paid in,Paid out,Balance&#10;10/09/2026,TPM-2026-0002 J SMITH,1010.11,,..."></textarea>
      <div class="row"><input type="file" name="file" accept=".csv,text/csv,text/plain">
        <button class="plain">Import the lines</button>
        <button class="go" name="action" value="reconcile" formnovalidate>Reconcile</button></div>
    </form>
    ${matched.length ? `<h3 style="margin:14px 0 4px">Matched to this transaction</h3><table>
      <tr><th>Booked</th><th>Reference</th><th style="text-align:right">Amount</th><th>Matched as</th></tr>
      ${matched.map((l: any) => `<tr><td>${esc(l.booked_on)}</td><td class="muted">${esc(l.reference)}</td>
        <td style="text-align:right">${l.direction === "out" ? "-" : ""}${format(Number(l.amount_minor), t.decimals_in)} ${esc(l.currency)}</td>
        <td>${esc(String(l.matched_what ?? "").replace(/^leg:.*/, "payment to a recipient").replace(/^penny:.*/, "penny test"))}</td></tr>`).join("")}
    </table>` : ""}
    ${pool.length ? `<details style="margin-top:10px"><summary class="muted" style="cursor:pointer">${pool.length} unmatched line${pool.length === 1 ? "" : "s"} held on the account</summary><table>
      <tr><th>Booked</th><th>Reference</th><th style="text-align:right">Amount</th></tr>
      ${pool.map((l: any) => `<tr><td>${esc(l.booked_on)}</td><td class="muted">${esc(l.reference)}</td>
        <td style="text-align:right">${l.direction === "out" ? "-" : ""}${format(Number(l.amount_minor), 2)} ${esc(l.currency)}</td></tr>`).join("")}
    </table></details>` : ""}
    <p class="muted" style="margin:10px 0 0">Anything the statement cannot say — a variance decision, evidence for a payment made another way — is still recorded on the <a href="/t/${esc(t.id)}/settle">settlement page</a>.</p>
  </details>`;
}

/**
 * The agreements: who has signed what, and whether the signature still covers
 * the facts. A stale line means the transaction changed after signing.
 */
async function agreementsPanel(env: Env, t: any, note = ""): Promise<string> {
  const rows = await agreementsFor(env, t.id);
  if (!rows.length) return "";
  const signed = rows.filter((r) => r.state === "signed").length;
  return `<details class="panel"${signed === rows.length ? "" : " open"}>
    <summary><strong>Agreements</strong> — ${signed} of ${rows.length} signed${tip(`Each party signs the document generated for this transaction from the record: the sender the Sender's Paymaster Agreement (with its Transaction, Distribution and Client Account schedules), each recipient a Recipient's Authorisation carrying their own account. Template ${AGREEMENT_VERSION}. The signature is over a hash of the exact text shown; if an amount, recipient or account changes afterwards the line goes stale and the party is asked to sign again. Signed PDFs are documents on the transaction, shared with the party.`)}</summary>
    ${note && /signed|emailed/.test(note) ? `<div class="good">${esc(note)}</div>` : ""}
    <table>
      <tr><th>Party</th><th>Document</th><th>Status</th><th></th></tr>
      ${rows.map((r) => `<tr>
        <td>${esc(r.name)}<div class="muted log">${esc(r.role)}</div></td>
        <td>${r.kind === "sender_agreement" ? "Sender's Paymaster Agreement" : "Recipient's Authorisation"}</td>
        <td>${r.state === "signed" ? `<span class="good">Signed</span> <span class="muted">${esc(String(r.latest.signed_at).slice(0, 16))} by ${esc(r.latest.signed_name)}</span>`
             : r.state === "stale" ? `<span class="warn">Signed ${esc(String(r.latest.signed_at).slice(0, 10))}, but the facts changed since</span>`
             : '<span class="muted">Not signed</span>'}</td>
        <td class="row" style="gap:6px">${r.latest?.artefact_id ? `<a href="/doc/${esc(r.latest.artefact_id)}"><button class="plain small" type="button">PDF</button></a>` : ""}
          ${r.state !== "signed" ? `<form method="post" action="/t/${esc(t.id)}/agreements/remind" style="display:inline"><input type="hidden" name="party" value="${esc(r.partyId)}"><button class="plain small">${r.state === "stale" ? "Ask to sign again" : "Ask to sign"}</button></form>` : ""}</td></tr>`).join("")}
    </table>
  </details>`;
}

/** The manual fiat flow as a numbered list, each line pointing at where it is done. */
async function fiatChecklist(env: Env, t: any, items: Awaited<ReturnType<typeof bankExpected>>["items"]): Promise<string> {
  if (t.inbound !== "fiat" && t.outbound !== "fiat") return "";
  const sigs = await agreementsFor(env, t.id);
  const allSigned = sigs.length > 0 && sigs.every((s) => s.state === "signed");
  const receipt = items.find((i) => i.what === "receipt");
  const legs = items.filter((i) => i.what.startsWith("leg:"));
  const { results: confirmed } = await env.DB.prepare(
    "SELECT id FROM participations WHERE transaction_id = ? AND role = 'recipient' AND receipt_confirmed_at IS NOT NULL").bind(t.id).all<any>();
  const confirmedIds = new Set((confirmed ?? []).map((r: any) => r.id));
  const paidLegs = legs.filter((l) => l.paid).length;
  const confirmedLegs = legs.filter((l) => confirmedIds.has(l.what.slice(4))).length;
  const sealed = await env.DB.prepare("SELECT 1 FROM dossier_seals WHERE transaction_id = ? LIMIT 1").bind(t.id).first();
  const li = (done: boolean, now: boolean, text: string) =>
    `<li class="${done ? "good" : now ? "" : "muted"}">${done ? "&#10003;" : now ? "&rarr;" : "&#9675;"} ${text}</li>`;
  const stage = [allSigned, Boolean(t.sender_sent_at), Boolean(receipt?.paid), legs.length > 0 && paidLegs === legs.length,
                 legs.length > 0 && confirmedLegs === legs.length, Boolean(sealed)];
  const nowIdx = stage.findIndex((x) => !x);
  return `<ol class="fiatflow" style="margin:6px 0 12px;padding-left:20px;line-height:1.7">
    ${li(stage[0], nowIdx === 0, `Agreements signed by every party${sigs.length ? ` (${sigs.filter((s) => s.state === "signed").length} of ${sigs.length})` : ""}`)}
    ${li(stage[1], nowIdx === 1, t.sender_sent_at ? `Sender says the funds were sent ${esc(String(t.sender_sent_at).slice(0, 16))}${t.sender_sent_note ? ` — “${esc(t.sender_sent_note)}”` : ""}` : `Sender pays the client account under <code>${esc(t.ref)}</code> and presses “I have sent it”`)}
    ${li(stage[2], nowIdx === 2, receipt?.paid ? "Receipt confirmed into the client account" : `Confirm receipt against the bank on the <a href="/t/${esc(t.id)}/settle">settlement page</a>, with the advice as evidence`)}
    ${li(stage[3], nowIdx === 3, `Recipients paid from the client account, each recorded with evidence (${paidLegs} of ${legs.length})${nowIdx === 3 && legs.some((l) => !l.paid) ? ` — <a href="/t/${esc(t.id)}/bank/payments.csv">payment file</a>, then record each on the <a href="/t/${esc(t.id)}/settle">settlement page</a>` : ""}`)}
    ${li(stage[4], nowIdx === 4, `Recipients confirm receipt in their accounts (${confirmedLegs} of ${legs.length})`)}
    ${li(stage[5], nowIdx === 5, sealed ? "Record sealed" : `Seal the record on the <a href="/t/${esc(t.id)}/dossier">dossier page</a>`)}
  </ol>`;
}

/** Fiat Transactions: which fiat mode is on, and every fiat transaction with where it has got to. */
async function fiatPage(env: Env, admin: { name: string }, actor: Actor, request: Request): Promise<Response> {
  let note = "", error = "";
  if (request.method === "POST") {
    const f = await request.formData();
    const want = String(f.get("mode") ?? "") as FiatMode;
    const m = FIAT_MODES.find((x) => x.key === want);
    if (!m) error = "Unknown mode.";
    else if (!m.available(env)) error = m.why ?? "That mode is not available yet.";
    else { await setSwitch(env, actor, "fiat_mode", want, `fiat mode → ${m.label}`); note = `${m.label} is on.`; }
  }
  const mode = await fiatMode(env);
  const acct = accountFromVar(env.MANDATED_ACCOUNT);
  const { results: txs } = await env.DB.prepare(
    `SELECT id, ref, name, status, inbound, outbound, fiat_payer, sender_sent_at, currency_in, gross_expected_minor, decimals_in
       FROM transactions WHERE inbound = 'fiat' OR outbound = 'fiat' ORDER BY created_at DESC LIMIT 60`).all<any>();
  const rows: string[] = [];
  for (const t of txs ?? []) {
    const received = await env.DB.prepare("SELECT 1 FROM custody_events WHERE transaction_id = ? AND event = 'received' LIMIT 1").bind(t.id).first();
    const sigs = await agreementsFor(env, t.id);
    const legs = await env.DB.prepare(
      `SELECT count(*) AS n, sum(CASE WHEN EXISTS (SELECT 1 FROM payout_legs l JOIN custody_events c ON c.id = l.event_id WHERE l.participation_id = p.id AND c.event = 'sent') THEN 1 ELSE 0 END) AS paid,
              sum(CASE WHEN p.receipt_confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed
         FROM participations p WHERE p.transaction_id = ? AND p.role = 'recipient'`).bind(t.id).first<any>();
    const stage = t.status === "closed" || t.status === "settled" ? "Settled"
      : legs?.n && legs.confirmed === legs.n ? "Recipients confirmed — seal"
      : legs?.paid ? `Paid ${legs.paid} of ${legs.n}` : received ? "Funds received — pay recipients"
      : t.sender_sent_at ? "Sender says sent — confirm receipt" : sigs.length && sigs.every((s) => s.state === "signed") ? "Awaiting the sender's payment"
      : `Agreements ${sigs.filter((s) => s.state === "signed").length} of ${sigs.length}`;
    rows.push(`<tr><td><a href="/t/${esc(t.id)}">${esc(t.ref)}</a><div class="muted log">${esc(t.name)}</div></td>
      <td>${esc(t.inbound)} → ${esc(t.outbound)}${t.fiat_payer === "sender" ? ' <span class="tag">sender direct</span>' : ""}</td>
      <td>${t.gross_expected_minor != null ? `${esc(t.currency_in)} ${format(t.gross_expected_minor, t.decimals_in)}` : "—"}</td>
      <td><span class="tag">${esc(t.status)}</span></td><td>${stage}</td></tr>`);
  }
  return page("Fiat transactions", `
    <h1>Fiat transactions</h1>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}${note ? `<div class="good">${esc(note)}</div>` : ""}
    <div class="panel">
      <h2 style="margin-top:0">How fiat runs${tip("One switch for every fiat transaction. Manual is how it runs today; the HSBC API mode becomes selectable once the bank has issued credentials for the client account; the sender-direct mode is built and kept but off the default path. Changing the switch is logged.")}</h2>
      <form method="post" action="/fiat">
        ${FIAT_MODES.map((m) => { const ok = m.available(env); return `
        <label style="display:block;padding:10px 12px;border:1px solid var(--rule);border-radius:6px;margin:8px 0;${ok ? "" : "opacity:.65"}">
          <input type="radio" name="mode" value="${m.key}"${mode === m.key ? " checked" : ""}${ok ? "" : " disabled"}>
          <strong>${esc(m.label)}</strong>${mode === m.key ? ' <span class="tag">on</span>' : ""}
          <div class="muted" style="margin:4px 0 0 22px">${esc(m.detail)}</div>
          ${m.why ? `<div class="muted" style="margin:4px 0 0 22px;font-size:12.5px">${esc(m.why)}</div>` : ""}
        </label>`; }).join("")}
        <div class="row"><button class="go">Save</button></div>
      </form>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">The client account</h2>
      ${acct ? `<p><b>${esc(acct.name)}</b>${acct.bank ? `, ${esc(acct.bank)}` : ""} — ${acct.iban ? `IBAN ${esc(acct.iban)}` : `sort code ${esc(acct.sortCode ?? "")}, account ${esc(acct.accountNumber ?? "")}`}</p>
             <p class="muted">Shown to senders on their page and written into Schedule 5 of every Sender's Paymaster Agreement. Set as MANDATED_ACCOUNT in wrangler.toml.</p>`
           : `<p class="warn">MANDATED_ACCOUNT is not set. Senders are told the details will follow separately, and Schedule 5 says “supplied through a Secure Channel”. Set it in wrangler.toml as “Name|sort code|account number|IBAN|BIC|bank”.</p>`}
      <p class="muted">Agreement template in use: ${esc(AGREEMENT_VERSION)}.</p>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">Every fiat transaction</h2>
      ${rows.length ? `<table><tr><th>Ref</th><th>Legs</th><th>Gross</th><th>Status</th><th>Where it is</th></tr>${rows.join("")}</table>` : '<p class="muted">None yet.</p>'}
    </div>`, { nav: nav("/fiat", admin.name) });
}

async function bankAction(request: Request, env: Env, admin: { name: string }, actor: Actor, txId: string): Promise<Response> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?").bind(txId).first<any>();
  if (!t) return new Response("Not found", { status: 404 });
  const f = await request.formData();
  const action = String(f.get("action") ?? "");
  if (action === "payer") {
    const want = String(f.get("payer")) === "sender" ? "sender" : "mandated";
    if (want === "sender" && (await fiatMode(env)) !== "sender_direct") {
      return detail(env, admin, txId, "The sender-pays-directly mode is switched off on the Fiat page. It is built and kept, but off the default path: it does not sit inside the commercial agent model as we operate it.");
    }
    if (t.inbound !== "fiat" || t.outbound !== "fiat") return detail(env, admin, txId, "Only a fiat-to-fiat transaction has a choice of payer.");
    const paid = await env.DB.prepare("SELECT 1 FROM custody_events WHERE transaction_id = ? LIMIT 1").bind(txId).first();
    if (paid) return detail(env, admin, txId, "A payment is already on the record; who pays cannot change now.");
    if (want !== t.fiat_payer) {
      await update(env.DB, actor, "transaction.fiat_payer", "transactions", txId,
        { fiat_payer: want }, { fiat_payer: t.fiat_payer },
        { note: want === "sender" ? "the sender pays every recipient and the fee from their own bank" : "payments through the client mandated account" });
    }
    return detail(env, admin, txId, "", want === "sender"
      ? "The sender pays directly. Their page now carries the payment file and a place for their statement."
      : "Payments go through the client mandated account.");
  }
  if (action === "penny") {
    const r = await sendPenny(env, actor, String(f.get("destination") ?? ""));
    return "problem" in r ? detail(env, admin, txId, r.problem)
      : detail(env, admin, txId, "", `Penny code ${r.code}. Put the reference ${pennyReference(r.code)} on a 0.01 payment from the client mandated account to that account. The recipient has been emailed to look out for it.`);
  }
  if (action === "import") {
    const file = f.get("file");
    const text = (file instanceof File && file.size > 0) ? await file.text() : String(f.get("text") ?? "");
    if (!text.trim()) return detail(env, admin, txId, "Nothing to import — paste the statement or choose the file.");
    const currency = t.inbound === "fiat" ? t.currency_in : t.currency_out;
    const decimals = t.inbound === "fiat" ? t.decimals_in : t.decimals_out;
    const r = await importStatement(env, actor, text, currency, decimals);
    if (!r.added && !r.duplicates) return detail(env, admin, txId,
      `Could not read that as a statement (${r.skipped} line${r.skipped === 1 ? "" : "s"} skipped). It needs a date column, a description or reference column, and an amount or paid-in / paid-out columns, named in the first row.`);
    return detail(env, admin, txId, "", `Imported ${r.added} new line${r.added === 1 ? "" : "s"}; ${r.duplicates} already held; ${r.skipped} unreadable. Now press Reconcile.`);
  }
  if (action === "reconcile") {
    const r = await reconcileBank(env, actor, txId);
    const lines = [
      r.recorded.length ? `Recorded ${r.recorded.length}:\n${r.recorded.join("\n")}` : "Nothing new matched.",
      r.pennies.length ? `Pennies seen: ${r.pennies.join("; ")}` : "",
      r.near.length ? `Look at these — reference matches but not the amount:\n${r.near.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    return detail(env, admin, txId, "", lines);
  }
  return detail(env, admin, txId, "Unknown bank action.");
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
      txHash: String(f.get("tx_hash") ?? "").trim() || null, chainId: t.chain_id,
      note: String(f.get("note") ?? "").trim() || undefined,
      file: asFile, evidenceKind: "receipt_advice",
    });
    if (typeof result === "object") return settlePage(env, { name: "" }, txId, result.problem);
    await update(env.DB, actor, "transaction.funds_received", "transactions", txId,
      { gross_received_minor: (t.gross_received_minor ?? 0) + amountMinor },
      { gross_received_minor: t.gross_received_minor });
    if (t.inbound === "fiat") await fundsReceived(env, actor, txId, amountMinor, t.currency_in, t.decimals_in);

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
      txHash: String(f.get("tx_hash") ?? "").trim() || null, chainId: t.chain_id,
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
      txHash: String(f.get("tx_hash") ?? "").trim() || null, chainId: t.chain_id,
      file: asFile, evidenceKind: "payment_confirmation",
    });
    if (typeof result === "object") return settlePage(env, { name: "" }, txId, result.problem);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO payout_legs (event_id, participation_id) VALUES (?, ?)")
      .bind(result, participation).run();
    await log(env.DB, actor, "payout.recorded", "participations", participation,
      { note: `${t.currency_out} ${format(amountMinor, t.decimals_out)}` });
    if (t.outbound === "fiat") await paymentMade(env, actor, txId, participation, amountMinor);
    return back();
  }

  return new Response("Unknown action", { status: 400 });
}


/** Files on the transaction itself, and the form to add one. */
async function txDocuments(env: Env, txId: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, label, filename, bytes, sha256, uploaded_at FROM artefacts
      WHERE transaction_id = ? ORDER BY uploaded_at`).bind(txId).all<any>();
  const docs = results ?? [];
  const list = docs.length
    ? `<table><tr><th>Document</th><th>File</th><th>Size</th><th>Uploaded</th></tr>` +
      docs.map((d: any) => `<tr>
        <td>${esc(d.label ?? d.kind.replace(/_/g, " "))}</td>
        <td><a href="/doc/${esc(d.id)}">${esc(d.filename ?? d.id)}</a></td>
        <td class="muted">${Math.round((d.bytes ?? 0) / 1024)}KB</td>
        <td class="muted">${esc(String(d.uploaded_at).slice(0, 16))}</td></tr>`).join("") + `</table>`
    : `<p class="muted">Nothing uploaded against the transaction itself. Each party's
        own documents are on their page and are part of this dossier too.</p>`;
  return `<details class="panel">
    <summary><strong>Documents</strong>${docs.length ? ` — ${docs.length}` : ""}</summary>
    <p class="muted">Anything about the deal as a whole: the Themis report on the transaction,
      the agency agreement, an OTC confirmation. Upload before sealing so it is in the record.</p>
    ${list}
    ${uploadForm(`/t/${txId}/upload`, [
      ["kyc_report", "Screening report (Themis or other)"],
      ["agency_agreement", "Agency agreement"], ["otc_confirmation", "OTC confirmation"],
      ["bank_statement", "Bank statement"], ["other", "Other"]])}
  </details>`;
}


/**
 * Which rail a crypto transaction runs on, the token where the rail has one,
 * and where our fee goes.
 *
 * Set per transaction rather than in code, because an address in code is an
 * address nobody reviews. The fee address is checked against the rail chosen,
 * so a Bitcoin fee cannot be pointed at an Ethereum address or the reverse.
 */
function chainSettingsPanel(t: Record<string, any>): string {
  const rail = railFor(t as any);
  const chosen = t.rail || (t.chain_id ? `eth:${t.chain_id}:usdt` : "");
  const choice = railChoice(chosen);
  const needsToken = choice ? choice.needsToken : true;
  const missing = [
    !chosen && "the rail",
    needsToken && !t.token_address && "the token address",
    !t.fee_wallet && "the fee wallet",
  ].filter(Boolean) as string[];
  const isEth = rail.key.startsWith("eth:");

  return `<details class="panel"${t.fee_wallet ? "" : " open"}>
      <summary><strong>Chain settings</strong> — ${esc(rail.name)}${t.fee_wallet
        ? "" : ' <span class="bad">— no fee wallet set</span>'}</summary>
      <p class="muted">Which rail this runs on — the chain and the asset — and where
        our fee goes. Set per transaction rather than in code, because an address in
        code is an address nobody reviews.</p>
      ${missing.length
        ? `<p class="bad" style="font-weight:600">Still to set: ${esc(missing.join(", "))}.
           Grey text in a box is a hint, not a saved value.</p>`
        : `<p class="good" style="font-weight:600">Everything is set.</p>`}
      <form method="post" action="/t/${esc(t.id)}/chain">
        <label>Rail${tip("The chain and the asset. USDT on Ethereum for the usual case; Bitcoin for BTC. The two rehearsal rails are test networks where nothing is worth anything — use them to walk a transaction through before a real one.")}
          <select name="rail" id="railsel">
            ${!chosen ? `<option value="" selected>Choose…</option>` : ""}
            ${RAILS.map((r) => `<option value="${r.key}" data-token="${r.needsToken ? 1 : 0}"${
              chosen === r.key ? " selected" : ""}>${esc(r.label)}</option>`).join("")}
          </select></label>
        <div id="tokenrow"${needsToken ? "" : " hidden"}>
          <label>Token address${needsToken && !t.token_address
            ? ' <span class="bad">— not set</span>' : ""}
            <input name="token_address" size="46" spellcheck="false"
                   placeholder="0x… the token's contract address"
                   value="${esc(t.token_address ?? "")}"></label>
          <p class="muted" style="margin:4px 0 0">${t.token_address
            ? `Currently <span class="mono">${esc(t.token_address)}</span>.`
            : `Nothing is set, so nothing can be sent. USDT on Ethereum is ` +
              `<span class="mono">${esc(USDT_MAINNET)}</span> — but check it ` +
              `against the chain you have chosen, because the same token has a ` +
              `different address on every network.`}</p>
        </div>
        <label>Our fee goes to${t.fee_wallet
          ? "" : ' <span class="bad">— not set</span>'}
          <input name="fee_wallet" size="46" placeholder="${isEth ? "0x…" : "bc1…"}" spellcheck="false"
                 value="${esc(t.fee_wallet ?? "")}" required></label>
        <p class="muted" style="margin:4px 0 0">Must be an address on the rail chosen above;
          it is checked when you save.</p>
        <button type="submit">Save chain settings</button>
      </form>
      <script>
      (function () {
        var sel = document.getElementById("railsel"), row = document.getElementById("tokenrow");
        var fee = document.querySelector('input[name="fee_wallet"]');
        sel.addEventListener("change", function () {
          var o = sel.options[sel.selectedIndex];
          row.hidden = o.dataset.token !== "1";
          fee.placeholder = /^btc:/.test(o.value) ? "bc1…" : "0x…";
        });
      })();
      </script>

      ${isEth && t.chain_id ? `<hr style="border:0;border-top:1px solid var(--rule);margin:18px 0">
      <p class="muted" style="margin-top:0">Your browser wallet has to be on the
        same network to send anything. It will offer to switch when you press a
        send button, but you can do it now — and switching also makes the token
        visible in the wallet.</p>
      <p><button type="button" id="switchnet" class="plain">Put my wallet on
        ${esc(CHAINS[t.chain_id as number]?.name ?? "this network")}</button>
        <span class="muted" id="switchsays"></span></p>
      <script>
      (function () {
        var btn = document.getElementById("switchnet");
        var says = document.getElementById("switchsays");
        if (!window.ethereum) { btn.disabled = true;
          says.textContent = "No wallet in this browser."; return; }
        var want = "0x${(t.chain_id as number).toString(16)}";
        btn.addEventListener("click", async function () {
          btn.disabled = true;
          try {
            await window.ethereum.request({ method: "eth_requestAccounts" });
            await window.ethereum.request({
              method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
            says.textContent = "Switched.";
          } catch (e) {
            // 4902 means the wallet does not know this network at all. Adding
            // it is a separate permission, so it is asked for separately.
            if (e && e.code === 4902) {
              says.textContent = "Your wallet does not have that network — " +
                "add it once in the wallet, then press again.";
            } else {
              says.textContent = (e && e.message) || "Not switched.";
            }
          }
          btn.disabled = false;
        });
      })();
      </script>` : ""}
    </details>`;
}


/** The staff side of a party's data room: the invitations, and a form for another. */
async function staffRoom(env: Env, admin: { name: string }, actor: Actor, request: Request,
                         txId: string, partyId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT t.ref, y.display_name, y.legal_name FROM participations p
       JOIN transactions t ON t.id = p.transaction_id JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ? AND p.party_id = ? LIMIT 1`).bind(txId, partyId).first<any>();
  if (!row) return new Response("Not found", { status: 404 });
  let justMade: string | undefined, error: string | undefined;
  if (request.method === "POST") {
    const f = await request.formData();
    if (f.get("revoke")) error = (await roomRevoke(env, actor, String(f.get("revoke")))) ?? undefined;
    else {
      const made = await roomInvite(env, actor, {
        transactionId: txId, partyId, viewerName: String(f.get("viewer_name") ?? ""),
        viewerEmail: String(f.get("viewer_email") ?? ""), days: Number(f.get("days") ?? 30),
        includeDocuments: f.get("include_documents") === "1",
      });
      if ("problem" in made) error = made.problem; else justMade = made.url;
    }
  }
  const who = row.legal_name || row.display_name;
  return page(`Data room — ${who}`, `
    <h1>Data room — ${esc(who)}</h1>
    <p class="muted"><a href="/t/${esc(txId)}">${esc(row.ref)}</a> — a private, expiring, watermarked view of this party's
      Peaceful Enjoyment dossier for somebody who is not a party: their bank, their accountant. The party can make
      these from their own page too; every opening is logged against the link.</p>
    <div class="panel" style="max-width:none">
      ${invitePanel(await invitesFor(env, txId, partyId), `/t/${txId}/party/${partyId}/room`, { justMade, error })}
    </div>`, { nav: nav("/", admin.name) });
}


/** The attestation key's standing on each chain, and the contract that mints certificates. */
async function badgesPage(env: Env, admin: { name: string }, actor: Actor, request: Request): Promise<Response> {
  let notice = "";
  if (request.method === "POST") {
    const f = await request.formData();
    const chainId = Number(f.get("chain"));
    if (f.get("deploy")) notice = (await deployContract(env, actor, chainId)) ?? `Deployed on ${CHAINS[chainId]?.name}.`;
  }
  const st = await attesterStatus(env);
  const eth = (wei: bigint | null) => wei === null ? "unknown" : (Number(wei) / 1e18).toLocaleString("en-GB", { minimumFractionDigits: 5, maximumFractionDigits: 5 }) + " ETH";
  return page("Badges", `<h1>Certificates on chain</h1>
    ${notice ? `<div class="err">${esc(notice)}</div>` : ""}
    <div class="panel">
      <h2>The signing key${tip("The same key that signs every seal and certification (ATTEST_KEY). On chain it is the account that deploys the certificate contract and mints each token, so it needs a little ETH for gas on each chain it is used on. Send ETH on Base to this address to fund minting; a few pounds' worth lasts a long time.")}</h2>
      ${st.address ? `<p>Address <span class="mono big">${esc(st.address)}</span></p>` : `<p class="bad">No attestation key is configured (ATTEST_KEY).</p>`}
      <table class="log"><tr><th>Chain</th><th>Balance for gas</th><th>Certificate contract</th><th></th></tr>
      ${st.chains.map((c) => `<tr><td>${esc(c.name)} <span class="muted">${c.chainId}</span></td>
        <td class="${c.balance !== null && c.balance > 0n ? "good" : "warn"}">${eth(c.balance)}</td>
        <td>${c.contract ? `<a class="mono" href="${esc(CHAINS[c.chainId]?.explorer ?? "")}/address/${esc(c.contract.address)}" target="_blank" rel="noopener">${esc(c.contract.address)}</a>
              <div class="muted">deployed ${esc(String(c.contract.deployed_at).slice(0, 16))}</div>` : `<span class="muted">not deployed</span>`}</td>
        <td>${!c.contract && st.address ? `<form method="post" style="margin:0"><input type="hidden" name="chain" value="${c.chainId}">
              <button class="plain" name="deploy" value="1"${c.balance && c.balance > 0n ? "" : " disabled"}>Deploy the contract</button></form>` : ""}</td></tr>`).join("")}
      </table>
      <p class="muted">Deploying costs about 0.0005 ETH on Base; each certificate about 0.00003. The contract is soulbound ERC-721
        (ERC-5192): tokens cannot be transferred, only the key can mint, and the token id is derived from the sealed record root.
        Mint from a transaction's dossier page once it is sealed.</p>
    </div>`, { nav: nav("/badges", admin.name) });
}
