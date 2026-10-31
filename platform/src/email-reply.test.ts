import { test } from "node:test";
import assert from "node:assert/strict";
import { send } from "./email.ts";

test("a personal reply goes from the sender's name, copied and answered to their own mailbox", async () => {
  let sent: any = null;
  globalThis.fetch = (async (_url: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ id: "em_1" }), { status: 200 }); }) as any;
  const db = { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) };
  const env: any = { RESEND_API_KEY: "k", EMAIL_BCC: "centrevine@gmail.com,rl@thepaymaster.co.uk", DB: db };
  const ok = await send(env, { kind: "admin", id: "adm_1" }, {
    to: "client@example.com", cc: ["rl@thepaymaster.co.uk"], replyTo: "rl@thepaymaster.co.uk",
    fromName: "Ray Lovell | ThePaymaster", fromLocal: "rl", subject: "Your enquiry to ThePaymaster", text: "Dear Ann,",
  });
  assert.equal(ok, true);
  assert.equal(sent.from, "Ray Lovell | ThePaymaster <rl@send.thepaymaster.co.uk>");
  assert.deepEqual(sent.to, ["client@example.com"]);
  assert.deepEqual(sent.cc, ["rl@thepaymaster.co.uk"]);
  assert.equal(sent.reply_to, "rl@thepaymaster.co.uk");
  assert.deepEqual(sent.bcc, ["centrevine@gmail.com"], "the safety copy, but not a second copy to the person already on cc");
});

test("platform emails are unchanged", async () => {
  let sent: any = null;
  globalThis.fetch = (async (_url: string, init: any) => { sent = JSON.parse(init.body); return new Response("{}", { status: 200 }); }) as any;
  const db = { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) };
  await send({ RESEND_API_KEY: "k", DB: db } as any, { kind: "system", id: null }, { to: "x@example.com", subject: "s", text: "t" });
  assert.equal(sent.from, "ThePaymaster <notifications@send.thepaymaster.co.uk>");
  assert.equal(sent.cc, undefined);
});
