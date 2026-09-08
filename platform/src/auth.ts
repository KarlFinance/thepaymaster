/**
 * Admin sessions.
 *
 * Password plus a signed cookie, both built on WebCrypto rather than a
 * dependency. This is the smallest thing that is genuinely secure, and it is
 * explicitly a stopgap: before this panel holds anything real it should sit
 * behind Cloudflare Access, which replaces all of it with the identity you
 * already have and removes passwords from the picture entirely.
 */

const ITERATIONS = 210_000;   // OWASP's 2023 floor for PBKDF2-SHA512
const COOKIE = "tpm_session";
const TTL_SECONDS = 8 * 60 * 60;

const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "")
    .replace(/\+/g, "-").replace(/\//g, "_");
}

function unb64(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Constant time, so a wrong guess takes as long as a right one. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password: string, salt?: Uint8Array): Promise<string> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: s, iterations: ITERATIONS, hash: "SHA-512" }, key, 256);
  return `pbkdf2$${ITERATIONS}$${b64(s)}$${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iters, salt, digest] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unb64(salt), iterations: Number(iters), hash: "SHA-512" }, key, 256);
  return same(new Uint8Array(bits), unb64(digest));
}

async function signer(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issue(adminId: string, secret: string): Promise<string> {
  const body = `${adminId}.${Math.floor(Date.now() / 1000) + TTL_SECONDS}`;
  const sig = await crypto.subtle.sign("HMAC", await signer(secret), enc.encode(body));
  return `${body}.${b64(new Uint8Array(sig))}`;
}

export async function open(token: string, secret: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [adminId, expiry, sig] = parts;
  const ok = await crypto.subtle.verify("HMAC", await signer(secret),
    unb64(sig), enc.encode(`${adminId}.${expiry}`));
  if (!ok) return null;
  if (Number(expiry) < Math.floor(Date.now() / 1000)) return null;
  return adminId;
}

export function cookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_SECONDS}`;
}

export const clearCookie = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

export function fromRequest(request: Request): string | null {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}
