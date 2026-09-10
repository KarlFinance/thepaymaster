/**
 * A rail: one chain and one asset the platform can move on it.
 *
 * Everything above this line — parties, verification, destinations, screening,
 * mandates, attestations, the journey, the dossier — never asks which chain a
 * transaction is on. Everything below it is chain-specific and lives in
 * `rails/`. This file is the boundary: the interface, the catalogue of rails
 * that exist, and the one place a transaction row is turned into the rail
 * that serves it.
 *
 * Two implementations: Ethereum (USDT on mainnet; the mock token on Sepolia
 * for rehearsals) and Bitcoin (mainnet; signet for rehearsals). They differ
 * in almost every respect below this interface and in none above it. See
 * docs/chain-adapter.md.
 */

import { type Env } from "./db.ts";
import { ethereumRail } from "./rails/ethereum.ts";
import { bitcoinRail } from "./rails/bitcoin.ts";
import { BTC_CHAIN_ID } from "./btc.ts";
import { bankRail } from "./rails/bank.ts";

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

export interface Health {
  name: string;
  ok: boolean;
  height: number | null;
  /** Set when the endpoint answered for a different network than asked. */
  wrongNetwork?: boolean;
  note?: string;
}

/**
 * The browser half of a rail: a script that gives the page a
 * `window.railWallet` with the same calls whatever the wallet is, so the
 * proof and send pages are written once.
 *
 *   present()                       is there a wallet in this browser
 *   same(a, b)                      do two spellings name one address
 *   accounts()                      connect; return the addresses it holds
 *   signMessage(address, message)   a signature the rail's provesControl accepts
 *   prepare()                       anything to do before a send (switch network)
 *   send(check)                     hand the server's prepared payment to the wallet; returns the hash
 *   landed(hash)                    has it confirmed yet
 *   waitSeconds, pendingAdvice      how long to wait on the page, and what to say after
 */
export interface Browser {
  walletHint: string;
  script: string;
}

export interface Rail {
  /** "eth:1:usdt", "eth:11155111:usdt", "btc:mainnet", "btc:signet". */
  key: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Rails with an issuer that can freeze addresses say so; the gate shows the line only then. */
  canFreeze: boolean;
  /** The integer the schema files screens and tests under. Ethereum's real id; a reserved one for Bitcoin. */
  chainId: number;
  explorer: { tx(hash: string): string; address(a: string): string };

  // --- addresses -----------------------------------------------------------
  normalise(address: string): { ok: true; address: string } | { ok: false; why: string };
  hashProblem(hash: string): string | null;

  // --- proving control -----------------------------------------------------
  challenge(o: { ref: string; address: string; role: "recipient" | "sender"; nonce: string }): string;
  provesControl(env: Env, o: { address: string; message: string; signature: string }): Promise<boolean>;

  // --- looking at the chain ------------------------------------------------
  balance(env: Env, address: string): Promise<bigint>;
  nativeBalance(env: Env, address: string): Promise<bigint | null>;
  inspect(env: Env, address: string, role: string): Promise<AddressReport>;
  health(env: Env): Promise<Health[]>;

  // --- moving money --------------------------------------------------------
  dustMinor(): number;
  verify(env: Env, hash: string, want: { to: string; amountMinor: number | bigint }): Promise<Verification | null>;

  /**
   * Rails that can pay every line in one transaction offer this. Bitcoin does
   * (a PSBT with an output per leg); an ERC-20 transfer cannot. The browser
   * half is `railWallet.signBatch(payload)`, which returns the one hash.
   */
  batch?: {
    compose(env: Env, o: {
      from: string;
      legs: { ref: string; to: string; amountMinor: number | bigint }[];
    }): Promise<Batch | { ok: false; why: string }>;
  };

  browser: Browser;
}

