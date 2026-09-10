/**
 * What the sender sees immediately before parting with the money.
 *
 * This is the last screen at which a mistake is still cheap, so it is built to
 * be read rather than clicked through: every recipient, every address in full,
 * every amount, our fee as a line like any other, and the arithmetic showing
 * they sum to what leaves the wallet.
 *
 * Three principles it exists to enforce:
 *
 *   The sender never types a recipient's address. Each recipient supplies and
 *   proves their own; the sender approves what is shown. A wrong address is
 *   the one unrecoverable error in this business, and this takes it out of the
 *   sender's hands entirely.
 *
 *   Nothing is sent from here. The platform composes each transaction and the
 *   sender's own wallet signs it, one leg at a time. We never hold the funds
 *   and never could.
 *
 *   A leg already paid can never be paid twice. Each is recorded against its
 *   own verified transaction hash, so a session resumed the next morning shows
 *   what is done rather than offering to do it again.
 */

import { type Env } from "./db.ts";
import { legs as payoutLegs, holderFor, type Leg } from "./settlement.ts";
import { assess } from "./readiness.ts";
import { proved as provedAddress } from "./attest.ts";
import { railFor, type Rail } from "./rail.ts";
import { USDT_MAINNET } from "./chain.ts";
import { standing } from "./walletscreen.ts";

/**
 * How stale a screening verdict may be at the moment of execution.
 *
 * A verdict is good for three months for the purposes of getting a
 * transaction ready. Sending is different: the question is not "was this
 * address respectable in June" but "is it now", and sanctions listings and
 * thefts are news that breaks in hours.
 */
export const SCREEN_FRESH_DAYS = 7;

/** One unit of the token: the smallest transfer the chain can express. */
/** Kept for callers that still import it; the rail is the authority. */
export const DUST_MINOR = 1;

export interface Line {
  participationId: string | null;   // null for our fee
  name: string;
  address: string | null;
  amountMinor: number;
  paid: boolean;
  txHash: string | null;
  /** Anything that should stop this leg being sent. */
  problems: string[];
  /** True but worth saying out loud. */
  notes: string[];
  /** A test payment that landed at this address, if one has. */
  testedHash: string | null;
}

export interface Funder {
  address: string;
  label: string | null;
  proved: boolean;
  tokenMinor: bigint | null;
  gasWei: bigint | null;
}

export interface Plan {
  ready: boolean;
  rail: Rail;
  chainId: number;
  token: string;
  decimals: number;
  currency: string;
  lines: Line[];
  totalMinor: number;
  funders: Funder[];
  /** Reasons the whole distribution should not begin. */
  blocking: string[];
}

/** Gas for one ERC-20 transfer, generously. USDT is heavier than most. */
const GAS_PER_LEG = 70_000n;

/**
 * Everything true about this distribution at this moment.
 *
 * Deliberately re-read from the chain each time rather than cached. The
 * question "can this be sent" has a different answer after somebody is frozen
 * or a balance moves, and a stale yes is worse than a slow no.
 */
