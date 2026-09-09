/**
 * The dossier: what happened, and proof that this is what happened.
 *
 * Everything here already exists in the tables around it. What this adds is a
 * commitment. Each fact is serialised in a way that can be reproduced exactly,
 * hashed, and folded into a Merkle tree; the root is one line of hex that
 * stands for the whole record at a moment in time.
 *
 * Three properties are worth the effort:
 *
 *   A bank can verify a single document without being handed the file. Give
 *   them the document's hash, its position, and the audit path — a handful of
 *   hashes — and they can arrive at the root themselves. Nothing else about the
 *   deal is disclosed, which matters when the other parties have a right not to
 *   be shown to each other.
 *
 *   Nobody has to trust us. The rules below are published with the dossier, so
 *   the recipient recomputes rather than believes. A dossier that has been
 *   altered cannot produce its own root again.
 *
 *   It survives us. The verification depends on SHA-256 and the ordering rules
 *   written here, not on this software still running in five years.
 *
 * The rules, stated once and then never changed:
 *
 *   - A leaf is SHA-256 over the canonical JSON of one fact, UTF-8, no
 *     whitespace, object keys sorted by Unicode code point, nulls dropped.
 *   - Leaves are ordered by (kind, id), both ascending, compared as strings.
 *   - Interior nodes are SHA-256 over the two child digests concatenated as
 *     raw bytes, left then right.
 *   - An odd node at any level is promoted unchanged to the next level. It is
 *     not duplicated: duplicating permits two different leaf sets to produce
 *     the same root, which would make the whole exercise pointless.
 *   - A tree with one leaf has that leaf as its root. A tree with none has a
 *     root of sixty-four zeroes.
 */

import { type Env, type Actor, id, insert, update } from "./db.ts";
import { sentTransaction, blockTime, txHashProblem } from "./chain.ts";
import { sealed } from "./notify.ts";

export const ALGORITHM = "sha256-merkle-v1";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data as unknown as BufferSource));
}

function bytes(hexString: string): Uint8Array {
  return Uint8Array.from(hexString.match(/../g)!.map((b) => parseInt(b, 16)));
}

/**
 * JSON that two people can produce independently and get the same string.
 *
 * JSON.stringify is not canonical: key order follows insertion, which follows
 * whatever the SELECT returned. Sorting is the whole point — without it the
 * root depends on the column order of a query written years ago.
 */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("not representable");
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export async function leafHash(fact: Fact): Promise<string> {
  return sha256(new TextEncoder().encode(
    canonical({ kind: fact.kind, id: fact.id, data: fact.data })));
}

export const EMPTY_ROOT = "0".repeat(64);

/** Fold a list of leaf digests into one. See the rules at the top of the file. */
export async function merkleRoot(leaves: string[]): Promise<string> {
  if (!leaves.length) return EMPTY_ROOT;
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);              // promoted, never duplicated
      } else {
        const pair = new Uint8Array(64);
        pair.set(bytes(level[i]), 0);
        pair.set(bytes(level[i + 1]), 32);
        next.push(await sha256(pair));
      }
    }
    level = next;
  }
  return level[0];
}

export interface Step { hash: string; side: "left" | "right" }

/**
 * The hashes a third party needs to get from one leaf to the root, and nothing
 * more. This is what lets a bank check one document without seeing the deal.
 */
export async function auditPath(leaves: string[], index: number): Promise<Step[]> {
  if (index < 0 || index >= leaves.length) throw new Error("no such leaf");
  const path: Step[] = [];
  let level = leaves;
  let at = index;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        if (i === at) at = next.length;
        next.push(level[i]);
        continue;
      }
      if (i === at) path.push({ hash: level[i + 1], side: "right" });
      else if (i + 1 === at) path.push({ hash: level[i], side: "left" });
      if (i === at || i + 1 === at) at = next.length;
      const pair = new Uint8Array(64);
      pair.set(bytes(level[i]), 0);
      pair.set(bytes(level[i + 1]), 32);
      next.push(await sha256(pair));
    }
    level = next;
  }
  return path;
}

/** The check a third party runs. Deliberately tiny, so it can be re-implemented. */
export async function verifyPath(leaf: string, path: Step[], root: string): Promise<boolean> {
  let acc = leaf;
  for (const step of path) {
    const pair = new Uint8Array(64);
    pair.set(bytes(step.side === "left" ? step.hash : acc), 0);
    pair.set(bytes(step.side === "left" ? acc : step.hash), 32);
    acc = await sha256(pair);
  }
  return acc === root;
}

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

