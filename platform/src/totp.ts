/**
 * Time-based one-time codes, as Google Authenticator produces them.
 *
 * RFC 6238 over RFC 4226: HMAC-SHA1 of the current thirty-second counter,
 * truncated to six digits. SHA-1 is not a mistake here — it is what every
 * authenticator app implements, and its weaknesses are not reachable through
 * an HMAC with a secret key.
 */

const PERIOD = 30;
const DIGITS = 6;

/**
 * How many steps either side of now to accept.
 *
 * One, meaning a code stays good for about ninety seconds. Phones drift and
 * people type slowly; zero tolerance produces support calls rather than
 * security. Two would be generous enough to matter.
 */
const DRIFT = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));   // 160 bits
  return base32Encode(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function code(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);

  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16)
               | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Is this the right code right now?
 *
 * Every candidate is computed and compared without short-circuiting, so the
 * time taken does not reveal how close a guess was.
 */
export async function verify(secret: string, entered: string): Promise<boolean> {
  const cleaned = entered.replace(/\D/g, "");
  if (cleaned.length !== DIGITS) return false;

  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  let ok = false;
  for (let step = -DRIFT; step <= DRIFT; step++) {
    const candidate = await code(secret, counter + step);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= candidate.charCodeAt(i) ^ cleaned.charCodeAt(i);
    if (diff === 0) ok = true;
  }
  return ok;
}

/** The otpauth:// URI an authenticator app scans. */
export function enrolmentUri(email: string, secret: string): string {
  const label = encodeURIComponent(`ThePaymaster:${email}`);
  const issuer = encodeURIComponent("ThePaymaster");
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}` +
         `&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}
