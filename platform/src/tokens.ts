/**
 * Magic links and client sessions.
 *
 * Everything a client can do begins with a link in an email, so this is the
 * part worth being careful about. The rules:
 *
 *   - The secret is 32 random bytes and is never stored. Only its SHA-256 is,
 *     so a stolen copy of the database is not a working key to anybody's
 *     transaction.
 *   - A link is bound to one email address. Forwarded to somebody else it
 *     still only opens the account it was issued for.
 *   - A link is spent the first time it is exchanged for a session, and a
 *     second attempt is recorded rather than merely refused — someone trying
 *     a used link is worth seeing in the log.
 *   - Sessions live in the database, not only in a cookie, so removing
 *     somebody ends their access now rather than whenever their cookie
 *     expires.
 */

import { type Env, type Actor, id, log } from "./db.ts";

const TOKEN_COOKIE = "tpm_client";
const SESSION_DAYS = 14;

/** How long someone has to use a link before it stops working. */
// A return link only has to survive the walk to another desk, so it expires
// quickly. An invitation is a different thing and keeps its longer life.
const LIFETIME_DAYS: Record<string, number> = { start: 14, join: 21, return: 1 };

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function secret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface Minted { url: string; tokenId: string }

/**
 * Make a link and record its hash. The returned URL is the only place the
 * secret will ever exist on our side — it goes straight into an email.
 */
export async function mint(env: Env, actor: Actor, opts: {
  purpose: "start" | "join" | "return";
  email: string;
  base: string;
  transactionId?: string;
  participationId?: string;
  /** For a return link: the party being let back in. */
  partyId?: string;
}): Promise<Minted> {
  const value = secret();
  const tokenId = id("tok");
  await env.DB.prepare(
    `INSERT INTO tokens (id, hash, purpose, email, transaction_id,
                         participation_id, party_id, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(tokenId, await sha256(value), opts.purpose, opts.email.toLowerCase(),
    opts.transactionId ?? null, opts.participationId ?? null,
    opts.partyId ?? null,
    daysFromNow(LIFETIME_DAYS[opts.purpose] ?? 14), actor.id).run();

  await log(env.DB, actor, `token.${opts.purpose}_minted`, "tokens", tokenId,
    { note: `for ${opts.email}` });

  const path = opts.purpose === "start" ? "start"
             : opts.purpose === "return" ? "back" : "join";
  const url = `${opts.base}/${path}/${value}`;
  // The secret is never stored, so in development it would otherwise be
  // unreachable without a working mail provider.
  if (opts.base.includes("127.0.0.1") || opts.base.includes("localhost")) {
    console.log(`[dev] ${opts.purpose} link for ${opts.email}: ${url}`);
  }
  return { url, tokenId };
}

export interface Opened {
  tokenId: string;
  email: string;
  purpose: string;
  transactionId: string | null;
  participationId: string | null;
  /** Set on a return link: the party being let back in. */
  partyId: string | null;
}

/**
 * Look a link up without spending it — for rendering the page it points at.
 *
 * A spent link is as dead here as it is in redeem(). This checked only expiry
 * to begin with, which meant a sender's setup link kept opening its form after
 * it had been used: the submission was refused later, but the page with the
 * client's details on it was served to anyone holding the URL.
 */
export async function peek(env: Env, value: string): Promise<Opened | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, purpose, transaction_id, participation_id, party_id,
            expires_at, used_at
       FROM tokens WHERE hash = ?`).bind(await sha256(value)).first<any>();
  if (!row) return null;
  if (row.used_at) return null;
  if (row.expires_at < now()) return null;
  return {
    tokenId: row.id, email: row.email, purpose: row.purpose,
    transactionId: row.transaction_id, participationId: row.participation_id,
    partyId: row.party_id ?? null,
  };
}

/**
 * Spend a link and open a session.
 *
 * A link already used does not silently work again: the attempt is logged with
 * its address, because a used link being tried is either a confused client or
 * something worse, and both are worth knowing about.
 */
export async function redeem(env: Env, value: string, partyId: string,
                             request: Request): Promise<string | null> {
  const hash = await sha256(value);
  const ip = request.headers.get("CF-Connecting-IP") ?? null;
  const row = await env.DB.prepare(
    "SELECT id, used_at, expires_at FROM tokens WHERE hash = ?").bind(hash).first<any>();
  if (!row) return null;

  if (row.used_at || row.expires_at < now()) {
    await log(env.DB, { kind: "system", id: null, ip: ip ?? undefined },
      "token.reuse_attempt", "tokens", row.id,
      { note: row.used_at ? `already used at ${row.used_at}` : "expired" });
    return null;
  }

  const value2 = secret();
  const sessionId = id("ses");
  await env.DB.batch([
    env.DB.prepare("UPDATE tokens SET used_at = ?, used_ip = ? WHERE id = ?")
      .bind(now(), ip, row.id),
    env.DB.prepare(
      `INSERT INTO sessions (id, hash, party_id, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, await sha256(value2), partyId, daysFromNow(SESSION_DAYS),
        ip, (request.headers.get("User-Agent") ?? "").slice(0, 200)),
  ]);
  await log(env.DB, { kind: "party", id: partyId, ip: ip ?? undefined },
    "session.opened", "sessions", sessionId, { note: `from token ${row.id}` });
  return value2;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function sessionCookie(value: string): string {
  return `${TOKEN_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; ` +
         `Max-Age=${SESSION_DAYS * 86_400}`;
}

export const clearSession =
  `${TOKEN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/** The party this request belongs to, or null. Checked against the database
 *  every time, so revoking a session takes effect on the next click. */
export async function whoIs(env: Env, request: Request): Promise<
  { partyId: string; sessionId: string } | null> {
  const raw = request.headers.get("Cookie") ?? "";
  let value: string | null = null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === TOKEN_COOKIE) value = v.join("=");
  }
  if (!value) return null;

  const row = await env.DB.prepare(
    `SELECT id, party_id, expires_at, revoked_at FROM sessions WHERE hash = ?`)
    .bind(await sha256(value)).first<any>();
  if (!row || row.revoked_at || row.expires_at < now()) return null;
  return { partyId: row.party_id, sessionId: row.id };
}

export async function endSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
    .bind(now(), sessionId).run();
}
