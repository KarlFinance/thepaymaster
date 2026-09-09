/**
 * Where somebody is, in a form they can see at a glance.
 *
 * The deal page used to show every card it had, all the time: a verified
 * person still saw the verification card, a proved wallet still sat above a
 * signing form, and nothing said "this bit is finished, look at the next one".
 * People kept re-reading things they had already done, which is exhausting and
 * — worse — made them doubt whether it had worked.
 *
 * So each role has a fixed sequence of steps, and each step is in one of four
 * states. Done steps collapse to a single green line with a summary. The one
 * step that is theirs right now is the only thing rendered in full. Steps
 * waiting on somebody else say who. Steps not yet reached are listed, muted,
 * so the whole shape of the thing is visible without being loud.
 *
 * "done" is decided from the record, never from what the page last showed.
 */

import { type Env } from "./db.ts";
import { esc } from "./views.ts";
import { format } from "./money.ts";
import { legs as payoutLegs } from "./settlement.ts";
import { seals } from "./dossier.ts";

export type State = "done" | "now" | "wait" | "todo";

export interface Step {
  key: string;
  label: string;
  state: State;
  /** One line under the label. Required for done and wait; optional otherwise. */
  summary?: string;
}

/** The platform's stage names are for the platform. */
export const STAGE: Record<string, string> = {
  draft:            "Being set up",
  awaiting_parties: "Waiting for everyone to verify",
  kyc:              "Checks under way",
  ready:            "Ready to send",
  settling:         "Payments in progress",
  settled:          "Complete",
  closed:           "Complete",
  abandoned:        "Abandoned",
  declined:         "Declined",
};

const day = (s: string | null | undefined) => (s ?? "").slice(0, 10);

// ---------------------------------------------------------------------------
// A recipient
// ---------------------------------------------------------------------------

