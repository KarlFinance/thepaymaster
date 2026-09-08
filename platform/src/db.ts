/**
 * Database access, and the audit log that every write goes through.
 *
 * There is deliberately no way to change a row from application code without
 * saying who did it and why. `record` is the only mutation helper, and it
 * writes the before and after alongside the actor. Convenience would be a
 * plain `db.run(...)`; the whole product is the trail, so there isn't one.
 */

export interface Env {
  DB: D1Database;
  SESSION_SECRET: string;
  /** Set with `wrangler secret put RESEND_API_KEY`. Absent means mail is
   *  skipped and the skip is logged, rather than silently going nowhere. */
  RESEND_API_KEY?: string;
  /** Local development only — see the hostname guard where it is read. */
  DEV_ADMIN_EMAIL?: string;
  CLIENT_BASE?: string;
}

export interface Actor {
  kind: "admin" | "party" | "system";
  id: string | null;
  ip?: string;
}

export const SYSTEM: Actor = { kind: "system", id: null };

/** Short, unambiguous ids. No hyphens, no lookalike characters. */
export function id(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}_${out}`;
}

/**
 * The next transaction reference, TPM-2026-0043.
 *
 * Counted in its own table rather than from max() over transactions, so that
 * an abandoned or deleted deal never lets a reference be handed out twice.
 * A reference that has ever been issued is spent.
 */
export async function nextRef(db: D1Database): Promise<string> {
  const year = new Date().getUTCFullYear();
  await db.prepare(
    "INSERT INTO ref_counter (year, last) VALUES (?, 1) " +
    "ON CONFLICT(year) DO UPDATE SET last = last + 1"
  ).bind(year).run();
  const row = await db.prepare("SELECT last FROM ref_counter WHERE year = ?")
    .bind(year).first<{ last: number }>();
  return `TPM-${year}-${String(row!.last).padStart(4, "0")}`;
}

/**
 * Write to the log. Called by `record`; call it directly for things that are
 * events rather than row changes — a login, an invite sent, a file downloaded.
 */
export async function log(
  db: D1Database,
  actor: Actor,
  action: string,
  entityKind: string,
  entityId: string,
  extra: { before?: unknown; after?: unknown; note?: string } = {},
): Promise<void> {
  await db.prepare(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_kind, entity_id,
                            before_json, after_json, ip, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    actor.kind, actor.id, action, entityKind, entityId,
    extra.before === undefined ? null : JSON.stringify(extra.before),
    extra.after === undefined ? null : JSON.stringify(extra.after),
    actor.ip ?? null, extra.note ?? null,
  ).run();
}

/**
 * Insert a row and log it, in one batch.
 *
 * Insert and update are separate functions on purpose. They were one, deciding
 * between them by whether a `before` was supplied, and that inference quietly
 * turned an update of a transaction into an insert of a new one — caught only
 * by a NOT NULL constraint. An operation this consequential should be named,
 * not guessed.
 */
export async function insert(
  db: D1Database,
  actor: Actor,
  action: string,
  table: string,
  rowId: string,
  fields: Record<string, unknown>,
  opts: { note?: string } = {},
): Promise<void> {
  const keys = ["id", ...Object.keys(fields)];
  const marks = keys.map(() => "?").join(", ");
  await db.batch([
    db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${marks})`)
      .bind(rowId, ...Object.values(fields)),
    logStatement(db, actor, action, table, rowId, null, fields, opts.note),
  ]);
}

/**
 * Update a row and log it, in one batch.
 *
 * `before` is required rather than optional: a log entry that cannot say what
 * the value used to be is half a record, and this system is the record.
 */
export async function update(
  db: D1Database,
  actor: Actor,
  action: string,
  table: string,
  rowId: string,
  fields: Record<string, unknown>,
  before: Record<string, unknown>,
  opts: { note?: string } = {},
): Promise<void> {
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  await db.batch([
    db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`)
      .bind(...Object.values(fields), rowId),
    logStatement(db, actor, action, table, rowId, before, fields, opts.note),
  ]);
}

function logStatement(db: D1Database, actor: Actor, action: string, table: string,
                      rowId: string, before: unknown, after: unknown,
                      note?: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_kind, entity_id,
                            before_json, after_json, ip, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    actor.kind, actor.id, action, table, rowId,
    before === null || before === undefined ? null : JSON.stringify(before),
    JSON.stringify(after), actor.ip ?? null, note ?? null,
  );
}

/**
 * The states a transaction can move between.
 *
 * Nothing advances itself. Every arrow here is a person pressing a button, and
 * the log records which person. Tedious for a week, then it is the thing that
 * answers the question years later.
 */
export const FLOW: Record<string, string[]> = {
  draft:            ["awaiting_parties", "abandoned", "declined"],
  awaiting_parties: ["kyc", "draft", "abandoned", "declined"],
  kyc:              ["ready", "awaiting_parties", "abandoned", "declined"],
  ready:            ["settling", "kyc", "abandoned", "declined"],
  settling:         ["settled", "ready", "abandoned"],
  settled:          ["closed"],
  closed:           [],
  abandoned:        [],
  declined:         [],
};

export function canMove(from: string, to: string): boolean {
  return (FLOW[from] ?? []).includes(to);
}

/** The five types, derived rather than stored as a sixth field. */
export function typeName(t: { inbound: string; outbound: string; converts: number }): string {
  const inn = t.inbound === "fiat" ? "Fiat" : "Crypto";
  const out = t.outbound === "fiat" ? "Fiat" : "Crypto";
  if (t.inbound === "crypto" && t.outbound === "crypto") {
    return t.converts ? "Crypto → Crypto (with conversion)" : "Crypto → Crypto";
  }
  return `${inn} → ${out}`;
}

/** Only one of the five is executed by the sender rather than by us. */
export function isOnChain(t: { inbound: string; outbound: string; converts: number }): boolean {
  return t.inbound === "crypto" && t.outbound === "crypto" && !t.converts;
}

/** What a recipient has to supply is decided by the outbound leg alone. */
export function destinationKind(t: { outbound: string }): "bank" | "wallet" {
  return t.outbound === "fiat" ? "bank" : "wallet";
}
