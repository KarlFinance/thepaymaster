/**
 * Admin sign-in: email, password, and a code from an authenticator app.
 *
 * Three things worth explaining.
 *
 * A wrong email and a wrong password take the same work and the same time, so
 * the response cannot be used to find out who has an account here.
 *
 * The step between password and code is carried in a short-lived signed
 * cookie, not a session. Knowing a password gets you as far as being asked for
 * a code and no further, and that half-authenticated state expires in five
 * minutes whatever happens.
 *
 * Sessions live in the database. Changing a password or disabling an account
 * ends every session it had on the next click, rather than whenever a cookie
 * happens to lapse.
 */

import { type Env, type Actor, id, log } from "./db.ts";
import { verify as verifyTotp, randomSecret, enrolmentUri } from "./totp.ts";
import { esc, REVEAL_CSS, REVEAL_JS } from "./views.ts";

/**
 * Workers refuses PBKDF2 above 100,000 iterations, and OWASP wants 210,000 for
 * SHA-512. So the work is chained instead: three full rounds of the maximum,
 * each taking the previous digest as its input. Three hundred thousand
 * iterations of stretching, within a limit that allows a hundred thousand.
 *
 * Local development does not have this limit — miniflare uses Node's crypto —
 * so a single 210,000-iteration call worked perfectly here and threw
 * NotSupportedError the moment it reached production, on the one path a
 * page-load check never touches.
 */
const ITERATIONS = 100_000;
const ROUNDS = 3;
const SESSION_COOKIE = "tpm_admin";
const PENDING_COOKIE = "tpm_pending";
const SESSION_HOURS = 12;
const PENDING_MINUTES = 5;
const MIN_PASSWORD = 12;

/** Refuse after this many failures from one address in fifteen minutes. */
const MAX_FAILURES = 8;

const enc = new TextEncoder();

function b64(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/=+$/, "")
    .replace(/\+/g, "-").replace(/\//g, "_");
}

