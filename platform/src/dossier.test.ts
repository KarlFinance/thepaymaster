/**
 * The dossier's arithmetic, tested the way an adversary would.
 *
 * The interesting failures are not "does it produce a hash" but "can two
 * different records produce the same one", and "does a changed fact still
 * verify". Both are tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, merkleRoot, auditPath, verifyPath, leafHash, EMPTY_ROOT,
         anchorData, ANCHOR_TAG } from "./dossier.ts";

const leaves = async (n: number) =>
  Promise.all([...Array(n)].map((_, i) => leafHash(
    { kind: "x", id: String(i), title: "", data: { i } })));

test("canonical JSON does not depend on key order", () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
  assert.equal(canonical({ a: 2, b: 1 }), '{"a":2,"b":1}');
});

test("nulls are dropped, so a column added later does not change old hashes", () => {
  assert.equal(canonical({ a: 1, b: null }), canonical({ a: 1 }));
});

test("nested objects are sorted too", () => {
  assert.equal(canonical({ z: { d: 1, c: 2 } }), '{"z":{"c":2,"d":1}}');
});

test("an empty record has a stated root rather than an error", async () => {
  assert.equal(await merkleRoot([]), EMPTY_ROOT);
});

test("one fact is its own root", async () => {
  const one = await leaves(1);
  assert.equal(await merkleRoot(one), one[0]);
});

test("the odd leaf is promoted, not duplicated", async () => {
  // If an odd leaf were duplicated, a three-leaf tree [a,b,c] and a four-leaf
  // tree [a,b,c,c] would share a root — two different records, one commitment.
  const [a, b, c] = await leaves(3);
  assert.notEqual(await merkleRoot([a, b, c]), await merkleRoot([a, b, c, c]));
});

test("order matters: the same facts rearranged are a different record", async () => {
  const [a, b] = await leaves(2);
  assert.notEqual(await merkleRoot([a, b]), await merkleRoot([b, a]));
});

test("every leaf can prove itself, at every tree size", async () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 16, 33]) {
    const l = await leaves(n);
    const root = await merkleRoot(l);
    for (let i = 0; i < n; i++) {
      const path = await auditPath(l, i);
      assert.ok(await verifyPath(l[i], path, root),
        `leaf ${i} of ${n} failed to prove itself`);
    }
  }
});

test("a document that has been altered cannot prove itself", async () => {
  const l = await leaves(9);
  const root = await merkleRoot(l);
  const path = await auditPath(l, 4);
  const tampered = await leafHash(
    { kind: "x", id: "4", title: "", data: { i: 4, amount: "changed" } });
  assert.equal(await verifyPath(tampered, path, root), false);
});

test("a genuine leaf with somebody else's path does not verify", async () => {
  const l = await leaves(8);
  const root = await merkleRoot(l);
  assert.equal(await verifyPath(l[2], await auditPath(l, 5), root), false);
});

test("a path is short enough to hand over on paper", async () => {
  const l = await leaves(1000);
  assert.ok((await auditPath(l, 500)).length <= 10);
});

test("the proof reveals nothing but hashes", async () => {
  const l = await leaves(8);
  const path = await auditPath(l, 3);
  for (const step of path) {
    assert.match(step.hash, /^[0-9a-f]{64}$/);
    assert.ok(step.side === "left" || step.side === "right");
  }
});

test("the anchor payload is the tag then the root, and nothing else", () => {
  const root = "a".repeat(64);
  const data = anchorData(root);
  assert.ok(data.endsWith(root));
  assert.equal((data.length - 2) / 2, ANCHOR_TAG.length + 32);
  // Legible on a block explorer, which is the point of a text tag.
  const tag = Buffer.from(data.slice(2, 2 + ANCHOR_TAG.length * 2), "hex").toString();
  assert.equal(tag, ANCHOR_TAG);
});

test("a different root is a different payload", () => {
  assert.notEqual(anchorData("a".repeat(64)), anchorData("b".repeat(64)));
});

test("the payload is lower case, so comparison against the chain is exact", () => {
  // Nodes return calldata lower case; an upper-case root would never match.
  assert.equal(anchorData("AB".repeat(32)), anchorData("ab".repeat(32)));
  assert.equal(anchorData("AB".repeat(32)), anchorData("AB".repeat(32)).toLowerCase());
});
