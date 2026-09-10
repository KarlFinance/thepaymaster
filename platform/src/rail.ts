/**
 * A rail: one chain and one asset the platform can move on it.
 *
 * Everything above this line — parties, verification, destinations, screening,
 * mandates, attestations, the journey, the dossier — never asks which chain a
 * transaction is on. Everything below it is chain-specific and lives in
 * `rails/`. This file is the boundary: the interface, and the one place a
 * transaction row is turned into the rail that serves it.
 *
 * Today there is one implementation, Ethereum (USDT on mainnet, and the mock
 * on Sepolia for rehearsals). The interface is shaped so that Bitcoin — a
 * different model in almost every respect: UTXOs not accounts, BIP-322 not
 * EIP-191, one transaction paying every recipient — can sit beside it without
 * the platform learning any of that. See docs/chain-adapter.md.
 */

import { type Env } from "./db.ts";
import { ethereumRail } from "./rails/ethereum.ts";

/** What the chain knows about one address, in one pass. */
export interface AddressReport {
  address: string;
  role: string;
  balance: bigint | null;
  /** Frozen by the asset's issuer. `null` when it could not be checked, or the
   *  rail has no such thing — the caller must not read null as "fine". */
  frozen: boolean | null;
  /** A contract or script rather than an ordinary key-held address. */
  contract: boolean | null;
  error?: string;
}

/** The answer to "did this hash pay them?", cross-checked across providers. */
export interface Verification {
  ok: boolean;
  from: string | null;
  block: number | null;
  sources: number;
  agreed: boolean;
  problem?: string;
}

export interface Rail {
  /** "eth:1:usdt", "eth:11155111:usdt". Stored nowhere yet; derived from the row. */
  key: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Rails with an issuer that can freeze addresses say so; the gate shows the line only then. */
  canFreeze: boolean;
  explorer: { tx(hash: string): string; address(a: string): string };

  // --- addresses -----------------------------------------------------------
  /** Reject anything that is not an address on this rail; return the canonical spelling. */
  normalise(address: string): { ok: true; address: string } | { ok: false; why: string };
  /** A shape check on a hash before spending a network call on it. */
  hashProblem(hash: string): string | null;

  // --- proving control -----------------------------------------------------
  challenge(o: { ref: string; address: string; role: "recipient" | "sender"; nonce: string }): string;
  provesControl(env: Env, o: { address: string; message: string; signature: string }): Promise<boolean>;

  // --- looking at the chain ------------------------------------------------
  balance(env: Env, address: string): Promise<bigint>;
  /** The chain's own currency, for gas. Rails whose asset is the native coin return the same as balance(). */
  nativeBalance(env: Env, address: string): Promise<bigint | null>;
  inspect(env: Env, address: string, role: string): Promise<AddressReport>;

  // --- moving money --------------------------------------------------------
  /** The smallest payment this rail carries; the test payment is exactly this. */
  dustMinor(): number;
  /** Did `hash` pay `to` exactly `amountMinor` of this asset? */
  verify(env: Env, hash: string, want: { to: string; amountMinor: number | bigint }): Promise<Verification | null>;
}

/** The columns a rail is derived from. Everything else on the row is the platform's. */
export interface RailRow {
  chain_id?: number | null;
  token_address?: string | null;
  decimals_out?: number | null;
  decimals_in?: number | null;
  currency_out?: string | null;
  currency_in?: string | null;
}

/**
 * The rail a transaction runs on.
 *
 * Only Ethereum exists, so every crypto transaction resolves to it; the
 * chain id and token address on the row choose which network and which
 * token. When a second rail arrives this reads a `rail` column instead of
 * inferring, and the back-fill is mechanical.
 */
export function railFor(t: RailRow): Rail {
  return ethereumRail({
    chainId: (t.chain_id as number) ?? 1,
    token: t.token_address || null,
    decimals: (t.decimals_out ?? t.decimals_in ?? 6) as number,
    symbol: (t.currency_out ?? t.currency_in ?? "USDT") as string,
  });
}

export async function railForTransaction(env: Env, transactionId: string): Promise<Rail> {
  const t = await env.DB.prepare(
    `SELECT chain_id, token_address, decimals_out, decimals_in, currency_out, currency_in
       FROM transactions WHERE id = ?`).bind(transactionId).first<RailRow>();
  return railFor(t ?? {});
}

/** The same, reached through a participation. */
export async function railForParticipation(env: Env, participationId: string): Promise<Rail> {
  const t = await env.DB.prepare(
    `SELECT t.chain_id, t.token_address, t.decimals_out, t.decimals_in, t.currency_out, t.currency_in
       FROM transactions t JOIN participations p ON p.transaction_id = t.id
      WHERE p.id = ?`).bind(participationId).first<RailRow>();
  return railFor(t ?? {});
}