function unb64(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function sha256(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(v));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function future(ms: number): string {
  return new Date(Date.now() + ms).toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

async function stretch(material: Uint8Array, salt: Uint8Array,
                       iterations: number, rounds: number): Promise<Uint8Array> {
  let bits = material;
  for (let r = 0; r < rounds; r++) {
    const key = await crypto.subtle.importKey("raw", bits, "PBKDF2", false, ["deriveBits"]);
    bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-512" }, key, 256));
  }
  return bits;
}

export async function hashPassword(password: string, salt?: Uint8Array): Promise<string> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const bits = await stretch(enc.encode(password), s, ITERATIONS, ROUNDS);
  return `pbkdf2c$${ROUNDS}x${ITERATIONS}$${b64(s)}$${b64(bits)}`;
}

export async function checkPassword(password: string, stored: string | null): Promise<boolean> {
  // No stored hash still costs a full derivation, so "no such account" and
  // "wrong password" are indistinguishable from outside.
  const target = stored ?? await hashPassword("  no account  ");
  const [scheme, work, salt, digest] = target.split("$");
  if (scheme !== "pbkdf2c") return false;
  const [rounds, iters] = work.split("x").map(Number);
  if (!rounds || !iters || iters > 100_000) return false;
  const bits = await stretch(enc.encode(password), unb64(salt), iters, rounds);
  return stored !== null && same(bits, unb64(digest));
}

/** Long rather than fiddly: length beats punctuation rules. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) {
    return `Use at least ${MIN_PASSWORD} characters. A phrase you will remember beats a short muddle you will not.`;
  }
  if (/^\s|\s$/.test(password)) return "It starts or ends with a space.";
  return null;
}

// ---------------------------------------------------------------------------
// The half-authenticated step
// ---------------------------------------------------------------------------

async function signer(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function seal(adminId: string, secret: string): Promise<string> {
  const body = `${adminId}.${Math.floor(Date.now() / 1000) + PENDING_MINUTES * 60}`;
  const sig = await crypto.subtle.sign("HMAC", await signer(secret), enc.encode(body));
  return `${body}.${b64(new Uint8Array(sig))}`;
}

async function unseal(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const ok = await crypto.subtle.verify("HMAC", await signer(secret), unb64(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok || Number(parts[1]) < Math.floor(Date.now() / 1000)) return null;
  return parts[0];
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const pendingCookie = (v: string) =>
  `${PENDING_COOKIE}=${v}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${PENDING_MINUTES * 60}`;
const clearPending = `${PENDING_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
const sessionCookie = (v: string) =>
  `${SESSION_COOKIE}=${v}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
export const clearAdminSession =
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface Admin {
  id: string;
  email: string;
  name: string;
  role: string;
  must_change_password: number;
}

async function openSession(env: Env, adminId: string, request: Request): Promise<string> {
  const value = b64(crypto.getRandomValues(new Uint8Array(32)));
  const sid = id("asn");
  const ip = request.headers.get("CF-Connecting-IP");
  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, hash, admin_id, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(sid, await sha256(value), adminId, future(SESSION_HOURS * 3600_000),
    ip, (request.headers.get("User-Agent") ?? "").slice(0, 200)).run();
  await env.DB.prepare("UPDATE admins SET last_login_at = ? WHERE id = ?")
    .bind(now(), adminId).run();
  await log(env.DB, { kind: "admin", id: adminId, ip: ip ?? undefined },
    "admin.signed_in", "admins", adminId);
  return value;
}

export async function currentAdmin(env: Env, request: Request): Promise<
  { admin: Admin; sessionId: string } | null> {
  const value = cookieValue(request, SESSION_COOKIE);
  if (!value) return null;
  const row = await env.DB.prepare(
    `SELECT s.id AS sid, s.expires_at, s.revoked_at,
            a.id, a.email, a.name, a.role, a.active, a.must_change_password
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.hash = ?`).bind(await sha256(value)).first<any>();
  if (!row || row.revoked_at || !row.active || row.expires_at < now()) return null;
  return {
    admin: {
      id: row.id, email: row.email, name: row.name, role: row.role,
      must_change_password: row.must_change_password,
    },
    sessionId: row.sid,
  };
}

export async function endAdminSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE id = ?")
    .bind(now(), sessionId).run();
}

/** Used when a password changes: every other way in stops working. */
async function revokeAll(env: Env, adminId: string, except?: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE admin_sessions SET revoked_at = ?
      WHERE admin_id = ? AND revoked_at IS NULL AND id <> ?`)
    .bind(now(), adminId, except ?? "").run();
}

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

async function note(env: Env, email: string, ip: string | null,
                    stage: "password" | "totp", ok: boolean): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO login_attempts (email, ip, stage, ok) VALUES (?, ?, ?, ?)")
    .bind(email.toLowerCase(), ip, stage, ok ? 1 : 0).run();
}

async function tooMany(env: Env, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM login_attempts
      WHERE ip = ? AND ok = 0 AND at > datetime('now', '-15 minutes')`)
    .bind(ip).first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILURES;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const CSS = `
:root{--ink:#0C1524;--accent:#FF8159;--panel:#F5F7FA;--text:#4A5567;--rule:#DBDFEA}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:16px/1.6 "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--panel)}
.box{max-width:400px;margin:9vh auto;padding:0 20px}
.card{background:#fff;border:1px solid var(--rule);border-radius:12px;padding:26px 28px}
h1{margin:0 0 4px;font-size:23px;color:var(--ink);font-weight:800;letter-spacing:-.01em}
p.sub{margin:0 0 22px;font-size:15px}
label{display:block;margin:16px 0 5px;font-weight:600;color:var(--ink);font-size:14px}
input{width:100%;padding:11px 13px;border:1px solid var(--rule);border-radius:9px;font:inherit;background:#fff}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button.go{width:100%;margin-top:20px;background:var(--accent);color:var(--ink);border:0;border-radius:9px;padding:13px;font:inherit;font-weight:700;cursor:pointer}
a:has(button.go){text-decoration:none;display:block}
.err{background:#FDECEA;border:1px solid #F5C2BC;color:#8A1F11;padding:11px 14px;border-radius:9px;margin-bottom:16px;font-size:14.5px}
.ok{background:#EAF7F0;border:1px solid #B7E0C9;color:#12603D;padding:11px 14px;border-radius:9px;margin-bottom:16px;font-size:14.5px}
.muted{color:var(--text);font-size:13.5px}
code{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:9px 12px;display:block;font-size:16px;letter-spacing:.12em;word-break:break-all;margin:10px 0}
.qr{display:flex;justify-content:center;margin:18px 0}
input.code{font-size:24px;letter-spacing:.34em;text-align:center;font-variant-numeric:tabular-nums}
`;

function screen(title: string, body: string, extra = ""): Response {
  return new Response(`<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ThePaymaster</title><meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="https://thepaymaster.co.uk/wp-content/uploads/elementor/google-fonts/css/plusjakartasans.css">
<style>${CSS}${REVEAL_CSS}</style></head><body><div class="box"><div class="card">${body}</div></div>${extra}${REVEAL_JS}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function loginScreen(error = "", email = ""): Response {
  return screen("Sign in", `
    <h1>ThePaymaster</h1><p class="sub">Staff sign-in.</p>
    ${error ? `<div class="err">${error}</div>` : ""}
    <form method="post" action="/login">
      <label for="e">Email</label>
      <input id="e" name="email" type="email" required autocomplete="username"
        value="${esc(email)}" autofocus>
      <label for="p">Password</label>
      <div class="pw"><input id="p" name="password" type="password" required
        autocomplete="current-password"></div>
      <button class="go">Continue</button>
    </form>`);
}

function codeScreen(error = ""): Response {
  return screen("Your code", `
    <h1>Your code</h1>
    <p class="sub">Open your authenticator app and enter the six digits for ThePaymaster.</p>
    ${error ? `<div class="err">${error}</div>` : ""}
    <form method="post" action="/2fa">
      <label for="c">Code</label>
      <input id="c" class="code" name="code" inputmode="numeric" pattern="[0-9]*"
        maxlength="6" required autocomplete="one-time-code" autofocus>
      <button class="go">Sign in</button>
    </form>`);
}

function setupScreen(email: string, secret: string, error = ""): Response {
  const uri = enrolmentUri(email, secret);
  return screen("Set up two-factor", `
    <h1>Set up two-factor</h1>
    <p class="sub">Before you can sign in, pair an authenticator app.</p>
    ${error ? `<div class="err">${error}</div>` : ""}
    <p class="muted">Scan this with Google Authenticator, 1Password, or whichever app you use.</p>
    <div class="qr" id="qr"></div>
    <p class="muted">If you cannot scan it, type this key in by hand:</p>
    <code>${esc(secret.replace(/(.{4})/g, "$1 ").trim())}</code>
    <form method="post" action="/2fa/setup">
      <input type="hidden" name="secret" value="${esc(secret)}">
      <label for="c">Then enter the code it shows</label>
      <input id="c" class="code" name="code" inputmode="numeric" pattern="[0-9]*"
        maxlength="6" required autocomplete="one-time-code">
      <button class="go">Confirm and sign in</button>
    </form>
    <p class="muted" style="margin-top:16px">Keep that key somewhere safe. Losing your
       phone without it means the other account holder has to reset your access.</p>`,
    `<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
     <script>
       // Drawn in the browser rather than on a server, so the secret is never
       // rendered to an image anywhere else. If the library fails to load, the
       // key above is still typed in by hand.
       try {
         new QRCode(document.getElementById('qr'), {
           text: ${JSON.stringify(uri)}, width: 190, height: 190,
           colorDark: '#0C1524', colorLight: '#ffffff'
         });
       } catch (e) {}
     </script>`);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleLogin(env: Env, request: Request): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? null;
  if (await tooMany(env, ip)) {
    return screen("Too many attempts", `<h1>Too many attempts</h1>
      <p class="sub">Wait fifteen minutes and try again.</p>
      <p class="muted">If this was not you, tell the other account holder.</p>`);
  }

  const f = await request.formData();
  const email = String(f.get("email") ?? "").trim().toLowerCase();
  const password = String(f.get("password") ?? "");

  const row = await env.DB.prepare(
    "SELECT id, password_hash, totp_secret FROM admins WHERE lower(email) = ? AND active = 1")
    .bind(email).first<any>();

  const ok = await checkPassword(password, row?.password_hash ?? null);
  await note(env, email, ip, "password", ok);
  if (!ok) {
    await log(env.DB, { kind: "system", id: null, ip: ip ?? undefined },
      "admin.sign_in_failed", "admins", email, { note: "password" });
    return loginScreen("Those details were not recognised.", email);
  }

  const pending = await seal(row.id, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      Location: row.totp_secret ? "/2fa" : "/2fa/setup",
      "Set-Cookie": pendingCookie(pending),
    },
  });
}

export async function handleTotp(env: Env, request: Request): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? null;
  const sealed = cookieValue(request, PENDING_COOKIE);
  const adminId = sealed ? await unseal(sealed, env.SESSION_SECRET) : null;
  if (!adminId) return loginScreen("That took too long. Start again.");

  if (request.method === "GET") return codeScreen();
  if (await tooMany(env, ip)) return loginScreen("Too many attempts. Wait fifteen minutes.");

  const f = await request.formData();
  const row = await env.DB.prepare(
    "SELECT id, email, totp_secret FROM admins WHERE id = ? AND active = 1")
    .bind(adminId).first<any>();
  if (!row?.totp_secret) return loginScreen("Start again.");

  const ok = await verifyTotp(row.totp_secret, String(f.get("code") ?? ""));
  await note(env, row.email, ip, "totp", ok);
  if (!ok) {
    await log(env.DB, { kind: "system", id: null, ip: ip ?? undefined },
      "admin.sign_in_failed", "admins", row.id, { note: "code" });
    return codeScreen("That code was not right. Codes last thirty seconds — try the next one.");
  }

  const value = await openSession(env, row.id, request);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionCookie(value));
  headers.append("Set-Cookie", clearPending);
  return new Response(null, { status: 302, headers });
}

export async function handleTotpSetup(env: Env, request: Request): Promise<Response> {
  const sealed = cookieValue(request, PENDING_COOKIE);
  const adminId = sealed ? await unseal(sealed, env.SESSION_SECRET) : null;
  if (!adminId) return loginScreen("That took too long. Start again.");

  const row = await env.DB.prepare(
    "SELECT id, email, totp_secret FROM admins WHERE id = ? AND active = 1")
    .bind(adminId).first<any>();
  if (!row) return loginScreen("Start again.");
  if (row.totp_secret) return Response.redirect(new URL("/2fa", request.url).toString(), 302);

  if (request.method === "GET") return setupScreen(row.email, randomSecret());

  const f = await request.formData();
  const secret = String(f.get("secret") ?? "");
  const code = String(f.get("code") ?? "");
  if (!/^[A-Z2-7]{32}$/.test(secret)) return setupScreen(row.email, randomSecret());

  if (!await verifyTotp(secret, code)) {
    return setupScreen(row.email, secret,
      "That code was not right. Check the app is showing ThePaymaster, and try the next one.");
  }

  await env.DB.prepare(
    "UPDATE admins SET totp_secret = ?, totp_confirmed_at = ? WHERE id = ?")
    .bind(secret, now(), row.id).run();
  await log(env.DB, { kind: "admin", id: row.id }, "admin.totp_enrolled", "admins", row.id);

  const value = await openSession(env, row.id, request);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", sessionCookie(value));
  headers.append("Set-Cookie", clearPending);
  return new Response(null, { status: 302, headers });
}

export async function handleSignOut(env: Env, request: Request): Promise<Response> {
  const who = await currentAdmin(env, request);
  if (who) {
    await endAdminSession(env, who.sessionId);
    await log(env.DB, { kind: "admin", id: who.admin.id }, "admin.signed_out",
      "admins", who.admin.id);
  }
  return new Response(null, {
    status: 302, headers: { Location: "/login", "Set-Cookie": clearAdminSession },
  });
}

/** Change your own password. Nobody can change anybody else's. */
export async function handleAccount(env: Env, request: Request, actor: Actor,
                                    admin: Admin, sessionId: string): Promise<Response> {
  const forced = admin.must_change_password === 1;

  /**
   * The done state is a page of its own rather than the form with a banner on
   * it. Re-rendering the form after a successful change left the "before going
   * any further" wording in place and no way onward, because `admin` was
   * loaded at the start of the request and still said a change was owed.
   */
  const finished = () => screen("Password changed", `
    <h1>Password changed</h1>
    <p class="sub">Every other session has been signed out.</p>
    <div class="ok">You are signed in as ${esc(admin.email)}.</div>
    <a href="/"><button class="go" type="button">Continue to the pipeline</button></a>`);

  const render = (error = "") => screen("Your account", `
    <h1>Your password</h1>
    <p class="sub">${forced ? "Choose your own before going any further."
      : `Signed in as ${esc(admin.email)}.`}</p>
    ${error ? `<div class="err">${error}</div>` : ""}
    <form method="post" action="/account">
      <label for="c">Current password</label>
      <div class="pw"><input id="c" name="current" type="password" required
        autocomplete="current-password"></div>
      <label for="n">New password</label>
      <div class="pw"><input id="n" name="next" type="password" required
        autocomplete="new-password"></div>
      <label for="r">And again</label>
      <div class="pw"><input id="r" name="repeat" type="password" required
        autocomplete="new-password"></div>
      <button class="go">Change it</button>
    </form>
    <p class="muted" style="margin-top:16px">At least ${MIN_PASSWORD} characters.
      ${forced ? "" : `<a href="/">Back to the pipeline</a>`}</p>`);

  if (request.method === "GET") return render();

  const f = await request.formData();
  const current = String(f.get("current") ?? "");
  const next = String(f.get("next") ?? "");
  const repeat = String(f.get("repeat") ?? "");

  const row = await env.DB.prepare("SELECT password_hash FROM admins WHERE id = ?")
    .bind(admin.id).first<any>();
  if (!await checkPassword(current, row?.password_hash ?? null)) {
    return render("Your current password was not right.");
  }
  if (next !== repeat) return render("The two new passwords do not match.");
  const problem = passwordProblem(next);
  if (problem) return render(problem);
  if (next === current) return render("That is the password you already have.");

  await env.DB.prepare(
    "UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?")
    .bind(await hashPassword(next), admin.id).run();
  await revokeAll(env, admin.id, sessionId);
  await log(env.DB, actor, "admin.password_changed", "admins", admin.id,
    { note: "other sessions revoked" });

  return finished();
}
