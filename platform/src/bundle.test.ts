/**
 * The ZIP writer. Two things matter: the CRC is right (a wrong one and every
 * unzipper reports corruption) and the layout is the one they all read.
 *
 *   node --experimental-strip-types src/bundle.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { zip } from "./bundle.ts";

const enc = new TextEncoder();

test("a stored ZIP round-trips through the system unzip", () => {
  const bytes = zip([
    { name: "dossier.html", data: enc.encode("<!doctype html><p>hello</p>") },
    { name: "documents/art_1-report.pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]) },
    { name: "empty.txt", data: new Uint8Array(0) },
  ]);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const path = `${process.env.TMPDIR ?? "/tmp"}/tpm-zip-test-${process.pid}.zip`;
  writeFileSync(path, bytes);
  const out = execFileSync("unzip", ["-t", path]).toString();
  assert.match(out, /No errors detected/);
  const list = execFileSync("unzip", ["-Z1", path]).toString().trim().split("\n");
  assert.deepEqual(list, ["dossier.html", "documents/art_1-report.pdf", "empty.txt"]);
  const html = execFileSync("unzip", ["-p", path, "dossier.html"]).toString();
  assert.equal(html, "<!doctype html><p>hello</p>");
});