export async function plan(env: Env, txId: string): Promise<Plan> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!t) throw new Error("no such transaction");

  const rail = railFor(t);
  const chainId = (t.chain_id as number) ?? 1;
  const token = (t.token_address as string) || USDT_MAINNET;
  const decimals = rail.decimals;
  const currency = rail.symbol;

  const state = await assess(env, txId);
  const raw: Leg[] = await payoutLegs(env, txId);
  const blocking: string[] = [];

  if (holderFor(t) !== "none") {
    blocking.push("This transaction is not one the sender executes on chain.");
  }
  if (!t.fee_wallet) blocking.push("No fee wallet is set on this transaction.");

  // The readiness gate says a transaction *may* be sent; a person moving it to
  // ready says it *should* be. Until that has happened the send screen shows
  // the plan but composes nothing — the harness proved a sender could
  // otherwise pay while the stage still read "waiting for everyone to verify".
  // (release gate applied below, once it is known whether anything is left to send)

  // When the split does not compute there are no amounts, and every line would
  // otherwise read "no amount allocated" — true, but useless. Say why.
  if (!state.settlement) {
    const why = state.checks.find((c) => c.key === "amounts")?.detail;
    blocking.push(`The split does not add up${why ? `: ${why}` : ""}.`);
  }
  if (!t.chain_id) blocking.push("No chain is set on this transaction.");

  const lines: Line[] = [];

  for (const leg of raw) {
    const d = await env.DB.prepare(
      `SELECT id, address, proved_at, locked_at FROM destinations
        WHERE participation_id = ? AND kind = 'wallet'`)
      .bind(leg.participationId).first<any>();

    const problems: string[] = [];
    const notes: string[] = [];
    if (!d?.address) problems.push("No wallet address supplied yet");
    if (d?.address) {
      const p = await provedAddress(env, d);
      if (!p.ok) problems.push("Address not proved by signature or accepted on evidence");
      else if (p.how === "attested") notes.push(`Accepted as a ${p.attestation!.custodian} deposit address on evidence, not by signature`);
    }
    if (leg.expectedMinor <= 0) problems.push("No amount allocated");

    lines.push({
      participationId: leg.participationId,
      name: leg.name,
      address: d?.address ?? null,
      amountMinor: leg.expectedMinor,
      paid: Boolean(leg.txHash),
      txHash: leg.txHash,
      problems, notes,
      testedHash: null,
    });
  }

  // Our fee is a line like any other, and cannot be quietly dropped.
  lines.push({
    participationId: null,
    name: "ThePaymaster — fee",
    address: t.fee_wallet ?? null,
    amountMinor: state.settlement?.feeMinor ?? 0,
    paid: await feePaid(env, txId),
    txHash: await feeHash(env, txId),
    testedHash: null,
    problems: [
      ...(t.fee_wallet ? [] : ["No fee wallet set"]),
      // A zero fee means the arithmetic has not been done, not that we waived
      // it. Sending nothing would cost gas and record a payment of nothing.
      ...((state.settlement?.feeMinor ?? 0) > 0 ? [] : ["No fee calculated"]),
    ],
    notes: [],
  });

  // --- what the chain says about each address, in one pass -----------------
  await Promise.all(lines.map(async (line) => {
    if (!line.address) return;
    const [report, screen] = await Promise.all([
      rail.inspect(env, line.address, line.name),
      standing(env, line.address, chainId),
    ]);
    const frozen = rail.canFreeze ? report.frozen : false;
    const contract = report.contract;
    if (frozen === true) line.problems.push("Frozen by the issuer — cannot receive");
    if (frozen === null) line.problems.push("Could not check the freeze list");
    if (contract === true) {
      line.notes.push("A contract, not an ordinary wallet — confirm it can hold tokens");
    }
    if (!screen) line.problems.push("Not screened");
    else if (screen.verdict !== "clear") line.problems.push(`Screening: ${screen.verdict}`);
    else if (stale(screen.screened_at)) {
      line.problems.push(
        `Screened ${screen.screened_at?.slice(0, 10)} — too long ago to send on. ` +
        `Ask us to check it again.`);
    }
  }));

  // What has already been proved to arrive.
  const { results: tests } = await env.DB.prepare(
    `SELECT participation_id, address, tx_hash FROM address_tests
      WHERE transaction_id = ? AND verified_at IS NOT NULL`).bind(txId).all<any>();
  for (const line of lines) {
    if (!line.address) continue;
    const hit = (tests ?? []).find((r: any) =>
      String(r.address).toLowerCase() === line.address!.toLowerCase());
    line.testedHash = hit?.tx_hash ?? null;
    if (!line.paid && !line.testedHash) {
      line.problems.push("No test payment has reached this address yet");
    }
  }

  // --- can the sending wallets actually cover it ---------------------------
  const { results: sw } = await env.DB.prepare(
    "SELECT address, label, proved_at FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL")
    .bind(txId).all<any>();

  const funders: Funder[] = await Promise.all((sw ?? []).map(async (w: any) => {
    const [bal, gas] = await Promise.all([
      rail.balance(env, w.address).catch(() => null),
      rail.nativeBalance(env, w.address),
    ]);
    return {
      address: w.address, label: w.label,
      proved: Boolean(w.proved_at),
      tokenMinor: bal, gasWei: gas,
    };
  }));

  const outstanding = lines.filter((l) => !l.paid);
  const totalMinor = outstanding.reduce((sum, l) => sum + l.amountMinor, 0);

  // The readiness gate says a transaction *may* be sent; a person moving it to
  // ready says it *should* be. Until then the screen shows the plan but
  // composes nothing. Once everything is paid the gate is moot — a finished
  // page must not carry a "not ready" banner.
  if (outstanding.length && !["ready", "settling"].includes(String(t.status))) {
    blocking.push("Not yet released for sending. We check everything over and " +
      "release it; you will get an email the moment you can send.");
  }

  if (!funders.length) blocking.push("No sending wallet has been proved.");
  if (funders.length && funders.every((f) => !f.proved)) {
    blocking.push("No sending wallet has been proved by signature.");
  }

  const held = funders.reduce((sum, f) => sum + (f.tokenMinor ?? 0n), 0n);
  if (funders.length && held < BigInt(totalMinor)) {
    blocking.push(`The sending wallets hold less than this distribution needs.`);
  }

  return {
    rail,
    ready: blocking.length === 0 && outstanding.every((l) => l.problems.length === 0),
    chainId, token, decimals, currency,
    lines, totalMinor, funders, blocking,
  };
}

/** Older than SCREEN_FRESH_DAYS, or never dated at all. */
function stale(screenedAt: string | null | undefined): boolean {
  if (!screenedAt) return true;
  const when = Date.parse(screenedAt.replace(" ", "T") + "Z");
  if (Number.isNaN(when)) return true;
  return Date.now() - when > SCREEN_FRESH_DAYS * 86_400_000;
}

/** Enough native currency to pay for the legs still outstanding. */
export function gasNeeded(legsOutstanding: number): bigint {
  return GAS_PER_LEG * BigInt(Math.max(legsOutstanding, 1));
}

async function feePaid(env: Env, txId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM custody_events WHERE transaction_id = ? AND event = 'fee_taken' LIMIT 1")
    .bind(txId).first<any>();
  return Boolean(row);
}

async function feeHash(env: Env, txId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT tx_hash FROM custody_events WHERE transaction_id = ? AND event = 'fee_taken'
      AND tx_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`).bind(txId).first<any>();
  return row?.tx_hash ?? null;
}

/**
 * The ERC-20 transfer call for one leg.
 *
 * Composed here so the sender's wallet is handed an exact payload rather than
 * a form to fill in. transfer(address,uint256) — 0xa9059cbb.
 */
export function transferData(to: string, amountMinor: number | bigint): string {
  const addr = to.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const amt = BigInt(amountMinor).toString(16).padStart(64, "0");
  return "0xa9059cbb" + addr + amt;
}
