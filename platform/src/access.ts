/**
 * Identity from Cloudflare Access.
 *
 * Access puts two things on every request that reaches us: the authenticated
 * email in a header, and a signed assertion in Cf-Access-Jwt-Assertion. Only
 * the second is worth anything. A header is trivially forged by anyone who can
 * reach the worker directly, so trusting it means the panel is protected by
 * routing rather than by anything cryptographic — and routing changes.
 *
 * So the JWT is verified: RS256 signature against the team's published keys,
 * audience matching this application, and expiry. Nothing else gets in.
 */

const TEAM = "sweet-mouse-92a5";
const CERTS = `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`;

/** The application's AUD tag, from its Access configuration. */
const AUD = "02e417cea75d9af0c3f9b38cf02a56f1b8189684ee1c4f4adc4ade05b4a001cb";

interface Jwk { kid: string; kty: string; alg: string; n: string; e: string; use?: string }

let cached: { at: number; keys: Map<string, CryptoKey> } | null = null;

function b64url(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Access rotates its signing keys, so they are fetched rather than pinned, and
 * held for an hour. An hour is short enough that a rotation heals itself and
 * long enough that this is not a network call per request.
 */
async function keys(): Promise<Map<string, CryptoKey>> {
  if (cached && Date.now() - cached.at < 3_600_000) return cached.keys;

  const res = await fetch(CERTS);
  if (!res.ok) throw new Error(`Access certs unavailable: ${res.status}`);
  const body = await res.json<{ keys: Jwk[] }>();

  const map = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA") continue;
    map.set(jwk.kid, await crypto.subtle.importKey(
      "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  cached = { at: Date.now(), keys: map };
  return map;
}

export interface Identity {
  email: string;
  /** Access's own user id, stable across email changes. */
  sub: string;
}

/**
 * The verified identity on this request, or null.
 *
 * Null means the request did not come through Access. It is never a reason to
 * fall back to something more permissive.
 */
export async function identify(request: Request): Promise<Identity | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: { kid?: string; alg?: string };
  let claims: { aud?: string | string[]; email?: string; sub?: string; exp?: number; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch { return null; }

  if (header.alg !== "RS256" || !header.kid) return null;

  const key = (await keys()).get(header.kid);
  if (!key) return null;

  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;

  // A signature alone is not enough: a token minted for a different
  // application in the same account would verify perfectly well.
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(AUD)) return null;

  if (claims.iss && claims.iss !== `https://${TEAM}.cloudflareaccess.com`) return null;
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (!claims.email) return null;

  return { email: claims.email.toLowerCase(), sub: claims.sub ?? claims.email };
}