export function recipientJourney(o: {
  cleared: { verified_at: string | null; expires_at: string | null } | null;
  submittedAt: string | null;
  dest: any | null;
  kind: "wallet" | "bank";
  paidHash: string | null;
  sealed: boolean;
}): Step[] {
  const steps: Step[] = [];

  // 1. identity
  if (o.cleared) {
    steps.push({ key: "verify", label: "Verify yourself", state: "done",
      summary: `Checked ${day(o.cleared.verified_at)}` +
        (o.cleared.expires_at ? `, good until ${day(o.cleared.expires_at)}` : "") });
  } else if (o.submittedAt) {
    steps.push({ key: "verify", label: "Verify yourself", state: "wait",
      summary: `Sent ${day(o.submittedAt)} — with us for checking. Nothing needed from you.` });
  } else {
    steps.push({ key: "verify", label: "Verify yourself", state: "now" });
  }
  const verified = steps[0].state === "done";

  // 2. where the money goes
  const given = Boolean(o.dest?.address || o.dest?.iban || o.dest?.account_number);
  const confirmed = given && o.dest.status !== "draft";
  const what = o.kind === "wallet" ? "Your wallet" : "Your bank details";
  if (!verified) {
    steps.push({ key: "details", label: what, state: "todo" });
  } else if (confirmed) {
    steps.push({ key: "details", label: what, state: "done",
      summary: o.kind === "wallet" ? o.dest.address : "Given and read back" });
  } else {
    steps.push({ key: "details", label: what, state: "now" });
  }

  // 3. prove it — wallets only. By signature, or accepted by us on evidence
  //    when the address is at an exchange and cannot sign.
  if (o.kind === "wallet") {
    if (!confirmed) steps.push({ key: "prove", label: "Prove it is yours", state: "todo" });
    else if (o.dest.proved_at) steps.push({ key: "prove", label: "Prove it is yours",
      state: "done", summary: `Signed ${o.dest.proved_at.slice(0, 16)}` });
    else if (o.dest.attested) steps.push({ key: "prove", label: "Prove it is yours",
      state: "done", summary: `Accepted as your ${o.dest.attested.custodian} deposit address on the evidence you sent` });
    else if (o.dest.proof_unavailable_at) steps.push({ key: "prove", label: "Prove it is yours",
      state: "wait", summary: "You told us you cannot sign from this address. We are reviewing it — nothing needed from you unless we write." });
    else steps.push({ key: "prove", label: "Prove it is yours", state: "now" });
  }
  const proved = o.kind !== "wallet" || Boolean(o.dest?.proved_at || o.dest?.attested);

  // 4. we lock it
  if (!(confirmed && proved)) steps.push({ key: "locked", label: "Checked and locked by us", state: "todo" });
  else if (o.dest.status === "locked") steps.push({ key: "locked",
    label: "Checked and locked by us", state: "done", summary: `Locked ${day(o.dest.locked_at)}` });
  else steps.push({ key: "locked", label: "Checked and locked by us", state: "wait",
    summary: "We are screening the address. Nothing needed from you." });

  // 5. paid
  if (o.paidHash) steps.push({ key: "paid", label: "Paid", state: "done", summary: "Confirmed on the chain" });
  else if (o.dest?.status === "locked") steps.push({ key: "paid", label: "Paid", state: "wait",
    summary: "Waiting for the sender. A test payment of one unit will arrive first." });
  else steps.push({ key: "paid", label: "Paid", state: "todo" });

  // 6. record
  if (o.sealed) steps.push({ key: "record", label: "Your record", state: "done",
    summary: "Sealed. Yours to keep." });
  else steps.push({ key: "record", label: "Your record", state: o.paidHash ? "wait" : "todo",
    summary: o.paidHash ? "Being sealed by us." : undefined });

  return steps;
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

export interface RecipientProgress {
  name: string;
  verified: boolean;
  locked: boolean;
  proved: boolean;
  paid: boolean;
}

/** One row per recipient: how far each has got. What a sender most wants to know. */
export async function recipientProgress(env: Env, txId: string): Promise<RecipientProgress[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id AS participation_id, y.id AS party_id, y.display_name,
            d.status AS dstatus, d.proved_at,
            EXISTS (SELECT 1 FROM address_attestations a
                     WHERE a.destination_id = d.id AND a.revoked_at IS NULL
                       AND lower(a.address) = lower(d.address)) AS attested,
            EXISTS (SELECT 1 FROM verifications v
                     WHERE v.party_id = y.id AND v.status = 'passed'
                       AND (v.expires_at IS NULL OR v.expires_at > datetime('now'))) AS verified,
            EXISTS (SELECT 1 FROM payout_legs l JOIN custody_events c ON c.id = l.event_id
                     WHERE l.participation_id = p.id AND c.event = 'sent') AS paid
       FROM participations p
       JOIN parties y ON y.id = p.party_id
       LEFT JOIN destinations d ON d.participation_id = p.id
      WHERE p.transaction_id = ? AND p.role = 'recipient'
      ORDER BY y.display_name`).bind(txId).all<any>();
  return (results ?? []).map((r) => ({
    name: r.display_name,
    verified: Boolean(r.verified),
    locked: r.dstatus === "locked",
    proved: Boolean(r.proved_at || r.attested),
    paid: Boolean(r.paid),
  }));
}

export function senderJourney(o: {
  cleared: { verified_at: string | null; expires_at: string | null } | null;
  submittedAt: string | null;
  wallets: { proved_at: string | null }[];
  recipients: RecipientProgress[];
  status: string;
  allPaid: boolean;
  sealed: boolean;
  onChain: boolean;
}): Step[] {
  const steps: Step[] = [];

  if (o.cleared) steps.push({ key: "verify", label: "Verify yourself", state: "done",
    summary: `Checked ${day(o.cleared.verified_at)}` +
      (o.cleared.expires_at ? `, good until ${day(o.cleared.expires_at)}` : "") });
  else if (o.submittedAt) steps.push({ key: "verify", label: "Verify yourself", state: "wait",
    summary: `Sent ${day(o.submittedAt)} — with us for checking.` });
  else steps.push({ key: "verify", label: "Verify yourself", state: "now" });
  const verified = steps[0].state === "done";

  if (o.onChain) {
    const proved = o.wallets.filter((w) => w.proved_at).length;
    const allProved = o.wallets.length > 0 && proved === o.wallets.length;
    if (!verified) steps.push({ key: "wallets", label: "Your sending wallets", state: "todo" });
    else if (allProved) steps.push({ key: "wallets", label: "Your sending wallets", state: "done",
      summary: `${o.wallets.length} wallet${o.wallets.length === 1 ? "" : "s"}, all proved` });
    else steps.push({ key: "wallets", label: "Your sending wallets", state: "now",
      summary: o.wallets.length ? `${proved} of ${o.wallets.length} proved` : undefined });
  }
  const walletsDone = !o.onChain || steps[steps.length - 1].state === "done";

  const ready = o.recipients.length > 0 &&
    o.recipients.every((r) => r.verified && r.locked && (!o.onChain || r.proved));
  const n = o.recipients.length;
  const done = o.recipients.filter((r) => r.verified && r.locked).length;
  if (!o.recipients.length) steps.push({ key: "recipients", label: "Your recipients", state: "todo" });
  else if (ready) steps.push({ key: "recipients", label: "Your recipients", state: "done",
    summary: `All ${n} verified and locked` });
  else steps.push({ key: "recipients", label: "Your recipients", state: "wait",
    summary: `${done} of ${n} ready — waiting on them, not on you` });

  const canSend = o.status === "ready" || o.status === "settling";
  if (o.allPaid) steps.push({ key: "send", label: "Send", state: "done",
    summary: "Every payment confirmed on the chain" });
  else if (canSend && verified && walletsDone) steps.push({ key: "send", label: "Send", state: "now" });
  else if (ready && verified && walletsDone) steps.push({ key: "send", label: "Send", state: "wait",
    summary: "We are checking the gate. You will get an email when you can send." });
  else steps.push({ key: "send", label: "Send", state: "todo" });

  if (o.sealed) steps.push({ key: "record", label: "Complete", state: "done",
    summary: "Record sealed. Everyone has their copy." });
  else steps.push({ key: "record", label: "Complete", state: o.allPaid ? "wait" : "todo",
    summary: o.allPaid ? "We are sealing the record." : undefined });

  return steps;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MARK: Record<State, string> = { done: "&#10003;", now: "&rarr;", wait: "&hellip;", todo: "" };

/** The strip across the top: every step, its state visible at a glance. */
export function strip(steps: Step[]): string {
  return `<ol class="journey">${steps.map((s, i) => `
    <li class="j-${s.state}">
      <span class="jn">${MARK[s.state] || i + 1}</span>
      <span class="jl">${esc(s.label)}</span>
    </li>`).join("")}</ol>`;
}

/** A step that is not the open one, as a single line. */
export function line(s: Step): string {
  if (s.state === "now") return "";
  const cls = s.state === "done" ? "done" : s.state === "wait" ? "wait" : "todo";
  return `<div class="step-line ${cls}">
    <span class="sl-mark">${s.state === "done" ? "&#10003;" : s.state === "wait" ? "&hellip;" : "&#9675;"}</span>
    <span class="sl-body"><b>${esc(s.label)}</b>${s.summary
      ? `<span class="sl-sum">${esc(s.summary)}</span>` : ""}</span>
  </div>`;
}

/** The sender's view of everyone else. */
export function progressTable(rows: RecipientProgress[], onChain: boolean): string {
  const tick = (b: boolean) => b ? `<span class="good">&#10003;</span>` : `<span class="muted">&#8212;</span>`;
  return `<table class="progress">
    <tr><th>Recipient</th><th>Verified</th>${onChain ? "<th>Wallet proved</th>" : ""}<th>Locked</th><th>Paid</th></tr>
    ${rows.map((r) => `<tr>
      <td>${esc(r.name)}</td><td>${tick(r.verified)}</td>${onChain ? `<td>${tick(r.proved)}</td>` : ""}
      <td>${tick(r.locked)}</td><td>${tick(r.paid)}</td></tr>`).join("")}
  </table>`;
}

/** Everything the deal page needs about payments and the seal, in one place. */
export async function outcome(env: Env, txId: string) {
  const [legRows, sealRows] = await Promise.all([payoutLegs(env, txId), seals(env, txId)]);
  return {
    paidFor: (participationId: string) =>
      legRows.find((l) => l.participationId === participationId)?.txHash ?? null,
    allPaid: legRows.length > 0 && legRows.every((l) => l.txHash),
    sealed: sealRows.length > 0,
  };
}

export const JOURNEY_CSS = `
.journey{list-style:none;margin:0 0 22px;padding:0;display:flex;gap:6px;flex-wrap:wrap}
.journey li{display:flex;align-items:center;gap:8px;padding:7px 12px 7px 8px;border-radius:999px;
  border:1px solid var(--rule);background:#fff;font-size:13.5px;font-weight:600;color:var(--text)}
.journey .jn{width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;
  justify-content:center;font-size:12px;font-weight:800;background:var(--panel);color:var(--text)}
.journey .j-done{border-color:#B7E0C9;background:#EAF7F0;color:#14603A}
.journey .j-done .jn{background:var(--good);color:#fff}
.journey .j-now{border-color:var(--accent);background:#FFF3ED;color:#8A3B1E}
.journey .j-now .jn{background:var(--accent);color:var(--ink)}
.journey .j-wait{border-color:#F2C79A;background:#FFF6EC;color:#8A5A1E}
.journey .j-wait .jn{background:#F2C79A;color:#5A3A12}
.journey .j-todo{opacity:.62}
.step-line{display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:baseline;
  padding:12px 16px;border-radius:12px;margin-bottom:10px;border:1px solid var(--rule);background:#fff}
.step-line.done{background:#EAF7F0;border-color:#B7E0C9}
.step-line.done .sl-mark{color:var(--good);font-weight:800}
.step-line.wait{background:#FFF6EC;border-color:#F2C79A}
.step-line.wait .sl-mark{color:#8A5A1E}
.step-line.todo{opacity:.7}
.step-line b{color:var(--ink);font-weight:700}
.sl-sum{display:block;font-size:14.5px;color:var(--text);margin-top:2px;word-break:break-all}
.stage{display:inline-block;padding:3px 11px;border-radius:20px;font-size:12.5px;font-weight:700;
  background:#FFF6EC;border:1px solid #F2C79A;color:#8A5A1E}
.stage.ok{background:#EAF7F0;border-color:#B7E0C9;color:#14603A}
table.progress{width:100%;border-collapse:collapse;font-size:15px;margin-top:6px}
table.progress th,table.progress td{text-align:left;padding:8px 8px;border-bottom:1px solid var(--rule)}
table.progress th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink)}
table.progress tr:last-child td{border-bottom:0}
`;
