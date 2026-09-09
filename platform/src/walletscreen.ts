/**
 * Screening an address, as opposed to checking it can receive.
 *
 * The gate already asks Tether whether an address is frozen. That is free,
 * live, and answers "can this address receive". It says nothing about whether
 * it should — whether the funds have come through a mixer, a sanctioned
 * entity, a known theft, or a jurisdiction nobody wants to explain later.
 *
 * That question needs a provider with a graph behind it. Until one is wired,
 * a person runs the check wherever they run it and records the verdict here
 * with their name on it, which is honest and is a record. Nominis is written
 * and dark, in the same shape as the KYC providers, so switching it on is a
 * key rather than a rewrite.
 *
 * A verdict, not a score. A number invites an argument about thresholds; a
 * verdict invites somebody to own it.
 */

import { type Env, type Actor, id, log, insert, update } from "./db.ts";

export type Verdict = "clear" | "flagged" | "refused" | "pending";

export interface Screen {
  verdict: Verdict;
  risk?: string;
  findings?: string;
  reference?: string;
  payload?: unknown;
}

export interface ScreenProvider {
  readonly name: string;
  readonly active: (env: Env) => boolean;
  check(env: Env, address: string, chainId: number): Promise<Screen>;
}

/** What we do today: a person checks, and records what they found. */
export const manual: ScreenProvider = {
  name: "manual",
  active: () => true,
  async check(): Promise<Screen> {
    return { verdict: "pending", findings: "Awaiting a check by one of us" };
  },
};

/**
 * Nominis, built and switched off.
 *
 * Wakes when NOMINIS_API_KEY exists. The same account already screens wallets
 * for VerifiedWallet, so the key is a matter of reusing something that exists
 * rather than buying anything new.
 */
/**
 * Nominis.
 *
 * Two endpoints, and the difference decides how this is built.
 *
 *   Quick check is synchronous: hand it up to fifty addresses and it answers
 *   at once with attribution and a score. That is what the gate needs — a
 *   verdict while somebody is looking at the screen.
 *
 *   Deep screening is asynchronous. It returns a request id and the caller
 *   polls every ten seconds until it is done. A Worker cannot sit through
 *   that, so the deep check is started and its id kept; the answer is
 *   collected later, when someone next opens the transaction.
 *
 * The key travels in the query string, which is their design rather than a
 * choice of ours. Nothing here logs the URL, and nothing should start.
 */
const NOMINIS = "https://authapi0.nominis.io:8443/v2";

/** Chain slugs for the deep endpoint. Only ones we have actually seen named. */
const NOMINIS_CHAIN: Record<number, string> = { 1: "eth" };

export interface QuickLabel {
  address: string;
  name?: string;
  classification?: string[];
  risk_factors?: string[];
  quick_score?: string;
}

/**
 * Attribution and a score for up to fifty addresses at once.
 *
 * Batching matters: a distribution to forty recipients is one call rather than
 * forty, which is the difference between screening being routine and being
 * something staff skip because it is slow.
 */
