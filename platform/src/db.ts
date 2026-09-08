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
 * Insert or update a row and log it in the same breath.
 *
 * D1 has no interactive transactions, so this uses a batch: the write and its
 * log entry either both land or neither does. An unlogged change is not a
 * change this system is willing to make.
 */
export async function record(
  db: D1Database,
  actor: Actor,
  action: string,
  table: string,
  rowId: string,
  fields: Record<string, unknown>,
  opts: { before?: unknown; note?: string } = {},
): Promise<void> {
  const isInsert = opts.before === undefined;
  let stmt: D1PreparedStatement;

  if (isInsert) {
    const keys = ["id", ...Object.keys(fields)];
    const marks = keys.map(() => "?").join(", ");
    stmt = db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${marks})`)
      .bind(rowId, ...Object.values(fields));
  } else {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
    stmt = db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`)
      .bind(...Object.values(fields), rowId);
  }

  const logStmt = db.prepare(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_kind, entity_id,
                            before_json, after_json, ip, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    actor.kind, actor.id, action, table, rowId,
    opts.before === undefined ? null : JSON.stringify(opts.before),
    JSON.stringify(fields),
    actor.ip ?? null, opts.note ?? null,
  );

  await db.batch([stmt, logStmt]);
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
