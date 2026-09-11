/**
 * ThePaymaster's own wallets.
 *
 * The fee wallet used to be typed into each transaction, which is the one
 * place a wrong character costs the fee. Now a transaction picks from this
 * list, the address is read-only on the transaction, and the list itself
 * changes only through the Wallets page, logged, with the old entry retired
 * rather than deleted. Control of each wallet is proved the way we ask a
 * recipient to prove theirs: a signature from its key over a challenge we
 * choose. Private keys never come near the platform.
 */

import { type Env, type Actor, id, insert, update } from "./db.ts";
import { railByKey, railChoice, RAILS } from "./rail.ts";

export type HouseRole = "fee" | "client";

export interface HouseWallet {
  id: string; label: string; role: HouseRole; rail: string; address: string;
  added_by: string | null; added_at: string;
  proof_nonce: string | null; proof_signature: string | null; proved_at: string | null;
  retired_at: string | null; retired_by: string | null; retired_reason: string | null;
}

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export async function list(env: Env, opts: { includeRetired?: boolean } = {}): Promise<HouseWallet[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM house_wallets ${opts.includeRetired ? "" : "WHERE retired_at IS NULL"} ORDER BY retired_at IS NOT NULL, rail, role, added_at`).all<HouseWallet>();
  return results ?? [];
}

/** Live wallets for a rail, fee ones first. */
export async function forRail(env: Env, railKey: string, role?: HouseRole): Promise<HouseWallet[]> {
  const all = await list(env);
  return all.filter((w) => w.rail === railKey && (!role || w.role === role));
}

/** The fee wallet a new transaction on this rail should default to: the proved one if there is one. */
export async function feeWalletFor(env: Env, railKey: string): Promise<HouseWallet | null> {
  const fee = await forRail(env, railKey, "fee");
  return fee.find((w) => w.proved_at) ?? fee[0] ?? null;
}

/** Is this address one of ours, live, on this rail? */
export async function isHouse(env: Env, railKey: string, address: string | null | undefined): Promise<HouseWallet | null> {
  if (!address) return null;
  const rail = railByKey(railKey);
  const want = rail ? (rail.normalise(address).ok ? (rail.normalise(address) as any).address : address) : address;
  return (await forRail(env, railKey)).find((w) => w.address.toLowerCase() === String(want).toLowerCase()) ?? null;
}

export async function add(env: Env, actor: Actor, o: { label: string; role: HouseRole; rail: string; address: string }): Promise<string | { problem: string }> {
  const choice = railChoice(o.rail);
  if (!choice) return { problem: "Choose a rail." };
  const rail = railByKey(o.rail)!;
  const n = rail.normalise(o.address.trim());
  if (!n.ok) return { problem: `Address: ${n.why}` };
  const label = o.label.trim();
  if (label.length < 4) return { problem: "Give the wallet a label people will recognise." };
  const dup = (await list(env, { includeRetired: true })).find((w) => w.rail === o.rail && w.address.toLowerCase() === n.address.toLowerCase() && !w.retired_at);
  if (dup) return { problem: `That address is already registered as “${dup.label}”.` };
  const rowId = id("hw");
  await insert(env.DB, actor, "house_wallet.added", "house_wallets", rowId, {
    label, role: o.role, rail: o.rail, address: n.address, added_by: actor.id,
  }, { note: `${label} — ${n.address} on ${choice.label}` });
  return rowId;
}

export async function retire(env: Env, actor: Actor, walletId: string, reason: string): Promise<string | null> {
  const w = await env.DB.prepare("SELECT * FROM house_wallets WHERE id = ?").bind(walletId).first<HouseWallet>();
  if (!w) return "No such wallet.";
  if (w.retired_at) return "Already retired.";
  if (reason.trim().length < 5) return "Say why it is being retired; the reason is part of the record.";
  const inUse = await env.DB.prepare(
    "SELECT count(*) AS n FROM transactions WHERE fee_wallet = ? AND status NOT IN ('settled','closed')").bind(w.address).first<any>();
  await update(env.DB, actor, "house_wallet.retired", "house_wallets", walletId,
    { retired_at: stamp(), retired_by: actor.id, retired_reason: reason.trim() }, { retired_at: null },
    { note: `${w.label} retired: ${reason.trim()}${inUse?.n ? ` — still the fee wallet on ${inUse.n} open transaction(s)` : ""}` });
  return null;
}

/** The message to sign from the wallet. Fresh nonce each time it is asked for. */
export async function challenge(env: Env, actor: Actor, walletId: string): Promise<{ message: string } | { problem: string }> {
  const w = await env.DB.prepare("SELECT * FROM house_wallets WHERE id = ?").bind(walletId).first<HouseWallet>();
  if (!w) return { problem: "No such wallet." };
  const rail = railByKey(w.rail)!;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("UPDATE house_wallets SET proof_nonce = ? WHERE id = ?").bind(nonce, walletId).run();
  return { message: rail.challenge({ ref: "HOUSE", address: w.address, role: "sender", nonce }) };
}

export async function prove(env: Env, actor: Actor, walletId: string, signature: string): Promise<string | null> {
  const w = await env.DB.prepare("SELECT * FROM house_wallets WHERE id = ?").bind(walletId).first<HouseWallet>();
  if (!w) return "No such wallet.";
  if (!w.proof_nonce) return "Ask for the message to sign first.";
  const rail = railByKey(w.rail)!;
  const message = rail.challenge({ ref: "HOUSE", address: w.address, role: "sender", nonce: w.proof_nonce });
  const ok = await rail.provesControl(env, { address: w.address, message, signature: signature.trim() });
  if (!ok) return "That signature does not verify for this address. Sign the exact message shown, from the wallet itself.";
  await update(env.DB, actor, "house_wallet.proved", "house_wallets", walletId,
    { proof_signature: signature.trim(), proved_at: stamp() }, { proved_at: w.proved_at },
    { note: `control of ${w.address} proved by signature` });
  return null;
}

export const RAIL_LABEL = (key: string) => RAILS.find((r) => r.key === key)?.label ?? key;