export async function quickCheck(env: Env, addresses: string[]): Promise<{
  labels: Map<string, QuickLabel>; problem?: string;
}> {
  const labels = new Map<string, QuickLabel>();
  if (!env.NOMINIS_API_KEY) return { labels, problem: "Nominis is configured off" };
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase()))].slice(0, 50);
  if (!wanted.length) return { labels };

  try {
    const url = `${NOMINIS}/address/quick_check` +
      `?address=${encodeURIComponent(wanted.join(","))}` +
      `&api_key=${encodeURIComponent(env.NOMINIS_API_KEY)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) return { labels, problem: `Nominis ${res.status}: ${text.slice(0, 160)}` };

    const body = JSON.parse(text);
    if (body?.status !== "ok") {
      return { labels, problem: `Nominis: ${String(body?.error ?? "refused")}`.slice(0, 200) };
    }
    for (const row of Array.isArray(body.data) ? body.data : []) {
      if (row?.address) labels.set(String(row.address).toLowerCase(), row);
    }
    return { labels };
  } catch (err) {
    return { labels, problem: (err as Error).message };
  }
}

/**
 * Their risk word, turned into our verdict.
 *
 * Only "low" clears. Everything else — and, importantly, an address they have
 * never heard of — stops short of clear, because "no attribution" is an
 * absence of evidence and not evidence of absence. A sanctioned classification
 * flags whatever the score says, since that is a fact about the address rather
 * than a judgement about it.
 */
export function verdictFor(label: QuickLabel | undefined): Screen {
  if (!label) {
    return { verdict: "pending",
             findings: "Nominis has no attribution for this address" };
  }
  const score = String(label.quick_score ?? "").toLowerCase();
  const tags = (label.classification ?? []).map((c) => String(c).toLowerCase());
  const risks = (label.risk_factors ?? []).map((r) => String(r));
  const sanctioned = tags.includes("sanctioned");

  const findings = [
    label.name ? `Known as ${label.name}` : null,
    tags.length ? `Classified ${tags.join(", ")}` : null,
    risks.length ? `Risk factors: ${risks.join(", ")}` : null,
  ].filter(Boolean).join(". ") || undefined;

  return {
    verdict: sanctioned ? "refused"
      : score === "low" ? "clear"
      : score ? "flagged"
      : "pending",
    risk: score || undefined,
    findings,
    reference: label.name,
    payload: label,
  };
}

export const nominis: ScreenProvider = {
  name: "nominis",
  active: (env: Env) => Boolean(env.NOMINIS_API_KEY),

  async check(env: Env, address: string, chainId: number): Promise<Screen> {
    if (!nominis.active(env)) {
      return { verdict: "pending", findings: "Nominis is configured off" };
    }
    // A test network address has no history to attribute, so asking would
    // return nothing and that nothing would look like a finding.
    if (!NOMINIS_CHAIN[chainId]) {
      return { verdict: "pending",
               findings: `Nominis does not cover chain ${chainId} — check by hand` };
    }
    const { labels, problem } = await quickCheck(env, [address]);
    if (problem) return { verdict: "pending", findings: problem };
    return verdictFor(labels.get(address.toLowerCase()));
  },
};

/**
 * Start a deep screening. Returns their request id, to be collected later.
 *
 * Worth doing on the addresses that matter even though the quick check has
 * already answered: the deep pass sees exposure several hops out, which is
 * where a mixer two transfers back shows up.
 */
export async function startDeep(env: Env, chainId: number,
                                address: string): Promise<string | null> {
  const chain = NOMINIS_CHAIN[chainId];
  if (!env.NOMINIS_API_KEY || !chain) return null;
  try {
    const res = await fetch(`${NOMINIS}/address/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain, address, depth: 3, mode: "full", api_key: env.NOMINIS_API_KEY,
      }),
    });
    const body = await res.json<any>();
    return body?.status === "ok" && typeof body.data === "string" ? body.data : null;
  } catch { return null; }
}

