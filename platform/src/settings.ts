/**
 * Provider credentials that staff can change without a deploy.
 *
 * The obvious way to do this is a text column holding the key. That is also
 * the way that puts a live API key into every database backup, every export,
 * and the reach of anything that can run a query. So the value is encrypted
 * with AES-GCM under a key that is *not* in the database — SETTINGS_KEY, a
 * Worker secret — and only the ciphertext and a four-character hint are
 * stored. A copy of the database, on its own, is not enough to use the key.
 *
 * This is not as strong as leaving credentials in Worker secrets, and it is
 * not meant to be: it trades a little exposure for the ability to turn Sumsub
 * on at four in the afternoon without me. Where that trade is wrong — the
 * session secret, the settings key itself — the credential stays a Worker
 * secret and is not manageable here.
 *
 * A key is never rendered back into a page. Once saved it can be replaced or
 * removed, not read.
 */

import { type Env, type Actor, log } from "./db.ts";

export type Provider = "nominis" | "sumsub" | "resend" | "eth_rpc" | "eth_rpc_2";

export interface Setting {
  provider: string;
  enabled: number;
  hint: string | null;
  second_hint: string | null;
  updated_at: string;
  checked_at: string | null;
  checked_note: string | null;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey | null> {
  if (!env.SETTINGS_KEY) return null;
  // The secret is a passphrase rather than raw key material, so it is hashed
  // to the 32 bytes AES-GCM wants. Deterministic, so the same secret always
  // decrypts what it encrypted.
  const material = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(env.SETTINGS_KEY));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false,
    ["encrypt", "decrypt"]);
}

async function seal(env: Env, value: string): Promise<{ iv: string; ct: string } | null> {
  const k = await key(env);
  if (!k) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k,
    new TextEncoder().encode(value));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function open(env: Env, iv: string | null, ct: string | null): Promise<string | null> {
  const k = await key(env);
  if (!k || !iv || !ct) return null;
  try {
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv) }, k, unb64(ct));
    return new TextDecoder().decode(out);
  } catch {
    // Wrong SETTINGS_KEY, or a tampered row. Either way there is no usable
    // credential here, and pretending otherwise would be worse.
    return null;
  }
}

/** The last four characters, which is enough to tell two keys apart. */
export function hintOf(value: string): string {
  const v = value.trim();
  return v.length <= 4 ? "…" : `…${v.slice(-4)}`;
}

/** Store a credential. The value is encrypted here and never stored plainly. */
export async function put(env: Env, actor: Actor, provider: Provider, opts: {
  secret?: string; second?: string; enabled?: boolean;
}): Promise<string | null> {
  if ((opts.secret || opts.second) && !env.SETTINGS_KEY) {
    return "No SETTINGS_KEY is configured, so a credential cannot be stored " +
           "safely. Set that Worker secret first.";
  }
  const existing = await env.DB.prepare(
    "SELECT provider FROM provider_settings WHERE provider = ?")
    .bind(provider).first<any>();

  const sealed = opts.secret ? await seal(env, opts.secret.trim()) : null;
  const sealed2 = opts.second ? await seal(env, opts.second.trim()) : null;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (sealed) {
    sets.push("secret_iv = ?", "secret_ct = ?", "hint = ?");
    binds.push(sealed.iv, sealed.ct, hintOf(opts.secret!));
  }
  if (sealed2) {
    sets.push("second_iv = ?", "second_ct = ?", "second_hint = ?");
    binds.push(sealed2.iv, sealed2.ct, hintOf(opts.second!));
  }
  if (opts.enabled !== undefined) {
    sets.push("enabled = ?");
    binds.push(opts.enabled ? 1 : 0);
  }
  sets.push("updated_by = ?", "updated_at = datetime('now')");
  binds.push(actor.id);

  if (existing) {
    await env.DB.prepare(
      `UPDATE provider_settings SET ${sets.join(", ")} WHERE provider = ?`)
      .bind(...binds, provider).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO provider_settings (provider, enabled) VALUES (?, 0)")
      .bind(provider).run();
    await env.DB.prepare(
      `UPDATE provider_settings SET ${sets.join(", ")} WHERE provider = ?`)
      .bind(...binds, provider).run();
  }

  // The value never reaches the log — only that it changed, and by whom.
  await log(env.DB, actor, "provider.changed", "provider_settings", provider, {
    note: [
      sealed ? "credential replaced" : null,
      sealed2 ? "second credential replaced" : null,
      opts.enabled === undefined ? null : opts.enabled ? "switched on" : "switched off",
    ].filter(Boolean).join(", ") || "no change",
  });
  return null;
}

/** Forget a credential entirely. */
export async function clear(env: Env, actor: Actor, provider: Provider): Promise<void> {
  await env.DB.prepare(
    `UPDATE provider_settings SET secret_iv = NULL, secret_ct = NULL, hint = NULL,
       second_iv = NULL, second_ct = NULL, second_hint = NULL, enabled = 0,
       updated_by = ?, updated_at = datetime('now') WHERE provider = ?`)
    .bind(actor.id, provider).run();
  await log(env.DB, actor, "provider.cleared", "provider_settings", provider,
    { note: "credential removed" });
}

export async function list(env: Env): Promise<Setting[]> {
  const { results } = await env.DB.prepare(
    `SELECT provider, enabled, hint, second_hint, updated_at, checked_at, checked_note
       FROM provider_settings`).all<any>();
  return (results ?? []) as Setting[];
}

export async function noteCheck(env: Env, provider: Provider, note: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE provider_settings SET checked_at = datetime('now'), checked_note = ?
      WHERE provider = ?`).bind(note.slice(0, 200), provider).run();
}

/**
 * The environment, with anything stored here resolved into it.
 *
 * Everything downstream keeps reading `env.NOMINIS_API_KEY` as before and does
 * not need to know where it came from. A Worker secret still wins if one is
 * set, so an existing deployment behaves exactly as it did and this becomes an
 * additional way to configure rather than a replacement.
 *
 * A provider that is switched off resolves to nothing, which is how the
 * on/off control works: the adapters already treat an absent key as "not
 * configured" and refuse to guess.
 */
export async function resolve(env: Env): Promise<Env> {
  if (!env.SETTINGS_KEY) return env;
  let rows: any[] = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT provider, enabled, secret_iv, secret_ct, second_iv, second_ct
         FROM provider_settings WHERE enabled = 1`).all<any>();
    rows = results ?? [];
  } catch {
    return env;      // before the migration has run, carry on unchanged
  }
  if (!rows.length) return env;

  const out: Record<string, unknown> = { ...env };
  for (const row of rows) {
    const first = await open(env, row.secret_iv, row.secret_ct);
    const second = await open(env, row.second_iv, row.second_ct);
    switch (row.provider) {
      case "nominis":   if (first && !env.NOMINIS_API_KEY) out.NOMINIS_API_KEY = first; break;
      case "resend":    if (first && !env.RESEND_API_KEY)  out.RESEND_API_KEY = first; break;
      case "eth_rpc":   if (first && !env.ETH_RPC_URL)     out.ETH_RPC_URL = first; break;
      case "eth_rpc_2": if (first && !env.ETH_RPC_URL_2)   out.ETH_RPC_URL_2 = first; break;
      case "sumsub":
        if (first && !env.SUMSUB_TOKEN)  out.SUMSUB_TOKEN = first;
        if (second && !env.SUMSUB_SECRET) out.SUMSUB_SECRET = second;
        break;
    }
  }
  return out as Env;
}