/** A composed batch, ready for the sender's wallet. */
export interface Batch {
  ok: true;
  /** What the browser hands to the wallet. Rail-specific; the page does not look inside. */
  payload: unknown;
  /** The hash the transaction will carry, when the rail can know it in advance. */
  txid: string | null;
  /** One line per output, for the confirmation the sender reads before signing. */
  outputs: { ref: string | null; to: string; amountMinor: bigint; change: boolean }[];
  feeMinor: bigint;
  human: string;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export interface RailChoice { key: string; label: string; rehearsal: boolean; chainId: number; needsToken: boolean }

/** Every rail a transaction may be put on, in the order the picker shows them. */
export const RAILS: RailChoice[] = [
  { key: "eth:1:usdt", label: "USDT on Ethereum", rehearsal: false, chainId: 1, needsToken: true },
  { key: "btc:mainnet", label: "Bitcoin", rehearsal: false, chainId: BTC_CHAIN_ID.mainnet, needsToken: false },
  { key: "eth:11155111:usdt", label: "USDT on Sepolia — rehearsal only", rehearsal: true, chainId: 11155111, needsToken: true },
  { key: "btc:signet", label: "Bitcoin signet — rehearsal only", rehearsal: true, chainId: BTC_CHAIN_ID.signet, needsToken: false },
];

export function railChoice(key: string | null | undefined): RailChoice | null {
  return RAILS.find((r) => r.key === key) ?? null;
}

/** Build a rail from its key alone, with no transaction behind it (the settings form). */
export function railByKey(key: string): Rail | null {
  if (!railChoice(key)) return null;
  return railFor({ rail: key });
}

/** The columns a rail is derived from. Everything else on the row is the platform's. */
export interface RailRow {
  rail?: string | null;
  chain_id?: number | null;
  token_address?: string | null;
  decimals_out?: number | null;
  decimals_in?: number | null;
  currency_out?: string | null;
  currency_in?: string | null;
  inbound?: string | null;
  outbound?: string | null;
}

/**
 * The rail a transaction runs on.
 *
 * Read from the `rail` column. Rows from before the column existed carry a
 * chain id and nothing else; those are Ethereum, and are read as such.
 */
export function railFor(t: RailRow): Rail {
  // No chain anywhere: the money goes bank to bank through the mandated account.
  if (t.inbound === "fiat" && t.outbound === "fiat") return bankRail(t.currency_out ?? "GBP", t.decimals_out ?? 2);
  const key = t.rail ?? (t.chain_id ? `eth:${t.chain_id}:usdt` : null);
  const b = key?.match(/^btc:(mainnet|signet|testnet)$/);
  if (b) return bitcoinRail(b[1] as "mainnet" | "signet" | "testnet");
  const e = key?.match(/^eth:(\d+):(\w+)$/);
  return ethereumRail({
    chainId: e ? Number(e[1]) : ((t.chain_id as number) ?? 1),
    token: t.token_address || null,
    decimals: (t.decimals_out ?? t.decimals_in ?? 6) as number,
    symbol: e ? e[2].toUpperCase() : ((t.currency_out ?? t.currency_in ?? "USDT") as string),
  });
}

const COLS = ["rail", "chain_id", "token_address", "decimals_out", "decimals_in", "currency_out", "currency_in", "inbound", "outbound"];

export async function railForTransaction(env: Env, transactionId: string): Promise<Rail> {
  const t = await env.DB.prepare(`SELECT ${COLS.join(", ")} FROM transactions WHERE id = ?`)
    .bind(transactionId).first<RailRow>();
  return railFor(t ?? {});
}

/** The same, reached through a participation. */
export async function railForParticipation(env: Env, participationId: string): Promise<Rail> {
  const t = await env.DB.prepare(
    `SELECT ${COLS.map((c) => "t." + c).join(", ")}
       FROM transactions t JOIN participations p ON p.transaction_id = t.id
      WHERE p.id = ?`).bind(participationId).first<RailRow>();
  return railFor(t ?? {});
}
