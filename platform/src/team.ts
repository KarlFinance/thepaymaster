/**
 * Organisation accounts: several people acting for one party.
 *
 * A company on a transaction is one party with one email — whoever holds
 * that email is the company as far as the platform knows. Real companies have
 * a finance director who approves, an assistant who prepares, an accountant
 * who only needs to read. Membership gives each of them their own login (their
 * own identity, their own KYC) and a role on the organisation:
 *
 *   owner     — the organisation's own login, or a member made owner: manages
 *               the team and can do everything an approver can
 *   approver  — sends payments and signs; must be verified themselves
 *   preparer  — enters recipients, details and wallets; cannot send
 *   viewer    — reads; downloads the dossier; nothing else
 *
 * The audit trail always names the human. An action taken for an organisation
 * is logged by the member's own party id with the organisation in the note,
 * never as the organisation itself: "the company approved it" is not a fact,
 * "Ms Patel, approver for the company, approved it" is.
 */

import { type Env, type Actor, id, insert, update, log } from "./db.ts";
import { esc } from "./views.ts";
import { mint } from "./tokens.ts";
import { teamInvited } from "./notify.ts";

export type Role = "owner" | "approver" | "preparer" | "viewer";
export const ROLES: Role[] = ["owner", "approver", "preparer", "viewer"];
const RANK: Record<Role, number> = { viewer: 0, preparer: 1, approver: 2, owner: 3 };

export interface Member {
  id: string; party_id: string; member_party_id: string; email: string; name: string;
  role: Role; invited_by: string; invited_at: string; accepted_at: string | null; revoked_at: string | null;
}

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/** Every party this person may act as: themselves, then each organisation they belong to. */
export async function principals(env: Env, partyId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT party_id FROM party_members WHERE member_party_id = ? AND revoked_at IS NULL`)
    .bind(partyId).all<any>();
  // Membership is accepted by turning up: the first time the invited person
  // signs in and something asks who they may act for, they are in.
  await env.DB.prepare(
    "UPDATE party_members SET accepted_at = ? WHERE member_party_id = ? AND revoked_at IS NULL AND accepted_at IS NULL")
    .bind(stamp(), partyId).run();
  return [partyId, ...(results ?? []).map((r: any) => String(r.party_id))];
}

/** The role this person holds on a principal. Their own party: owner. */
export async function roleFor(env: Env, partyId: string, principalId: string): Promise<Role | null> {
  if (partyId === principalId) return "owner";
  const row = await env.DB.prepare(
    "SELECT role FROM party_members WHERE member_party_id = ? AND party_id = ? AND revoked_at IS NULL")
    .bind(partyId, principalId).first<any>();
  return (row?.role as Role) ?? null;
}

export function atLeast(role: Role | null, need: Role): boolean {
  return role !== null && RANK[role] >= RANK[need];
}

/**
 * The participation a signed-in person may act on for a transaction — their
 * own, or one belonging to an organisation they are a member of — with the
 * role they hold there. Null when they have no business on it.
 */
export async function resolveParticipant(env: Env, who: { partyId: string }, txId: string, select: string):
    Promise<{ part: any; principalId: string; role: Role; actingFor: any | null } | null> {
  const mine = await principals(env, who.partyId);
  const marks = mine.map(() => "?").join(",");
  const part = await env.DB.prepare(
    `SELECT p.party_id AS principal_party_id, ${select}
       FROM participations p JOIN transactions t ON t.id = p.transaction_id
      WHERE p.transaction_id = ? AND p.party_id IN (${marks})
      ORDER BY CASE WHEN p.party_id = ? THEN 0 ELSE 1 END LIMIT 1`)
    .bind(txId, ...mine, who.partyId).first<any>();
  if (!part) return null;
  const principalId = String(part.principal_party_id);
  const role = (await roleFor(env, who.partyId, principalId)) ?? "viewer";
  const actingFor = principalId === who.partyId ? null
    : await env.DB.prepare("SELECT id, display_name, legal_name, kind FROM parties WHERE id = ?").bind(principalId).first<any>();
  return { part, principalId, role, actingFor };
}

/** An actor for the audit log that names the human and the organisation. */
export function actorFor(who: { partyId: string }, request: Request, actingFor: any | null): Actor {
  const a: Actor = { kind: "party", id: who.partyId, ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  if (actingFor) (a as any).onBehalfOf = actingFor.display_name;
  return a;
}

// --- managing the team ------------------------------------------------------------

export async function membersOf(env: Env, partyId: string): Promise<Member[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.*, y.email, y.display_name AS name FROM party_members m JOIN parties y ON y.id = m.member_party_id
      WHERE m.party_id = ? ORDER BY m.revoked_at IS NOT NULL, m.invited_at`).bind(partyId).all<any>();
  return (results ?? []) as Member[];
}

