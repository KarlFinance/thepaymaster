/**
 * The gate.
 *
 * A transaction cannot be marked ready until every one of these is green, and
 * each one says who made it green and when. That is the whole idea: not a
 * button somebody presses when it feels about right, but a list of specific
 * things that are true, attributable, and dated.
 *
 * The checks are computed fresh every time rather than cached on the
 * transaction. A verification that expired yesterday should close the gate
 * today without anybody having to remember to run something.
 */

import { type Env } from "./db.ts";
import { settle, format, type FeeMode } from "./money.ts";
import { standingCheck } from "./screening.ts";
import { CHAINS } from "./chain.ts";
import { railFor } from "./rail.ts";
import { forTransaction as agreementsFor } from "./agreements.ts";
import { isHouse } from "./housewallets.ts";
import { standing as standingScreen } from "./walletscreen.ts";
import { proved as provedAddress } from "./attest.ts";

export interface Check {
  key: string;
  label: string;
  met: boolean;
  /** What is true, or what is missing — always specific enough to act on. */
  detail: string;
  /** Set where a person made it true, so the gate shows whose word it is. */
  by?: string | null;
  at?: string | null;
}

export interface Readiness {
  checks: Check[];
  ready: boolean;
  /** The arithmetic, when it can be worked out. */
  settlement?: {
    grossMinor: number;
    feeMinor: number;
    netMinor: number;
    amounts: Record<string, number>;
  };
}

