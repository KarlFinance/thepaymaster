/**
 * Platform-wide switches, one row each.
 *
 * The first is which fiat mode is on. Fiat runs manually today: money into
 * the client account confirmed by a person, money out confirmed by a person.
 * The HSBC API mode exists as a choice so the switch is already there when
 * the account has enough history for the bank to issue credentials; until
 * then it cannot be selected. The sender-direct mode is built and kept, but
 * off: paying recipients from the sender's own bank does not sit inside the
 * commercial agent exemption as we operate it.
 */

import { type Env, type Actor, log } from "./db.ts";

export type FiatMode = "manual" | "hsbc_api" | "sender_direct";

export const FIAT_MODES: { key: FiatMode; label: string; detail: string; available: (env: Env) => boolean; why?: string }[] = [
  { key: "manual", label: "Fiat — manual", available: () => true,
    detail: "The sender pays the client account at HSBC under the Reference Code; a member of staff confirms receipt. Staff pay each recipient from the client account and confirm each payment with evidence; each recipient confirms it arrived. Every confirmation is a person pressing a button." },
  { key: "hsbc_api", label: "Fiat — HSBC API", available: (env) => Boolean((env as any).HSBC_API_KEY),
    why: "Not available until the client account has transaction history and HSBC has issued API credentials. When they exist, receipts and payments are read from the bank rather than confirmed by hand; the confirmations stay in the record.",
    detail: "Receipts and payments read from the bank's API and matched to the Reference Codes automatically; staff still release each payment." },
  { key: "sender_direct", label: "Fiat — sender pays directly (built, not offered)", available: () => true,
    why: "Kept in the code but off the default path: the sender paying recipients from their own bank is outside the commercial agent model as we operate it. Turning it on shows the payer choice on fiat transactions.",
    detail: "The sender uploads our payment file to their own bank, pays every recipient and our fee themselves, and reconciles their statement in their account. Nothing passes through the client account." },
];

export async function get(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM platform_settings WHERE key = ?").bind(key).first<any>();
  return r?.value ?? null;
}

export async function set(env: Env, actor: Actor, key: string, value: string, note?: string): Promise<void> {
  const before = await get(env, key);
  await env.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(key, value, actor.id).run();
  await log(env.DB, actor, "setting.changed", "platform_settings", key, { before: { value: before }, after: { value }, note });
}

export async function fiatMode(env: Env): Promise<FiatMode> {
  const v = await get(env, "fiat_mode");
  return (FIAT_MODES.some((m) => m.key === v) ? v : "manual") as FiatMode;
}
