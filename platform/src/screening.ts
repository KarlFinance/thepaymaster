/**
 * Who checks a party, and what counts as checked.
 *
 * Today the answer is Themis: we collect the documents and details, a person
 * here runs the check there, and records the conclusion. That is a perfectly
 * respectable arrangement and the system should not pretend otherwise — what
 * it must do is make the conclusion attributable, dated, and bounded.
 *
 * Sumsub is written but switched off. The point of the interface is that
 * turning it on later is a configuration change and a new adapter, not a
 * rewrite of the flow around it: the same submission, the same review queue,
 * the same decision record, with a different thing producing the verdict.
 */

import { type Env, type Actor, id, log, insert } from "./db.ts";

export type Decision = "pending" | "passed" | "failed";

export interface Subject {
  partyId: string;
  kind: "individual" | "company";
  name: string;
  email: string;
  dateOfBirth?: string | null;
  nationality?: string | null;
  residence?: string | null;
  companyNumber?: string | null;
  incorporatedIn?: string | null;
}

export interface Outcome {
  decision: Decision;
  /** The provider's own identifier, so a verdict can be traced back. */
  reference?: string;
  /** Anything the provider returned, kept verbatim for the dossier. */
  payload?: unknown;
  note?: string;
}

export interface Provider {
  readonly name: string;
  /** False when the provider is present in the code but not in use. */
  readonly active: (env: Env) => boolean;
  /**
   * Begin a check. A provider that decides for itself returns a verdict; one
   * that does not returns 'pending' and waits for a person.
   */
  begin(env: Env, subject: Subject): Promise<Outcome>;
}

// ---------------------------------------------------------------------------
// Themis — what we actually use
// ---------------------------------------------------------------------------

/**
 * Themis has no automated hook here yet.
 *
 * The submission is recorded as pending and lands in the review queue; someone
 * runs the check at Themis and enters the conclusion, with their name against
 * it. Modelling that honestly is better than pretending an integration exists:
 * the dossier says a person concluded this, on this date, having looked at
 * these documents — which is exactly what happened.
 */
export const themis: Provider = {
  name: "themis",
  active: () => true,
  async begin(): Promise<Outcome> {
    return {
      decision: "pending",
      note: "Collected and awaiting a Themis check by one of us",
    };
  },
};

// ---------------------------------------------------------------------------
// Sumsub — built, dark
// ---------------------------------------------------------------------------

/**
 * Present so that switching to it is configuration rather than surgery.
 *
 * It becomes active the moment SUMSUB_TOKEN and SUMSUB_SECRET exist. Until
 * then `active` is false and nothing calls it, so the code can be read and
 * corrected without being able to do anything.
 *
 * Sumsub signs requests with an HMAC over the method, path, body and a
 * timestamp; that is implemented here because it is the part most likely to be
 * got wrong in a hurry later.
 */
export const sumsub: Provider = {
  name: "sumsub",
  active: (env: Env) => Boolean(env.SUMSUB_TOKEN && env.SUMSUB_SECRET),

  async begin(env: Env, subject: Subject): Promise<Outcome> {
    if (!sumsub.active(env)) {
      return { decision: "pending", note: "Sumsub is configured off" };
    }
    const path = "/resources/applicants?levelName=" +
      encodeURIComponent(subject.kind === "company" ? "basic-kyb" : "basic-kyc");
    const body = JSON.stringify({
      externalUserId: subject.partyId,
      email: subject.email,
      info: {
        firstName: subject.name.split(" ")[0],
        lastName: subject.name.split(" ").slice(1).join(" ") || undefined,
        dob: subject.dateOfBirth ?? undefined,
        nationality: subject.nationality ?? undefined,
        country: subject.residence ?? undefined,
      },
    });

    const ts = Math.floor(Date.now() / 1000).toString();
    const key = await crypto.subtle.importKey("raw",
      new TextEncoder().encode(env.SUMSUB_SECRET!),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key,
      new TextEncoder().encode(ts + "POST" + path + body));
    const signature = [...new Uint8Array(sig)]
      .map((b) => b.toString(16).padStart(2, "0")).join("");

    const res = await fetch("https://api.sumsub.com" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-App-Token": env.SUMSUB_TOKEN!,
        "X-App-Access-Ts": ts,
        "X-App-Access-Sig": signature,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      return { decision: "pending", note: `Sumsub ${res.status}: ${text.slice(0, 160)}` };
    }
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* keep the text */ }
    // Sumsub answers asynchronously by webhook; creating the applicant is not
    // a verdict, so this stays pending either way.
    return {
      decision: "pending",
      reference: parsed?.id,
      payload: parsed ?? text,
      note: "Applicant created at Sumsub, awaiting their review",
    };
  },
};

// ---------------------------------------------------------------------------

export function provider(env: Env): Provider {
  return sumsub.active(env) ? sumsub : themis;
}

/**
 * Record that a party has been put forward for checking.
 *
 * The verification row is created pending and stays on the record whatever
 * happens next, so a refusal is as visible afterwards as an approval.
 */
export async function beginCheck(env: Env, actor: Actor, subject: Subject): Promise<string> {
  const p = provider(env);
  const outcome = await p.begin(env, subject);
  const vid = id("ver");
  await insert(env.DB, actor, "verification.started", "verifications", vid, {
    party_id: subject.partyId,
    kind: subject.kind === "company" ? "kyb" : "kyc",
    party_kind: subject.kind,
    provider: p.name,
    provider_ref: outcome.reference ?? null,
    reference: outcome.reference ?? null,
    payload: outcome.payload ? JSON.stringify(outcome.payload) : null,
    status: outcome.decision,
    notes: outcome.note ?? null,
  }, { note: `${p.name} — ${outcome.decision}` });
  return vid;
}

/**
 * The verification that currently counts for a party, if any.
 *
 * Passed, not expired, most recent first. A clearance with a value ceiling
 * below the transaction in hand is not a clearance for that transaction, so
 * the ceiling comes back with it rather than being checked here.
 */
export async function standingCheck(env: Env, partyId: string): Promise<{
  id: string; kind: string; provider: string; verified_at: string | null;
  expires_at: string | null; band_ceiling_minor: number | null;
} | null> {
  return env.DB.prepare(
    `SELECT id, kind, provider, verified_at, expires_at, band_ceiling_minor
       FROM verifications
      WHERE party_id = ? AND status = 'passed'
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      -- Same tie-break as wallet screening: one-second timestamps are not an
      -- ordering on their own.
      ORDER BY verified_at DESC, rowid DESC LIMIT 1`).bind(partyId).first<any>();
}

/** Everything ever concluded about a party, newest first. */
export async function history(env: Env, partyId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, provider, status, verified_at, expires_at,
            band_ceiling_minor, decided_by, notes, created_at
       FROM verifications WHERE party_id = ? ORDER BY created_at DESC`)
    .bind(partyId).all<any>();
  return results ?? [];
}