export async function assess(env: Env, transactionId: string,
                             opts: { onChain?: boolean; agreements?: boolean } = {}): Promise<Readiness> {
  const t = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(transactionId).first<any>();
  if (!t) return { checks: [], ready: false };

  const { results: people } = await env.DB.prepare(
    `SELECT p.id AS participation_id, p.role, p.amount_minor, p.share_bps,
            y.id AS party_id, y.display_name, y.email, y.kyc_submitted_at
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ?`).bind(transactionId).all<any>();
  const parties = people ?? [];
  const senders = parties.filter((p) => p.role === "sender");
  const recipients = parties.filter((p) => p.role === "recipient");

  const checks: Check[] = [];

  // --- who is on it --------------------------------------------------------
  checks.push({
    key: "sender",
    label: "A sender is named",
    met: senders.length === 1,
    detail: senders.length === 1 ? senders[0].display_name
      : senders.length === 0 ? "Nobody is down as the sender"
      : `${senders.length} senders — there can only be one`,
  });

  checks.push({
    key: "recipients",
    label: "At least one recipient",
    met: recipients.length > 0,
    detail: recipients.length
      ? `${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`
      : "Nobody to pay",
  });

  // --- the arithmetic ------------------------------------------------------
  let settlement: Readiness["settlement"];
  let amountsOk = false;
  let amountsDetail = "No amounts set";
  if (recipients.length) {
    const mode = (t.fee_mode as FeeMode) ?? "deducted";
    try {
      const splits = recipients.map((r) => ({
        id: r.participation_id,
        amountMinor: r.amount_minor ?? undefined,
        shareBps: r.share_bps ?? undefined,
      }));
      const result = settle(mode, t.fee_bps ?? 100, splits, {
        grossMinor: t.gross_expected_minor ?? undefined,
        remainderTo: t.remainder_to ?? undefined,
      });
      settlement = result;
      amountsOk = true;
      amountsDetail =
        `${t.currency_in} ${format(result.grossMinor, t.decimals_in)} in, ` +
        `fee ${format(result.feeMinor, t.decimals_in)}, ` +
        `${format(result.netMinor, t.decimals_out)} out`;
    } catch (err) {
      amountsDetail = (err as Error).message;
    }
  }
  checks.push({
    key: "amounts",
    label: "The split adds up",
    met: amountsOk,
    detail: amountsDetail,
  });

  // --- everybody is verified, to a level that covers this ------------------
  const gross = settlement?.grossMinor ?? t.gross_expected_minor ?? null;
  const unverified: string[] = [];
  const underCeiling: string[] = [];
  for (const p of parties) {
    if (p.role === "observer") continue;
    const standing = await standingCheck(env, p.party_id);
    if (!standing) {
      unverified.push(p.display_name);
      continue;
    }
    // A clearance for fifty thousand is not a clearance for five million.
    if (standing.band_ceiling_minor !== null && gross !== null
        && gross > standing.band_ceiling_minor) {
      underCeiling.push(
        `${p.display_name} (cleared to ${format(standing.band_ceiling_minor, 2)})`);
    }
  }
  checks.push({
    key: "verified",
    label: "Everyone is verified",
    met: unverified.length === 0 && underCeiling.length === 0,
    detail: unverified.length ? `Waiting on ${unverified.join(", ")}`
      : underCeiling.length ? `Cleared, but not for this size: ${underCeiling.join(", ")}`
      : `${parties.length} verified and in date`,
  });

  // --- and, for a wallet, that it really is theirs -------------------------
  if (t.outbound === "crypto") {
    const unproved: string[] = [];
    const attested: string[] = [];
    for (const r of recipients) {
      const d = await env.DB.prepare(
        "SELECT id, address, proved_at FROM destinations WHERE participation_id = ?")
        .bind(r.participation_id).first<any>();
      // A recipient with no wallet at all has certainly not proved one.
      // Skipping them made this line say "all proved" when nobody had.
      const p = await provedAddress(env, d);
      if (!p.ok) unproved.push(r.display_name);
      else if (p.how === "attested") attested.push(`${r.display_name} (${p.attestation!.custodian})`);
    }
    checks.push({
      key: "wallets_proved",
      label: "Every recipient has proved their wallet",
      met: recipients.length > 0 && unproved.length === 0,
      detail: unproved.length
        ? `No signature from ${unproved.join(", ")}`
        : !recipients.length ? "No recipients"
        : attested.length
          ? `Proved by signature, except accepted on evidence without one: ${attested.join(", ")}`
          : "All proved by signature",
    });
  }

  // --- where the money goes ------------------------------------------------
  const needs = t.outbound === "fiat" ? "bank details" : "wallet address";
  const missingDest: string[] = [];
  const unlocked: string[] = [];
  let lastLock: { by: string | null; at: string | null } = { by: null, at: null };
  for (const r of recipients) {
    const d = await env.DB.prepare(
      "SELECT status, kind, locked_at FROM destinations WHERE participation_id = ?")
      .bind(r.participation_id).first<any>();
    if (!d) { missingDest.push(r.display_name); continue; }
    if (d.status !== "locked") {
      unlocked.push(`${r.display_name} (${d.status})`);
    } else if (!lastLock.at || d.locked_at > lastLock.at) {
      lastLock = { by: null, at: d.locked_at };
    }
  }
  checks.push({
    key: "destinations",
    label: `Every recipient's ${needs} is locked`,
    met: recipients.length > 0 && missingDest.length === 0 && unlocked.length === 0,
    detail: missingDest.length ? `Nothing from ${missingDest.join(", ")}`
      : unlocked.length ? `Not locked yet: ${unlocked.join(", ")}`
      : recipients.length ? "All locked" : "No recipients",
    at: lastLock.at,
  });

  // --- the sending side ----------------------------------------------------
  if (t.inbound === "crypto") {
    const row = await env.DB.prepare(
      `SELECT count(*) AS n, sum(proved_at IS NOT NULL) AS proved
         FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL`)
      .bind(transactionId).first<any>();
    const n = row?.n ?? 0, proved = row?.proved ?? 0;
    // Recorded is not enough. On an irreversible transfer the only thing that
    // settles whose wallet this is, is a signature from the key.
    checks.push({
      key: "sending_wallets",
      label: "The sender's wallets are proved",
      met: n > 0 && proved === n,
      detail: n === 0 ? "No sending wallet given"
        : proved === n
          ? `${n} wallet${n === 1 ? "" : "s"}, all proved by signature`
          : `${n} given, only ${proved} proved by signature`,
    });
  }

  // --- what the chain itself says ------------------------------------------
  //
  // Only when asked for, because it is several network calls and the pipeline
  // renders this on every page. The transaction page asks; the board does not.
  if (opts.onChain && t.inbound === "crypto" && t.chain_id) {
    const rail = railFor(t);
    const chainId = t.chain_id as number;

    const addresses: { address: string; role: string }[] = [];
    const { results: sw } = await env.DB.prepare(
      "SELECT address FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL")
      .bind(transactionId).all<any>();
    for (const w of sw ?? []) addresses.push({ address: w.address, role: "sending" });
    for (const r of recipients) {
      const d = await env.DB.prepare(
        "SELECT address FROM destinations WHERE participation_id = ? AND kind = 'wallet'")
        .bind(r.participation_id).first<any>();
      if (d?.address) addresses.push({ address: d.address, role: r.display_name });
    }
    if (t.fee_wallet) addresses.push({ address: t.fee_wallet, role: "our fee" });

    // Without one, the 1% has nowhere to go. Skipping the check when the field
    // is empty would let a transaction reach "ready" with no fee destination
    // at all, which is exactly the case worth catching.
    // And it must be one of ours, from the Wallets page — an address typed into
    // a transaction is an address nobody reviewed.
    const house = await isHouse(env, rail.key, t.fee_wallet);
    if (!t.converts) checks.push({
      key: "fee_destination",
      label: "Our fee goes to a registered ThePaymaster wallet",
      met: Boolean(t.fee_wallet) && Boolean(house),
      detail: !t.fee_wallet
        ? "No fee wallet set on this transaction. Choose one under Chain settings."
        : house
          ? `${house.label}${house.proved_at ? "" : " (control not yet proved on the Wallets page)"}`
          : `${String(t.fee_wallet)} is not a registered ThePaymaster wallet on this rail. Choose one under Chain settings.`,
    });

    if (addresses.length) {
      const reports = await Promise.all(
        addresses.map((a) => rail.inspect(env, a.address, a.role)));

      // Tether can freeze an address, and a frozen recipient cannot receive.
      // Sending to one loses the funds in every sense that matters. A rail
      // whose asset has no issuer (Bitcoin) has no such line.
      const frozen = reports.filter((r) => r.frozen === true);
      const unknown = reports.filter((r) => r.frozen === null);
      if (rail.canFreeze) checks.push({
        key: "not_frozen",
        label: "No address is frozen by Tether",
        met: frozen.length === 0 && unknown.length === 0,
        detail: frozen.length
          ? `FROZEN: ${frozen.map((r) => `${r.role} ${r.address}`).join(", ")}`
          : unknown.length
            ? `Could not check ${unknown.map((r) => r.role).join(", ")} — try again`
            : `${reports.length} addresses checked, none frozen`,
      });

      // The sender must actually hold it. Discovering otherwise at execution
      // is a reverted transaction and a very awkward telephone call.
      const held = reports.filter((r) => r.role === "sending")
        .reduce((a, r) => a + (r.balance ?? 0n), 0n);
      const need = gross === null ? null : BigInt(gross);
      checks.push({
        key: "sender_holds",
        label: "The sender holds enough",
        met: need !== null && held >= need,
        detail: need === null ? "No amount to check against"
          : held >= need
            ? `${format(Number(held), t.decimals_in)} across ${
                reports.filter((r) => r.role === "sending").length} wallet(s)`
            : `Holds ${format(Number(held), t.decimals_in)}, needs ${
                format(Number(need), t.decimals_in)}`,
      });

      // Tether's blacklist says whether an address can receive. Screening says
      // whether it should. Both, or neither is worth much.
      const screens = await Promise.all(addresses.map(async (a) => ({
        ...a, screen: await standingScreen(env, a.address, chainId),
      })));
      const unscreened = screens.filter((s) => !s.screen || s.screen.verdict === "pending");
      const badScreens = screens.filter((s) =>
        s.screen && (s.screen.verdict === "flagged" || s.screen.verdict === "refused"));
      checks.push({
        key: "screened",
        label: "Every address has been screened",
        met: unscreened.length === 0 && badScreens.length === 0,
        detail: badScreens.length
          ? `${badScreens.map((s) => `${s.role} — ${s.screen.verdict}${
              s.screen.findings ? `: ${s.screen.findings}` : ""}`).join("; ")}`
          : unscreened.length
            ? `Not screened yet: ${unscreened.map((s) => s.role).join(", ")}`
            : `${screens.length} screened and clear`,
      });

      // A contract can be a perfectly good destination — a Safe, an exchange —
      // or a hole. Flagged rather than judged.
      const contracts = reports.filter((r) => r.contract === true && r.role !== "sending");
      if (contracts.length) {
        checks.push({
          key: "contract_recipients",
          label: "Contract addresses have been looked at",
          met: false,
          detail: `${contracts.map((r) => r.role).join(", ")} ${
            contracts.length === 1 ? "is a contract" : "are contracts"} — confirm ` +
            `each can receive USDT before anything is sent`,
        });
      }
    }
  }

  // --- and, for a bank account, that the penny came back ---------------------
  if (t.outbound === "fiat") {
    const unproved: string[] = [];
    for (const r of recipients) {
      const d = await env.DB.prepare(
        "SELECT proved_at FROM destinations WHERE participation_id = ?")
        .bind(r.participation_id).first<any>();
      if (!d?.proved_at) unproved.push(r.display_name);
    }
    checks.push({
      key: "accounts_proved",
      label: "Every recipient has passed the penny test",
      met: recipients.length > 0 && unproved.length === 0,
      detail: unproved.length ? `Waiting on ${unproved.join(", ")}`
        : `${recipients.length} account${recipients.length === 1 ? "" : "s"} proved by penny`,
    });
  }

  // --- Mode C: our client wallet is registered and proved -------------------
  if ((t.inbound === "crypto" && t.outbound === "crypto" && !t.converts && t.execution === "client_wallet")
      || (t.converts && t.outbound === "crypto")) {
    const rail = railFor(t);
    const cw = t.client_wallet ? await isHouse(env, rail.key, t.client_wallet) : null;
    checks.push({
      key: "client_wallet",
      label: "The client wallet is one of ours and its control is proved",
      met: Boolean(cw && cw.role === "client" && cw.proved_at),
      detail: !t.client_wallet ? "No client wallet chosen under Chain settings"
        : !cw ? `${String(t.client_wallet)} is not a registered client wallet on this rail`
        : cw.role !== "client" ? `${cw.label} is a fee wallet, not a client wallet`
        : !cw.proved_at ? `${cw.label} — control not yet proved on the Wallets page`
        : cw.label,
    });
  }

  // --- the agreements ------------------------------------------------------
  // Skipped only when the agreements module itself is asking for the
  // arithmetic, which is how it fills the schedules.
  if (opts.agreements !== false) {
    const sigs = await agreementsFor(env, transactionId);
    const missing = sigs.filter((s) => s.state !== "signed");
    checks.push({
      key: "agreements",
      label: "Every party has signed their agreement",
      met: sigs.length > 0 && missing.length === 0,
      detail: !sigs.length ? "No parties yet"
        : missing.length ? `Waiting on ${missing.map((s) => `${s.name}${s.state === "stale" ? " (signed before the facts changed)" : ""}`).join(", ")}`
        : `${sigs.length} signed: the Sender's Paymaster Agreement and every Recipient's Authorisation`,
    });
  }

  // --- the paperwork -------------------------------------------------------
  if (t.inbound === "fiat" || t.outbound === "fiat") {
    checks.push({
      key: "acting_for",
      label: "Which side we act for is recorded",
      met: Boolean(t.acting_for),
      detail: t.acting_for
        ? `The ${t.acting_for}`
        : "Not decided — paragraph 2(b) is only available to an agent acting for one side",
    });
  }

  return { checks, ready: checks.every((c) => c.met), settlement };
}

/** A one-line summary for the pipeline card. */
export function summarise(r: Readiness): string {
  const done = r.checks.filter((c) => c.met).length;
  return `${done} of ${r.checks.length}`;
}
