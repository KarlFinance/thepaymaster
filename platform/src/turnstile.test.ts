import { test } from "node:test";
import assert from "node:assert/strict";
import { human } from "./turnstile.ts";

// Cloudflare's answer is simulated; what is under test is what we accept.
const env = (o: Record<string, string | undefined> = {}) => ({
  TURNSTILE_SECRET: "secret", TURNSTILE_HOSTNAMES: "thepaymaster.co.uk,client.thepaymaster.co.uk", ...o,
}) as any;
const req = new Request("https://client.thepaymaster.co.uk/site-form/contact-us", { method: "POST" });
const form = (token?: string) => { const f = new FormData(); if (token !== undefined) f.set("cf-turnstile-response", token); return f; };
function answer(body: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as any;
}
const good = { success: true, hostname: "thepaymaster.co.uk", action: "contact-us" };

test("a real pass on our site, for this form, is accepted", async () => {
  answer(good);
  assert.equal(await human(env(), req, form("tok"), "contact-us"), true);
});

test("everything else is refused", async () => {
  answer(good);
  assert.equal(await human(env(), req, form(), "contact-us"), false, "no token");
  assert.equal(await human(env(), req, form(""), "contact-us"), false, "empty token");
  assert.equal(await human(env(), req, form("x".repeat(2049)), "contact-us"), false, "oversized token");
  assert.equal(await human(env({ TURNSTILE_SECRET: undefined }), req, form("tok"), "contact-us"), false, "no secret");
  assert.equal(await human(env({ TURNSTILE_HOSTNAMES: "" }), req, form("tok"), "contact-us"), false, "no hostnames");
  assert.equal(await human(env(), req, form("tok"), "distribute"), false, "token from another form");
  answer({ ...good, success: false, "error-codes": ["invalid-input-response"] });
  assert.equal(await human(env(), req, form("tok"), "contact-us"), false, "Cloudflare says no");
  answer({ ...good, hostname: "evil.example" });
  assert.equal(await human(env(), req, form("tok"), "contact-us"), false, "another website");
  answer({ ...good, action: undefined });
  assert.equal(await human(env(), req, form("tok"), "contact-us"), false, "no action from a real key");
  answer({}, 500);
  assert.equal(await human(env(), req, form("tok"), "contact-us"), false, "Cloudflare error");
  globalThis.fetch = (async () => { throw new Error("offline"); }) as any;
  assert.equal(await human(env(), req, form("tok"), "contact-us"), false, "Cloudflare unreachable");
});

test("Cloudflare's test keys pass locally without an action, and only there", async () => {
  answer({ success: true, hostname: "example.com", metadata: { result_with_testing_key: true } });
  assert.equal(await human(env({ TURNSTILE_HOSTNAMES: "example.com" }), req, form("tok"), "contact-us"), true);
  assert.equal(await human(env(), req, form("tok"), "contact-us"), false, "example.com is not a production hostname");
});
