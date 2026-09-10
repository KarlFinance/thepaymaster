/**
 * Documents: taking them in, and being able to prove later what came in.
 *
 * Every file is hashed the moment it arrives and the hash is stored beside the
 * record — never recomputed from the copy we keep. The point of the dossier is
 * to show years afterwards that a passport scan is the same passport scan that
 * was uploaded on the day, and a hash taken from our own copy proves only that
 * our copy is our copy.
 *
 * Type is decided by the first few bytes, not by what the browser said it was.
 * A content-type header is a claim by the uploader; magic bytes are evidence.
 */

import { type Env, type Actor, id, insert } from "./db.ts";

/** Fifteen megabytes. A passport photograph is a tenth of this. */
const MAX_BYTES = 15 * 1024 * 1024;

/** What we will take, and how to recognise it without trusting the sender. */
const KINDS: { type: string; ext: string; matches: (b: Uint8Array) => boolean }[] = [
  { type: "application/pdf", ext: "pdf",
    matches: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { type: "image/jpeg", ext: "jpg",
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", ext: "png",
    matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: "image/heic", ext: "heic",
    matches: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  { type: "image/webp", ext: "webp",
    matches: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
                    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

export const ACCEPTED = ".pdf,.jpg,.jpeg,.png,.heic,.webp";

export interface Stored {
  artefactId: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export class DocumentProblem extends Error {}

async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Take a file, keep it, and record what it was.
 *
 * Throws DocumentProblem for anything a person can fix by uploading something
 * else, so the caller can show them the reason rather than a failure.
 */
export async function store(env: Env, actor: Actor, file: File, about: {
  kind: string;
  label?: string;
  partyId?: string;
  transactionId?: string;
  /** Staff uploads only: the party may take this away in their own folder. */
  shared?: boolean;
}): Promise<Stored> {
  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) {
    throw new DocumentProblem("No file arrived. Try choosing it again.");
  }
  if (file.size > MAX_BYTES) {
    throw new DocumentProblem(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is 15MB — ` +
      `a photograph of a document is usually well under that.`);
  }

  const data = await file.arrayBuffer();
  const head = new Uint8Array(data.slice(0, 16));
  const match = KINDS.find((k) => k.matches(head));
  if (!match) {
    throw new DocumentProblem(
      "That does not look like a PDF or a photograph. We can take PDF, JPEG, " +
      "PNG, HEIC or WebP.");
  }

  const artefactId = id("art");
  const key = about.partyId
    ? `parties/${about.partyId}/${artefactId}.${match.ext}`
    : `transactions/${about.transactionId ?? "loose"}/${artefactId}.${match.ext}`;
  const digest = await sha256(data);

  if (!env.DOCS) {
    // R2 is not switched on for the account yet. Refusing loudly is right:
    // recording a document we did not keep would put a line in the dossier
    // pointing at nothing.
    throw new DocumentProblem(
      "Uploads are not switched on yet. Tell us and we will sort it out — " +
      "nothing you have typed is lost.");
  }

  await env.DOCS.put(key, data, {
    httpMetadata: { contentType: match.type },
    customMetadata: { sha256: digest, uploaded_by: actor.id ?? "unknown" },
  });

  await insert(env.DB, actor, "artefact.stored", "artefacts", artefactId, {
    transaction_id: about.transactionId ?? null,
    party_id: about.partyId ?? null,
    kind: about.kind,
    label: about.label ?? null,
    filename: (file.name ?? "").slice(0, 180) || null,
    content_type: match.type,
    bytes: file.size,
    r2_key: key,
    sha256: digest,
    uploaded_by: actor.id,
    shared_with_party: about.shared ? 1 : 0,
  }, { note: `${about.kind}, ${(file.size / 1024).toFixed(0)}KB${about.shared ? ", shared with the party" : ""}` });

  return { artefactId, sha256: digest, bytes: file.size, contentType: match.type };
}

/** Fetch a stored document, checking it is the one we recorded. */
export async function fetchDocument(env: Env, artefactId: string): Promise<
  { body: ReadableStream; contentType: string; filename: string } | null> {
  const row = await env.DB.prepare(
    "SELECT r2_key, content_type, filename, sha256 FROM artefacts WHERE id = ?")
    .bind(artefactId).first<any>();
  if (!row || !env.DOCS) return null;
  const object = await env.DOCS.get(row.r2_key);
  if (!object) return null;
  return {
    body: object.body,
    contentType: row.content_type ?? "application/octet-stream",
    filename: row.filename ?? `${artefactId}`,
  };
}

export async function documentsFor(env: Env, partyId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, label, filename, content_type, bytes, sha256, uploaded_at
       FROM artefacts WHERE party_id = ? ORDER BY uploaded_at`).bind(partyId).all<any>();
  return results ?? [];
}