export interface Fact {
  kind: string;
  id: string;
  /** For the reader, not part of the hash. */
  title: string;
  data: Record<string, unknown>;
}

const drop = (row: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

/**
 * Every fact on the record for one transaction, in the order the rules require.
 *
 * Whole rows are taken rather than chosen columns, minus the few that are
 * storage detail. Choosing what to include invites choosing what to leave out,
 * and a dossier that omits the inconvenient parts is not evidence.
 *
 * Documents contribute their SHA-256 and their metadata, never their contents:
 * the hash is what proves a file has not changed, and the file itself stays
 * where access to it can be controlled.
 */
export async function facts(env: Env, txId: string): Promise<Fact[]> {
  const q = async (sql: string, ...binds: unknown[]) =>
    ((await env.DB.prepare(sql).bind(...binds).all<any>()).results ?? []);

  const out: Fact[] = [];
  const add = (kind: string, rowId: string, title: string, data: Record<string, unknown>) =>
    out.push({ kind, id: rowId, title, data });

  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!tx) return [];
  add("01-transaction", tx.id, `Transaction ${tx.ref}`, drop(tx, []));

  for (const p of await q(
    `SELECT pa.* FROM parties pa
       JOIN participations pt ON pt.party_id = pa.id
      WHERE pt.transaction_id = ? GROUP BY pa.id`, txId)) {
    add("02-party", p.id, `Party — ${p.display_name}`, p);
  }
  for (const r of await q(
    "SELECT * FROM participations WHERE transaction_id = ?", txId)) {
    add("03-participation", r.id, `Role — ${r.role}`, r);
  }
  for (const v of await q(
    `SELECT v.* FROM verifications v
      WHERE v.party_id IN (SELECT party_id FROM participations WHERE transaction_id = ?)`,
    txId)) {
    add("04-verification", v.id, `Verification — ${v.kind} ${v.status}`, v);
  }
  for (const w of await q(
    "SELECT * FROM sending_wallets WHERE transaction_id = ?", txId)) {
    add("05-sending-wallet", w.id, `Sending wallet ${w.address}`, w);
  }
  for (const d of await q(
    `SELECT d.* FROM destinations d
       JOIN participations pt ON pt.id = d.participation_id
      WHERE pt.transaction_id = ?`, txId)) {
    add("06-destination", d.id, "Destination", d);
  }
  for (const a of await q(
    `SELECT a.* FROM address_attestations a
       JOIN destinations d ON d.id = a.destination_id
       JOIN participations pt ON pt.id = d.participation_id
      WHERE pt.transaction_id = ?`, txId)) {
    // The title carries the caveat. Anyone skimming the record must see, at
    // the line, that this address was accepted on evidence and not by its key.
    add("06b-address-attestation", a.id,
        a.revoked_at
          ? `Address accepted without signature — ${a.custodian} — REVOKED`
          : `Address accepted without signature — ${a.custodian} deposit address, on evidence`,
        a);
  }
  for (const s of await q(
    "SELECT * FROM wallet_screens WHERE transaction_id = ?", txId)) {
    add("07-screening", s.id, `Screening — ${s.verdict}`, drop(s, ["payload"]));
  }
  for (const c of await q(
    "SELECT * FROM custody_events WHERE transaction_id = ?", txId)) {
    add("08-custody", c.id, `${c.event} — ${c.currency}`, c);
  }
  for (const m of await q(
    "SELECT * FROM mandates WHERE transaction_id = ?", txId)) {
    // The wording is part of the fact. A mandate recording only that somebody
    // "agreed to the standard terms" would prove nothing later.
    add("08b-mandate", m.id,
        m.signed_at ? `Authority to prepare — signed by ${m.signed_name}`
                    : "Authority to prepare — requested", m);
  }
  // A party's documents — passport, proof of address, the screening report —
  // belong to every transaction that party is on, not to the one they
  // happened to be uploaded during.
  for (const a of await q(
    `SELECT * FROM artefacts
      WHERE transaction_id = ?
         OR party_id IN (SELECT party_id FROM participations WHERE transaction_id = ?)`,
    txId, txId)) {
    add("09-document", a.id, a.label ?? a.filename ?? "Document", drop(a, ["r2_key"]));
  }
  for (const l of await q(
    `SELECT * FROM audit_log
      WHERE entity_id = ?
         OR entity_id IN (SELECT id FROM participations WHERE transaction_id = ?)
         OR entity_id IN (SELECT id FROM custody_events WHERE transaction_id = ?)
      ORDER BY id`, txId, txId, txId)) {
    add("10-audit", String(l.id).padStart(12, "0"), l.action, l);
  }

  // The ordering rule, applied once, here.
  return out.sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface Built {
  facts: Fact[];
  leaves: string[];
  root: string;
}

export async function build(env: Env, txId: string): Promise<Built> {
  const f = await facts(env, txId);
  const leaves = await Promise.all(f.map(leafHash));
  return { facts: f, leaves, root: await merkleRoot(leaves) };
}

// ---------------------------------------------------------------------------

export interface Seal {
  id: string; root: string; leaf_count: number; algorithm: string;
  sealed_by: string | null; sealed_at: string;
  anchor_chain_id: number | null; anchor_tx_hash: string | null;
}

/** Commit to the record as it stands. Never replaces an earlier seal. */
export async function seal(env: Env, actor: Actor, txId: string): Promise<Seal> {
  const built = await build(env, txId);
  const rowId = id("seal");
  await insert(env.DB, actor, "dossier.sealed", "dossier_seals", rowId, {
    transaction_id: txId,
    root: built.root,
    leaf_count: built.leaves.length,
    algorithm: ALGORITHM,
    sealed_by: actor.id,
  }, { note: `${built.root} over ${built.leaves.length} facts` });
  // A sealed, settled transaction is closed. Anything still open after a seal
  // is not finished, and the stage should not pretend otherwise.
  const st = await env.DB.prepare("SELECT status FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (st?.status === "settled") {
    await update(env.DB, actor, "transaction.closed", "transactions", txId,
      { status: "closed" }, { status: "settled" }, { note: "record sealed" });
  }
  await sealed(env, actor, txId, built.root);
  return (await env.DB.prepare("SELECT * FROM dossier_seals WHERE id = ?")
    .bind(rowId).first<any>()) as Seal;
}

export async function seals(env: Env, txId: string): Promise<Seal[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM dossier_seals WHERE transaction_id = ?
      ORDER BY sealed_at DESC, rowid DESC`).bind(txId).all<any>();
  return (results ?? []) as Seal[];
}

// ---------------------------------------------------------------------------
// Selective disclosure
// ---------------------------------------------------------------------------

export interface OwnFact {
  title: string;
  data: Record<string, unknown>;
  leaf: string;
  path: Step[];
}

export interface OwnRecord {
  root: string;
  sealedAt: string | null;
  facts: OwnFact[];
  /** Facts on the record that are not this party's, disclosed only as a count. */
  others: number;
}

/**
 * One party's own facts, each with the hashes that tie it to the whole record.
 *
 * This is the point of the Merkle tree rather than a plain list of hashes. A
 * recipient can show their bank that their payment is part of a sealed record,
 * and prove it arithmetically, while learning nothing about who else was paid
 * or how much. The other parties appear only as a number, because concealing
 * even that would make the root unverifiable.
 */
export async function ownRecord(env: Env, txId: string,
                                partyId: string): Promise<OwnRecord> {
  const built = await build(env, txId);

  const mine = new Set<string>();
  const { results: rows } = await env.DB.prepare(
    `SELECT p.id AS participation_id, d.id AS destination_id
       FROM participations p
       LEFT JOIN destinations d ON d.participation_id = p.id
      WHERE p.transaction_id = ? AND p.party_id = ?`).bind(txId, partyId).all<any>();
  for (const r of rows ?? []) {
    if (r.participation_id) mine.add(String(r.participation_id));
    if (r.destination_id) mine.add(String(r.destination_id));
  }
  mine.add(partyId);

  const facts: OwnFact[] = [];
  for (let i = 0; i < built.facts.length; i++) {
    const f = built.facts[i];
    const belongs = mine.has(f.id) ||
      f.data.party_id === partyId ||
      (f.kind.endsWith("transaction"));      // the deal terms are shared ground
    if (!belongs) continue;
    facts.push({
      title: f.title,
      data: f.data,
      leaf: built.leaves[i],
      path: await auditPath(built.leaves, i),
    });
  }

  const history = await seals(env, txId);
  const current = history.find((h) => h.root === built.root);
  return {
    root: built.root,
    sealedAt: current?.sealed_at ?? null,
    facts,
    others: built.facts.length - facts.length,
  };
}

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

/**
 * Why anchor at all.
 *
 * A seal says "at this moment the record was exactly this". But the moment is
 * one we assert, in our own database, and a party who doubts us has no way to
 * check it. Writing the root into a public chain replaces our word about *when*
 * with a fact thousands of independent machines agree on. It proves the record
 * existed no later than that block — which is the property that matters, since
 * the risk is always a record improved after the fact.
 *
 * It does not need a contract, and deliberately does not use one. The root
 * travels as the calldata of an ordinary zero-value transaction from a wallet
 * we control to itself. Nothing is deployed, nothing is spent but gas, and
 * there is no code to audit.
 *
 * **No key ever reaches this software.** The platform composes the transaction
 * and a person sends it from their own wallet, exactly as a sender executes
 * their own distribution. What comes back is a hash, and the only thing the
 * platform then does is check the chain agrees.
 */
export const ANCHOR_TAG = "TPM-DOSSIER-1:";

/** The calldata that carries a root. Tag first, so it is legible on a block explorer. */
export function anchorData(root: string): string {
  const tag = [...new TextEncoder().encode(ANCHOR_TAG)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return "0x" + tag + root.toLowerCase();
}

export interface Anchor {
  chainId: number; txHash: string; block: number; at: string; from: string;
  sources: number;
}

/**
 * Record that a root is on the chain — having checked that it actually is.
 *
 * Every way this could be wrong is a refusal, not a warning: the wrong hash,
 * a transaction that carries a different root, one that never landed, or
 * endpoints that disagree about what it contains.
 */
export async function anchor(env: Env, actor: Actor, sealId: string, opts: {
  chainId: number; txHash: string;
}): Promise<Anchor | { problem: string }> {
  const hash = opts.txHash.trim();
  const shape = txHashProblem(hash);
  if (shape) return { problem: shape };

  const row = await env.DB.prepare(
    "SELECT id, root, anchor_tx_hash FROM dossier_seals WHERE id = ?")
    .bind(sealId).first<any>();
  if (!row) return { problem: "No such seal." };
  if (row.anchor_tx_hash) {
    return { problem: "That seal is already anchored. Seal again to anchor a new root." };
  }

  const sent = await sentTransaction(env, opts.chainId, hash);
  if (!sent) return { problem: "Could not reach the chain to check that hash. Try again." };
  if (!sent.agreed) {
    return { problem: `The chain providers disagree about that transaction — ${sent.conflict}.` };
  }
  if (!sent.input) {
    return { problem: "No transaction with that hash. Check it, or wait for it to land." };
  }
  if (sent.block === null) {
    return { problem: "That transaction has not been included in a block yet. Try again shortly." };
  }

  const expected = anchorData(row.root);
  if (sent.input !== expected) {
    // Say what it did carry, because the usual cause is the right hash pasted
    // against the wrong seal, or a transaction sent without the data field.
    const carried = sent.input === "0x" || sent.input === ""
      ? "no data at all"
      : sent.input.startsWith(anchorData("").slice(0, 30))
        ? `the root ${sent.input.slice(-64)}`
        : `${sent.input.slice(0, 26)}…`;
    return { problem: "That transaction does not carry this root — it carried " +
      `${carried}. Send the data shown below, exactly as printed.` };
  }

  const seconds = await blockTime(env, opts.chainId, sent.block);
  const at = seconds
    ? new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19)
    : new Date().toISOString().replace("T", " ").slice(0, 19);

  await update(env.DB, actor, "dossier.anchored", "dossier_seals", sealId, {
    anchor_chain_id: opts.chainId,
    anchor_tx_hash: hash,
    anchored_at: at,
  }, { anchor_chain_id: null, anchor_tx_hash: null, anchored_at: null },
     { note: `${row.root} anchored in block ${sent.block}` });

  return { chainId: opts.chainId, txHash: hash, block: sent.block, at,
           from: sent.from, sources: sent.sources };
}