/** Collect a deep screening, if it has finished. */
export async function deepResult(env: Env, requestId: string): Promise<{
  done: boolean; riskScore?: string; categories?: unknown; payload?: unknown;
} | null> {
  if (!env.NOMINIS_API_KEY) return null;
  try {
    const res = await fetch(
      `${NOMINIS}/address/check/${encodeURIComponent(requestId)}` +
      `?api_key=${encodeURIComponent(env.NOMINIS_API_KEY)}`,
      { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json<any>();
    const inner = body?.data;
    const done = String(inner?.status ?? "").toLowerCase() === "done";
    return {
      done,
      riskScore: inner?.data?.risk_score ? String(inner.data.risk_score) : undefined,
      categories: inner?.data?.risk_categories,
      payload: inner?.data,
    };
  } catch { return null; }
}

export function screener(env: Env): ScreenProvider {
  return nominis.active(env) ? nominis : manual;
}

/**
 * Screen an address and record the answer.
 *
 * Always writes a row, including when the provider could not be reached — an
 * absent record and a clean record must never look the same.
 */
export async function screen(env: Env, actor: Actor, opts: {
  address: string; chainId: number; transactionId?: string; partyId?: string;
}): Promise<string> {
  const p = screener(env);
  const result = await p.check(env, opts.address, opts.chainId);
  const rowId = id("scr");
  await insert(env.DB, actor, "wallet.screened", "wallet_screens", rowId, {
    address: opts.address,
    chain_id: opts.chainId,
    transaction_id: opts.transactionId ?? null,
    party_id: opts.partyId ?? null,
    provider: p.name,
    verdict: result.verdict,
    risk: result.risk ?? null,
    findings: result.findings ?? null,
    reference: result.reference ?? null,
    payload: result.payload ? JSON.stringify(result.payload) : null,
    screened_at: result.verdict === "pending" ? null
      : new Date().toISOString().replace("T", " ").slice(0, 19),
  }, { note: `${p.name}: ${result.verdict}${result.risk ? ` (${result.risk})` : ""}` });
  return rowId;
}

/** A person records what a check told them. */
export async function recordVerdict(env: Env, actor: Actor, screenId: string, opts: {
  verdict: Exclude<Verdict, "pending">;
  findings: string;
  months: number;
}): Promise<void> {
  const before = await env.DB.prepare(
    "SELECT verdict, findings FROM wallet_screens WHERE id = ?").bind(screenId).first<any>();
  const now = new Date();
  await update(env.DB, actor, `wallet.${opts.verdict}`, "wallet_screens", screenId, {
    verdict: opts.verdict,
    findings: opts.findings || null,
    decided_by: actor.id,
    screened_at: now.toISOString().replace("T", " ").slice(0, 19),
    expires_at: new Date(now.getTime() + opts.months * 30 * 86_400_000)
      .toISOString().replace("T", " ").slice(0, 19),
  }, before ?? {}, { note: opts.findings });
}

/** The screening that currently stands for an address, if any. */
export async function standing(env: Env, address: string, chainId: number) {
  return env.DB.prepare(
    `SELECT id, provider, verdict, risk, findings, screened_at, expires_at
       FROM wallet_screens
      WHERE lower(address) = ? AND chain_id = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      -- rowid breaks the tie. created_at has one-second granularity, and two
      -- verdicts recorded in the same second would otherwise come back in an
      -- arbitrary order — which could hide a flag behind an earlier clear.
      ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .bind(address.toLowerCase(), chainId).first<any>();
}

export async function forTransaction(env: Env, transactionId: string) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM wallet_screens WHERE transaction_id = ? ORDER BY created_at`)
    .bind(transactionId).all<any>();
  return results ?? [];
}

/**
 * Screen every address on a transaction in one call.
 *
 * Nominis takes fifty addresses at a time, so a distribution to forty
 * recipients costs one request. That matters more than it sounds: screening
 * that takes a minute per address is screening that gets skipped.
 *
 * A row is written for every address, including the ones Nominis has never
 * heard of. An absent record and a clean record must never look the same.
 */
export async function screenAll(env: Env, actor: Actor, txId: string): Promise<{
  screened: number; problem?: string;
}> {
  const t = await env.DB.prepare(
    "SELECT chain_id, fee_wallet FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  const chainId = (t?.chain_id as number) ?? 1;

  const targets: { address: string; partyId: string | null }[] = [];
  const { results: sw } = await env.DB.prepare(
    "SELECT address, party_id FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL")
    .bind(txId).all<any>();
  for (const w of sw ?? []) targets.push({ address: w.address, partyId: w.party_id });

  const { results: dest } = await env.DB.prepare(
    `SELECT d.address, p.party_id FROM destinations d
       JOIN participations p ON p.id = d.participation_id
      WHERE p.transaction_id = ? AND d.kind = 'wallet' AND d.address IS NOT NULL`)
    .bind(txId).all<any>();
  for (const d of dest ?? []) targets.push({ address: d.address, partyId: d.party_id });

  if (t?.fee_wallet) targets.push({ address: t.fee_wallet, partyId: null });
  if (!targets.length) return { screened: 0, problem: "No addresses to screen yet." };

  const { labels, problem } = await quickCheck(env, targets.map((x) => x.address));

  let screened = 0;
  for (const target of targets) {
    const result = problem
      ? { verdict: "pending" as Verdict, findings: problem }
      : verdictFor(labels.get(target.address.toLowerCase()));
    const rowId = id("scr");
    await insert(env.DB, actor, "wallet.screened", "wallet_screens", rowId, {
      address: target.address,
      chain_id: chainId,
      transaction_id: txId,
      party_id: target.partyId,
      provider: "nominis",
      verdict: result.verdict,
      risk: result.risk ?? null,
      findings: result.findings ?? null,
      reference: result.reference ?? null,
      payload: result.payload ? JSON.stringify(result.payload) : null,
      screened_at: result.verdict === "pending" ? null
        : new Date().toISOString().replace("T", " ").slice(0, 19),
      // A machine verdict expires sooner than a considered human one: it is
      // a snapshot of what was known this morning.
      expires_at: result.verdict === "pending" ? null
        : new Date(Date.now() + 30 * 86_400_000)
            .toISOString().replace("T", " ").slice(0, 19),
    }, { note: `nominis: ${result.verdict}${result.risk ? ` (${result.risk})` : ""}` });
    screened++;
  }
  return { screened, problem };
}
