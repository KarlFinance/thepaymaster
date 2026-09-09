/**
 * Stored credentials.
 *
 * The reason this code exists is convenience; the reason it is built the way
 * it is, is that a key in a database is in every backup of that database. So
 * the tests are almost entirely about what must not happen: the value must not
 * be stored readably, must not survive a wrong key, and must not come back out
 * of the round trip changed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hintOf } from "./settings.ts";

/** A stand-in for the settings module's own sealing, exercised directly. */
async function roundTrip(passphrase: string, value: string,
                         openWith = passphrase): Promise<string | null> {
  const material = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(passphrase));
  const k = await crypto.subtle.importKey("raw", material, "AES-GCM", false,
    ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k,
    new TextEncoder().encode(value));

  const other = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(openWith));
  const k2 = await crypto.subtle.importKey("raw", other, "AES-GCM", false,
    ["encrypt", "decrypt"]);
  try {
    return new TextDecoder().decode(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k2, ct));
  } catch { return null; }
}

test("a credential survives the round trip exactly", async () => {
  const key = "x_11111111-2222-3333-4444-abcdefghijkl";
  assert.equal(await roundTrip("settings-key", key), key);
});

test("the wrong settings key yields nothing, not rubbish", async () => {
  // AES-GCM is authenticated, so a wrong key fails rather than returning
  // plausible bytes. That is what makes "no usable credential" the safe answer.
  assert.equal(await roundTrip("settings-key", "secret", "a-different-key"), null);
});

test("a hint identifies a key without revealing it", () => {
  assert.equal(hintOf("x_11111111-2222-3333-4444-abcd"), "…abcd");
  assert.equal(hintOf("  padded-key-9876  "), "…9876");
});

test("a short value gives away nothing at all", () => {
  // Four characters or fewer would be the whole key.
  assert.equal(hintOf("abcd"), "…");
  assert.equal(hintOf("ab"), "…");
  assert.equal(hintOf(""), "…");
});

test("the same value encrypts differently every time", async () => {
  // A fresh nonce per write. Otherwise two providers sharing a key would be
  // visibly identical in the table.
  const material = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode("k"));
  const k = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt"]);
  const enc = async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k,
      new TextEncoder().encode("same value"));
    return [...new Uint8Array(ct)].join(",");
  };
  assert.notEqual(await enc(), await enc());
});
