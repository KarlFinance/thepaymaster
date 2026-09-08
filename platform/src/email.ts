/**
 * Outbound email, through Resend.
 *
 * Two rules here, both of which exist because of what this system is for.
 *
 * Every send is written to the audit log — recipient, subject, and the
 * provider's message id. "We told them, and here is when" is part of the
 * dossier, and a notification nobody can prove was sent is worth very little
 * when a transaction is questioned two years later.
 *
 * And a failed send never fails the request that triggered it. If Resend is
 * down, an enquiry still saves and an invite is still recorded as pending; the
 * failure is logged and can be retried. Losing a client's enquiry because a
 * third party had a bad afternoon is not a trade worth making.
 */

import { type Env, type Actor, log } from "./db.ts";

const ENDPOINT = "https://api.resend.com/emails";

/**
 * Sending happens on a subdomain, deliberately.
 *
 * The apex SPF record already chains through PrivateEmail, HubSpot and
 * sendersrv for seven of the ten DNS lookups SPF allows before it hard-fails.
 * Putting transactional mail on its own subdomain leaves that record alone,
 * and keeps this reputation separate from everyday mail.
 */
export const FROM = "ThePaymaster <notifications@send.thepaymaster.co.uk>";
export const REPLY_TO = "info@thepaymaster.co.uk";

export interface Mail {
  to: string | string[];
  subject: string;
  /** Plain text. Everything here reads fine without markup. */
  text: string;
  replyTo?: string;
  /** What this send is about, for the log and for the dossier. */
  about?: { kind: string; id: string };
}

export async function send(env: Env, actor: Actor, mail: Mail): Promise<boolean> {
  const to = Array.isArray(mail.to) ? mail.to : [mail.to];

  if (!env.RESEND_API_KEY) {
    await log(env.DB, actor, "email.skipped", mail.about?.kind ?? "email",
      mail.about?.id ?? to[0], { note: `no API key configured — "${mail.subject}"` });
    return false;
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM, to, subject: mail.subject, text: mail.text,
        reply_to: mail.replyTo ?? REPLY_TO,
      }),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      await log(env.DB, actor, "email.failed", mail.about?.kind ?? "email",
        mail.about?.id ?? to[0],
        { note: `${res.status} sending "${mail.subject}" to ${to.join(", ")}: ${detail}` });
      return false;
    }

    const body = await res.json<{ id?: string }>();
    await log(env.DB, actor, "email.sent", mail.about?.kind ?? "email",
      mail.about?.id ?? to[0],
      { note: `"${mail.subject}" to ${to.join(", ")}`, after: { message_id: body.id } });
    return true;
  } catch (err) {
    await log(env.DB, actor, "email.failed", mail.about?.kind ?? "email",
      mail.about?.id ?? to[0],
      { note: `${(err as Error).message} sending "${mail.subject}"` });
    return false;
  }
}

/** Everyone who should hear about a new enquiry. */
export async function staffEmails(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT email FROM admins WHERE active = 1").all<{ email: string }>();
  return (results ?? []).map((r) => r.email);
}

// ---------------------------------------------------------------------------
// What we actually send
// ---------------------------------------------------------------------------

export function enquiryLanded(e: {
  id: string; name: string; email: string; phone?: string | null;
  whatsapp_ok?: number; contact_pref?: string | null;
  amount?: string | null; expected_on?: string | null;
  likelihood?: string | null; detail?: string | null;
}, adminUrl: string): { subject: string; text: string } {
  const lines = [
    `${e.name} has sent an enquiry.`,
    "",
    `Email:      ${e.email}`,
    e.phone ? `Phone:      ${e.phone}${e.whatsapp_ok ? " (WhatsApp ok)" : ""}` : null,
    e.contact_pref ? `Wants:      ${e.contact_pref}` : null,
    e.amount ? `Amount:     ${e.amount}` : null,
    e.expected_on ? `Expected:   ${e.expected_on}` : null,
    e.likelihood ? `Likelihood: ${e.likelihood}` : null,
    "",
    "What they said:",
    e.detail ? e.detail : "(nothing)",
    "",
    `Open it: ${adminUrl}/e/${e.id}`,
  ].filter((l) => l !== null);

  return {
    subject: `Enquiry from ${e.name}${e.amount ? ` — ${e.amount}` : ""}`,
    text: lines.join("\n"),
  };
}

/** Sent to the client, so they know a person will follow. */
export function enquiryAcknowledged(name: string): { subject: string; text: string } {
  return {
    subject: "We have your enquiry — ThePaymaster",
    text: [
      `${name},`,
      "",
      "Thank you — we have your enquiry and one of us will come back to you",
      "shortly to arrange a short call before anything else happens.",
      "",
      "If it is urgent, call +44 20 7088 8267.",
      "",
      "ThePaymaster Ltd",
      "85 Great Portland Street, First Floor, London W1W 7LT",
    ].join("\n"),
  };
}

/** Sent to a sender so they can set their own transaction up. */
export function startLink(ref: string, url: string): { subject: string; text: string } {
  return {
    subject: `Set up your transaction — ${ref}`,
    text: [
      "We are ready to set up your transaction.",
      "",
      "Use the link below to tell us who is involved. It takes a couple of",
      "minutes, and nothing is sent to anyone else until we have checked it.",
      "",
      url,
      "",
      "The link is for you alone and stops working once it has been used.",
      "",
      `Reference ${ref}`,
      "ThePaymaster Ltd · +44 20 7088 8267",
    ].join("\n"),
  };
}

/** Sent to every party once we release a transaction. */
export function invite(opts: {
  ref: string; name: string; role: string; senderName: string; url: string;
}): { subject: string; text: string } {
  const part = opts.role === "recipient"
    ? `You are down to receive part of this distribution.`
    : opts.role === "sender"
      ? `You are the sender on this transaction.`
      : `You have been added to this transaction as ${opts.role}.`;
  return {
    subject: `${opts.ref} — ${opts.name}`,
    text: [
      `${opts.senderName} is using ThePaymaster to handle a distribution, and`,
      "you are part of it.",
      "",
      part,
      "",
      "Open your account here. We will verify who you are and then ask you for",
      "the details we need from you — never by email, and never over the phone.",
      "",
      opts.url,
      "",
      "The link is for you alone and stops working once it has been used.",
      "",
      `Reference ${opts.ref}`,
      "ThePaymaster Ltd · +44 20 7088 8267",
      "",
      "We will never email you asking to change payment details. If you receive",
      "anything of the sort, it is not from us — call us on the number above.",
    ].join("\n"),
  };
}