export async function inviteMember(env: Env, actor: Actor, o: {
  partyId: string; email: string; name: string; role: Role; base: string; invitedByName: string;
}): Promise<string | null> {
  const email = o.email.trim().toLowerCase();
  const name = o.name.trim().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "That email address does not look right.";
  if (name.length < 2) return "Give the person's name.";
  if (!ROLES.includes(o.role)) return "Choose a role.";
  const org = await env.DB.prepare("SELECT id, display_name, email FROM parties WHERE id = ?").bind(o.partyId).first<any>();
  if (!org) return "No such organisation.";
  if (org.email.toLowerCase() === email) return "That is the organisation's own login; it is already the owner.";

  // The member is a party in their own right, existing or new.
  let member = await env.DB.prepare("SELECT id FROM parties WHERE lower(email) = ?").bind(email).first<any>();
  if (!member) {
    const pid = id("pty");
    await insert(env.DB, actor, "party.created", "parties", pid,
      { kind: "individual", display_name: name, email }, { note: `invited to act for ${org.display_name}` });
    member = { id: pid };
  }
  const existing = await env.DB.prepare(
    "SELECT id, revoked_at FROM party_members WHERE party_id = ? AND member_party_id = ?").bind(o.partyId, member.id).first<any>();
  if (existing && !existing.revoked_at) return "They are already on the team. Revoke them first to change the role.";

  const mid = id("mem");
  await insert(env.DB, actor, "team.invited", "party_members", mid, {
    party_id: o.partyId, member_party_id: member.id, role: o.role,
    invited_by: actor.id ?? "unknown", invited_at: stamp(),
  }, { note: `${name} <${email}> as ${o.role} for ${org.display_name}` });

  // A return link is a login; the invitation email carries it.
  const { url } = await mint(env, actor, { purpose: "return", email, base: o.base, partyId: member.id });
  await teamInvited(env, actor, mid, url, o.invitedByName);
  return null;
}

export async function revokeMember(env: Env, actor: Actor, memberRowId: string, partyId?: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT * FROM party_members WHERE id = ?").bind(memberRowId).first<any>();
  if (!row) return "No such team member.";
  if (partyId && row.party_id !== partyId) return "That member is not on your team.";
  if (row.revoked_at) return null;
  await update(env.DB, actor, "team.revoked", "party_members", memberRowId,
    { revoked_at: stamp() }, { revoked_at: null }, { note: `${row.role} removed` });
  return null;
}

/** The team panel: members and an invitation form. Shared by the party's page and the staff page. */
export function teamPanel(members: Member[], action: string, o: { error?: string; canManage: boolean }): string {
  const rows = members.map((m) => `<tr>
    <td>${esc(m.name)}<div class="muted">${esc(m.email)}</div></td>
    <td><span class="tag">${esc(m.role)}</span></td>
    <td class="muted">${m.revoked_at ? `removed ${esc(String(m.revoked_at).slice(0, 10))}`
      : m.accepted_at ? `active since ${esc(String(m.accepted_at).slice(0, 10))}` : `invited ${esc(String(m.invited_at).slice(0, 10))} — not yet signed in`}</td>
    <td>${!m.revoked_at && o.canManage ? `<form method="post" action="${esc(action)}" style="margin:0">
        <input type="hidden" name="revoke" value="${esc(m.id)}"><button class="plain small">Remove</button></form>` : ""}</td>
  </tr>`).join("");
  return `
    ${o.error ? `<div class="err">${esc(o.error)}</div>` : ""}
    ${members.length ? `<table class="log" style="margin-bottom:12px"><tr><th>Who</th><th>Role</th><th>State</th><th></th></tr>${rows}</table>`
      : `<p class="muted">Nobody else yet.</p>`}
    ${o.canManage ? `<form method="post" action="${esc(action)}">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div style="flex:1;min-width:160px"><label for="mn">Name</label><input id="mn" name="name" required maxlength="120" placeholder="Priya Patel"></div>
        <div style="flex:1;min-width:200px"><label for="me">Email</label><input id="me" name="email" type="email" required placeholder="priya@company.com"></div>
        <div><label for="mr">Role</label>
          <select id="mr" name="role">
            <option value="preparer">Preparer — enters details, cannot send</option>
            <option value="approver">Approver — sends and signs</option>
            <option value="viewer">Viewer — reads only</option>
            <option value="owner">Owner — manages the team too</option>
          </select></div>
        <button class="go">Invite</button>
      </div>
      <p class="muted" style="font-size:13px;margin:8px 0 0">They get their own login and their own identity check. An approver must be verified
        before they can send. Every action is recorded against the person, with the organisation named.</p>
    </form>` : ""}`;
}
