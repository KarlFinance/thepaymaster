/**
 * Telling people when something has become theirs to do.
 *
 * The platform ran a whole transaction end to end with five emails in it —
 * the enquiry, the acknowledgement, the sender's link, the invitations, and a
 * way back in. After that, silence. A recipient who finished their KYC had no
 * idea whether anyone had looked at it; staff had no idea a recipient had
 * finished; the sender had no idea everyone was ready. Every one of those is a
 * moment where the next step has just become somebody's, and they should be
 * told so plainly.
 *
 * One rule for every message here: say what has happened, say what is now
 * needed and from whom, and give one link that goes to exactly that. Nothing
 * else. Notification email that says more than that gets skimmed, and then
 * ignored.
 *
 * Every function swallows its own failures. A notification that cannot be
 * sent is logged by send(); it must never turn a completed action into an
 * error page for the person who completed it.
 */

import { type Env, type Actor } from "./db.ts";
import { send, staffEmails } from "./email.ts";
import { format } from "./money.ts";

const CLIENT = "https://client.thepaymaster.co.uk";
const ADMIN = "https://admin.thepaymaster.co.uk";

// ---------------------------------------------------------------------------
// Who and what
// ---------------------------------------------------------------------------

interface Tx { id: string; ref: string; name: string; currency_out: string; decimals_out: number }
interface Person {
  party_id: string; participation_id: string; role: string;
  display_name: string; email: string;
}

async function tx(env: Env, txId: string): Promise<Tx | null> {
  return env.DB.prepare(
    "SELECT id, ref, name, currency_out, decimals_out FROM transactions WHERE id = ?")
    .bind(txId).first<Tx>();
}

async function peopleOn(env: Env, txId: string): Promise<Person[]> {
  const { results } = await env.DB.prepare(
    `SELECT y.id AS party_id, p.id AS participation_id, p.role, y.display_name, y.email
       FROM participations p JOIN parties y ON y.id = p.party_id
      WHERE p.transaction_id = ?`).bind(txId).all<Person>();
  return results ?? [];
}

/** "Marina Vasquez" → "Marina". A greeting by full name reads like a summons. */
const first = (name: string) => (name ?? "").trim().split(/\s+/)[0] || "Hello";

/** Wrapped so a failure never reaches the caller. */
async function quietly(what: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) {
    console.error(`notify: ${what} failed — ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// To staff: something is waiting on us
// ---------------------------------------------------------------------------

/** A party has submitted their identity details. Somebody here must decide. */
export async function staffKycSubmitted(env: Env, actor: Actor, partyId: string): Promise<void> {
  await quietly("kyc submitted", async () => {
    const p = await env.DB.prepare(
      "SELECT display_name, kind FROM parties WHERE id = ?").bind(partyId).first<any>();
    const staff = await staffEmails(env);
    if (!p || !staff.length) return;
    await send(env, actor, {
      to: staff,
      subject: `${p.display_name} has submitted their details — decide`,
      text: [
        `${p.display_name} (${p.kind === "company" ? "a company" : "an individual"})`,
        `has submitted identity details and documents.`,
        ``,
        `Run the check, then record the decision. Until you do, they are shown`,
        `"under review" and can go no further.`,
        ``,
        `${ADMIN}/p/${partyId}`,
      ].join("\n"),
      about: { kind: "parties", id: partyId },
    });
  });
}

/** A recipient has read their address back and confirmed it. Screen and lock. */
export async function staffAddressConfirmed(env: Env, actor: Actor,
                                            destinationId: string): Promise<void> {
  await quietly("address confirmed", async () => {
    const row = await env.DB.prepare(
      `SELECT d.address, d.chain, y.display_name, t.id AS tx_id, t.ref
         FROM destinations d
         JOIN participations p ON p.id = d.participation_id
         JOIN parties y ON y.id = p.party_id
         JOIN transactions t ON t.id = p.transaction_id
        WHERE d.id = ?`).bind(destinationId).first<any>();
    const staff = await staffEmails(env);
    if (!row || !staff.length) return;
    await send(env, actor, {
      to: staff,
      subject: `${row.ref}: ${row.display_name} confirmed their address — screen and lock`,
      text: [
        `${row.display_name} has confirmed where they want paying on ${row.ref}:`,
        ``,
        `  ${row.address}`,
        ``,
        `Screen it, then lock it. Once locked it takes two of us and a call to`,
        `change.`,
        ``,
        `${ADMIN}/t/${row.tx_id}`,
      ].join("\n"),
      about: { kind: "destinations", id: destinationId },
    });
  });
}

/** Every recipient's address is now locked. The gate may be open. */
async function staffAllLocked(env: Env, actor: Actor, txId: string): Promise<void> {
  const t = await tx(env, txId);
  const staff = await staffEmails(env);
  if (!t || !staff.length) return;
  await send(env, actor, {
    to: staff,
    subject: `${t.ref}: every recipient is locked — check the gate`,
    text: [
      `Every recipient on ${t.ref} now has a locked address.`,
      ``,
      `Check the readiness panel. If every line is met, move it to ready and`,
      `the sender will be told they can send.`,
      ``,
      `${ADMIN}/t/${txId}`,
    ].join("\n"),
    about: { kind: "transactions", id: txId },
  });
}

// ---------------------------------------------------------------------------
// To the sender
// ---------------------------------------------------------------------------

/** Their recipients have been invited. Nothing for them to do yet. */
export async function recipientsInvited(env: Env, actor: Actor, txId: string): Promise<void> {
  await quietly("recipients invited", async () => {
    const t = await tx(env, txId);
    const people = await peopleOn(env, txId);
    const sender = people.find((p) => p.role === "sender");
    const recipients = people.filter((p) => p.role === "recipient");
    if (!t || !sender) return;
    await send(env, actor, {
      to: sender.email,
      subject: `${t.ref}: your ${recipients.length === 1 ? "recipient has" : "recipients have"} been invited`,
      text: [
        `${first(sender.display_name)},`,
        ``,
        `We have checked ${t.ref} and invited ${recipients.length === 1
          ? "your recipient" : `your ${recipients.length} recipients`}:`,
        ``,
        ...recipients.map((r) => `  ${r.display_name}`),
        ``,
        `Each will verify themselves and give us the wallet they want paying to.`,
        `We will tell you when everyone is in place and you can send. In the`,
        `meantime, if you have not yet, verify yourself and tell us which wallets`,
        `you will be sending from:`,
        ``,
        `${CLIENT}/d/${txId}`,
      ].join("\n"),
      about: { kind: "transactions", id: txId },
    });
  });
}

/** Moved to ready. The sender can now send. This is the one they are waiting for. */
export async function readyToSend(env: Env, actor: Actor, txId: string): Promise<void> {
  await quietly("ready to send", async () => {
    const t = await tx(env, txId);
    const sender = (await peopleOn(env, txId)).find((p) => p.role === "sender");
    if (!t || !sender) return;
    await send(env, actor, {
      to: sender.email,
      subject: `${t.ref} is ready — you can send`,
      text: [
        `${first(sender.display_name)},`,
        ``,
        `Everyone on ${t.ref} is verified, every address is proved, screened and`,
        `locked, and the amounts add up. It is ready for you to send.`,
        ``,
        `You will see every recipient, their full address and their amount on one`,
        `screen. A test payment of one unit goes to each address first; the real`,
        `payment unlocks once it has landed. Nothing moves unless you send it.`,
        ``,
        `${CLIENT}/d/${txId}/send`,
      ].join("\n"),
      about: { kind: "transactions", id: txId },
    });
  });
}

// ---------------------------------------------------------------------------
// To a recipient
// ---------------------------------------------------------------------------

/** We decided on their identity check. */
export async function kycDecided(env: Env, actor: Actor, partyId: string,
                                 passed: boolean): Promise<void> {
  await quietly("kyc decided", async () => {
    const p = await env.DB.prepare(
      "SELECT display_name, email FROM parties WHERE id = ?").bind(partyId).first<any>();
    if (!p) return;
    const onTx = await env.DB.prepare(
      `SELECT p.transaction_id, p.role, t.ref FROM participations p
         JOIN transactions t ON t.id = p.transaction_id
        WHERE p.party_id = ? ORDER BY p.rowid DESC LIMIT 1`).bind(partyId).first<any>();
    const link = onTx ? `${CLIENT}/d/${onTx.transaction_id}` : CLIENT;

    await send(env, actor, passed ? {
      to: p.email,
      subject: onTx ? `${onTx.ref}: you are verified` : "You are verified",
      text: [
        `${first(p.display_name)},`,
        ``,
        `Your identity check is complete and has passed. Thank you.`,
        ``,
        onTx?.role === "recipient"
          ? `The next step is yours: tell us the wallet you want to be paid to,\nand prove it is yours by signing a short message with it.`
          : `Next, tell us which wallets you will be sending from, and prove each\none by signing a short message with it.`,
        ``,
        link,
      ].join("\n"),
      about: { kind: "parties", id: partyId },
    } : {
      to: p.email,
      subject: onTx ? `${onTx.ref}: we need to speak to you` : "We need to speak to you",
      text: [
        `${first(p.display_name)},`,
        ``,
        `We were not able to complete your identity check from what we have.`,
        `That is usually a document we could not read, or a detail that does not`,
        `match. It is rarely anything more.`,
        ``,
        `Please call us on +44 20 7088 8267 and we will sort it out together.`,
      ].join("\n"),
      about: { kind: "parties", id: partyId },
    });
  });
}

/** Their address is locked. Nothing more from them until they are paid. */
export async function addressLocked(env: Env, actor: Actor,
                                    destinationId: string): Promise<void> {
  await quietly("address locked", async () => {
    const row = await env.DB.prepare(
      `SELECT d.address, y.display_name, y.email, t.id AS tx_id, t.ref
         FROM destinations d
         JOIN participations p ON p.id = d.participation_id
         JOIN parties y ON y.id = p.party_id
         JOIN transactions t ON t.id = p.transaction_id
        WHERE d.id = ?`).bind(destinationId).first<any>();
    if (!row) return;
    await send(env, actor, {
      to: row.email,
      subject: `${row.ref}: your address is locked — nothing more needed`,
      text: [
        `${first(row.display_name)},`,
        ``,
        `We have checked and locked the address you gave us on ${row.ref}:`,
        ``,
        `  ${row.address}`,
        ``,
        `From here it cannot be changed by email — by anyone, for any reason. If`,
        `it is ever wrong, telephone us.`,
        ``,
        `There is nothing more for you to do. You will see a test payment of a`,
        `fraction of a penny arrive first; that is us proving the address works`,
        `before the real amount is sent. We will email you when you are paid.`,
        ``,
        `${CLIENT}/d/${row.tx_id}`,
      ].join("\n"),
      about: { kind: "destinations", id: destinationId },
    });

    // If that was the last one, staff should hear about it too.
    const left = await env.DB.prepare(
      `SELECT count(*) AS n FROM participations p
         LEFT JOIN destinations d ON d.participation_id = p.id
        WHERE p.transaction_id = ? AND p.role = 'recipient'
          AND (d.status IS NULL OR d.status != 'locked')`).bind(row.tx_id).first<any>();
    if (left && Number(left.n) === 0) await staffAllLocked(env, actor, row.tx_id);
  });
}

// ---------------------------------------------------------------------------
// Money has moved
// ---------------------------------------------------------------------------

/** A payment landed. The recipient is told; staff are told; the last one asks for the seal. */
export async function paymentLanded(env: Env, actor: Actor, txId: string, leg: {
  participationId: string | null; name: string; amountMinor: number;
}, txHash: string, explorer: string): Promise<void> {
  await quietly("payment landed", async () => {
    const t = await tx(env, txId);
    if (!t) return;
    const amount = `${format(leg.amountMinor, t.decimals_out ?? 6)} ${t.currency_out ?? ""}`.trim();

    if (leg.participationId) {
      const r = (await peopleOn(env, txId))
        .find((p) => p.participation_id === leg.participationId);
      if (r) {
        await send(env, actor, {
          to: r.email,
          subject: `${t.ref}: you have been paid ${amount}`,
          text: [
            `${first(r.display_name)},`,
            ``,
            `${amount} has been sent to your wallet on ${t.ref} and confirmed on`,
            `the chain.`,
            ``,
            `Transaction: ${explorer}`,
            ``,
            `Your Peaceful Enjoyment dossier is ready on your page: our Counterparty`,
            `Certification for this transaction, your own record with proof it has not`,
            `been altered, and your documents. Keep it — it is how you show, later,`,
            `where these funds came from. It is marked provisional until the whole`,
            `record is sealed, and the same link gives you the final version then.`,
            ``,
            `${CLIENT}/d/${txId}`,
          ].join("\n"),
          about: { kind: "participations", id: leg.participationId },
        });
      }
    }

    // Is that everything? Then the seal is owed.
    const outstanding = await env.DB.prepare(
      `SELECT count(*) AS n FROM participations p
        WHERE p.transaction_id = ? AND p.role = 'recipient'
          AND NOT EXISTS (
            SELECT 1 FROM payout_legs l JOIN custody_events c ON c.id = l.event_id
             WHERE l.participation_id = p.id AND c.event = 'sent')`).bind(txId).first<any>();
    const feePaid = await env.DB.prepare(
      `SELECT 1 FROM custody_events WHERE transaction_id = ? AND event = 'fee_taken' LIMIT 1`)
      .bind(txId).first<any>();
    const allDone = Number(outstanding?.n ?? 1) === 0 && Boolean(feePaid);

    const staff = await staffEmails(env);
    if (staff.length) {
      await send(env, actor, {
        to: staff,
        subject: allDone
          ? `${t.ref}: every payment has landed — seal the dossier`
          : `${t.ref}: ${leg.name} paid ${amount}`,
        text: [
          `${leg.name} has been paid ${amount} on ${t.ref}, confirmed on the chain.`,
          ``,
          allDone
            ? `That was the last one. Every recipient and our fee are paid. Seal the\ndossier, and anchor it if you want the chain's word for the date.`
            : `Other payments are still to come.`,
          ``,
          `${ADMIN}/t/${txId}${allDone ? "/dossier" : ""}`,
        ].join("\n"),
        about: { kind: "transactions", id: txId },
      });
    }
  });
}

/** The record is sealed. Everyone gets their own copy of it. */
export async function sealed(env: Env, actor: Actor, txId: string, root: string): Promise<void> {
  await quietly("sealed", async () => {
    const t = await tx(env, txId);
    if (!t) return;
    for (const p of await peopleOn(env, txId)) {
      await send(env, actor, {
        to: p.email,
        subject: `${t.ref}: your record is complete`,
        text: [
          `${first(p.display_name)},`,
          ``,
          `${t.ref} is finished and its record has been sealed.`,
          ``,
          `Your own page shows everything on file about your part — what was`,
          `agreed, what was paid, and every check — with proof that none of it has`,
          `been altered since. You see your own part and nothing about anyone`,
          `else's.`,
          ``,
          `${CLIENT}/d/${txId}/record`,
          ``,
          `For your files, the seal is ${root.slice(0, 16)}…${root.slice(-8)}. Anyone`,
          `can check your record against it without asking us.`,
        ].join("\n"),
        about: { kind: "participations", id: p.participation_id },
      });
    }
  });
}


// ---------------------------------------------------------------------------
// An address that cannot be signed for
// ---------------------------------------------------------------------------

/** A recipient says they cannot sign from their address. Somebody has to look. */
export async function staffCannotSign(env: Env, actor: Actor, destinationId: string,
                                      note: string): Promise<void> {
  await quietly("cannot sign", async () => {
    const row = await env.DB.prepare(
      `SELECT d.address, y.display_name, t.id AS tx_id, t.ref
         FROM destinations d
         JOIN participations p ON p.id = d.participation_id
         JOIN parties y ON y.id = p.party_id
         JOIN transactions t ON t.id = p.transaction_id
        WHERE d.id = ?`).bind(destinationId).first<any>();
    const staff = await staffEmails(env);
    if (!row || !staff.length) return;
    await send(env, actor, {
      to: staff,
      subject: `${row.ref}: ${row.display_name} cannot sign from their address — review it`,
      text: [
        `${row.display_name} says they cannot sign a message from the address they`,
        `gave on ${row.ref} — usually because it is a deposit address at an exchange:`,
        ``,
        `  ${row.address}`,
        note ? `\nIn their words: "${note}"\n` : ``,
        `Two ways forward. Ask them for a wallet they control and they can move`,
        `the money on themselves; or, if they can show the address belongs to their`,
        `account at a named exchange, accept it on that evidence from the`,
        `transaction page. The record will say which.`,
        ``,
        `${ADMIN}/t/${row.tx_id}`,
      ].join("\n"),
      about: { kind: "destinations", id: destinationId },
    });
  });
}

/** A party is asked to sign their agreement (or sign again after a change). */
export async function agreementRequested(env: Env, actor: Actor, txId: string, partyId: string, again: boolean): Promise<void> {
  await quietly("agreement requested", async () => {
    const t = await tx(env, txId); if (!t) return;
    const p = (await peopleOn(env, txId)).find((x) => x.party_id === partyId);
    if (!p?.email) return;
    const doc = p.role === "sender" ? "Sender's Paymaster Agreement" : "Recipient's Authorisation and Payment Instruction";
    await send(env, actor, {
      to: [p.email],
      subject: `${t.ref}: please ${again ? "sign again — the details changed" : "sign your " + doc}`,
      text: [
        `Hello ${first(p.display_name)},`,
        ``,
        again ? `Something in ${t.ref} changed after you signed your ${doc} — an amount, a recipient or an account. The document has been refreshed from the record and needs your signature again.`
              : `Your ${doc} for ${t.ref} is ready. It is filled in from the transaction record — your details, the amounts, the account you gave — so please read it and sign it in your account.`,
        ``,
        `  ${CLIENT}/d/${t.id}`,
        ``,
        `You sign by typing your name against the document. The words you see are the words that go into the record.`,
      ].join("\n"),
      about: { kind: "transactions", id: txId },
    });
  });
}

/** Manual fiat: the sender says the money has gone. Someone here must look at the account. */
export async function staffSenderSaysSent(env: Env, actor: Actor, txId: string, note: string): Promise<void> {
  await quietly("sender says sent", async () => {
    const t = await tx(env, txId); const staff = await staffEmails(env);
    if (!t || !staff.length) return;
    const s = (await peopleOn(env, txId)).find((p) => p.role === "sender");
    await send(env, actor, {
      to: staff,
      subject: `${t.ref}: ${s?.display_name ?? "the sender"} says the funds have been sent — confirm receipt`,
      text: [
        `${s?.display_name ?? "The sender"} has marked ${t.ref} as paid into the client account.`,
        note ? `\nIn their words: "${note}"\n` : ``,
        `Check the account for the Reference Code ${t.ref}, then record the receipt with the bank advice on the settlement page:`,
        ``,
        `${ADMIN}/t/${t.id}/settle`,
      ].join("\n"),
      about: { kind: "transactions", id: txId },
    });
  });
}

/** Manual fiat: the money is in the client account. Everyone hears. */
export async function fundsReceived(env: Env, actor: Actor, txId: string, amountMinor: number, currency: string, decimals: number): Promise<void> {
  await quietly("funds received", async () => {
    const t = await tx(env, txId); if (!t) return;
    for (const p of await peopleOn(env, txId)) {
      if (!p.email) continue;
      await send(env, actor, {
        to: [p.email],
        subject: `${t.ref}: funds received into the client account`,
        text: [
          `Hello ${first(p.display_name)},`,
          ``,
          p.role === "sender"
            ? `${currency} ${format(amountMinor, decimals)} has arrived in the client account under Reference Code ${t.ref}. We are now paying each recipient; you will see each payment confirmed in your account.`
            : `The sender's funds for ${t.ref} have arrived in ThePaymaster's client account. Your payment follows once every check is complete; you will be asked to confirm when it reaches you.`,
          ``,
          `  ${CLIENT}/d/${t.id}`,
        ].join("\n"),
        about: { kind: "transactions", id: txId },
      });
    }
  });
}

/** Manual fiat: we have paid a recipient; they are asked to confirm it arrived. */
export async function paymentMade(env: Env, actor: Actor, txId: string, participationId: string, amountMinor: number): Promise<void> {
  await quietly("payment made", async () => {
    const t = await tx(env, txId); if (!t) return;
    const r = (await peopleOn(env, txId)).find((p) => p.participation_id === participationId);
    if (!r?.email) return;
    await send(env, actor, {
      to: [r.email],
      subject: `${t.ref}: your payment of ${t.currency_out} ${format(amountMinor, t.decimals_out)} has been made`,
      text: [
        `Hello ${first(r.display_name)},`,
        ``,
        `We have paid ${t.currency_out} ${format(amountMinor, t.decimals_out)} to the account in your signed authorisation, reference ${t.ref}.`,
        `Bank transfers usually land within two hours, sometimes next working day. When it shows on your statement, please confirm it in your account:`,
        ``,
        `  ${CLIENT}/d/${t.id}`,
        ``,
        `Your confirmation goes into the record alongside our evidence of the payment.`,
      ].join("\n"),
      about: { kind: "participations", id: participationId },
    });
  });
}

/** Manual fiat: a recipient confirmed the money arrived. */
export async function staffRecipientConfirmed(env: Env, actor: Actor, txId: string, participationId: string): Promise<void> {
  await quietly("recipient confirmed", async () => {
    const t = await tx(env, txId); const staff = await staffEmails(env);
    if (!t || !staff.length) return;
    const r = (await peopleOn(env, txId)).find((p) => p.participation_id === participationId);
    await send(env, actor, {
      to: staff,
      subject: `${t.ref}: ${r?.display_name ?? "a recipient"} confirms receipt`,
      text: [`${r?.display_name ?? "A recipient"} has confirmed their payment on ${t.ref} arrived.`, ``, `${ADMIN}/t/${t.id}`].join("\n"),
      about: { kind: "participations", id: participationId },
    });
  });
}

/** The penny has gone; the recipient is told what to look for. */
export async function pennySent(env: Env, actor: Actor, destinationId: string): Promise<void> {
  await quietly("penny sent", async () => {
    const row = await env.DB.prepare(
      `SELECT d.penny_code, y.display_name, y.email, t.id AS tx_id, t.ref
         FROM destinations d
         JOIN participations p ON p.id = d.participation_id
         JOIN parties y ON y.id = p.party_id
         JOIN transactions t ON t.id = p.transaction_id
        WHERE d.id = ?`).bind(destinationId).first<any>();
    if (!row?.email) return;
    await send(env, actor, {
      to: [row.email],
      subject: `${row.ref}: we have sent a penny to your account`,
      text: [
        `Hello ${row.display_name},`,
        ``,
        `To prove the bank account you gave us is yours, we have sent it 0.01 from`,
        `ThePaymaster's client account. It usually lands within two hours.`,
        ``,
        `On your statement the payment carries a reference beginning "TPM PENNY"`,
        `followed by six characters. Type those six characters into your account:`,
        ``,
        `  ${CLIENT}/d/${row.tx_id}`,
        ``,
        `The code is never in this email — it is on your statement, which is the point.`,
      ].join("\n"),
      about: { kind: "destinations", id: destinationId },
    });
  });
}

/** Staff accepted the address on evidence. The recipient hears the step is done. */
export async function addressAttested(env: Env, actor: Actor, attestationId: string): Promise<void> {
  await quietly("address attested", async () => {
    const row = await env.DB.prepare(
      `SELECT a.address, a.custodian, y.display_name, y.email, t.id AS tx_id, t.ref
         FROM address_attestations a
         JOIN destinations d ON d.id = a.destination_id
         JOIN participations p ON p.id = d.participation_id
         JOIN parties y ON y.id = p.party_id
         JOIN transactions t ON t.id = p.transaction_id
        WHERE a.id = ?`).bind(attestationId).first<any>();
    if (!row) return;
    await send(env, actor, {
      to: row.email,
      subject: `${row.ref}: your ${row.custodian} address is accepted`,
      text: [
        `${first(row.display_name)},`,
        ``,
        `We have accepted the address you gave us on ${row.ref} as your deposit`,
        `address at ${row.custodian}, on the evidence you sent:`,
        ``,
        `  ${row.address}`,
        ``,
        `You do not need to sign anything. The record will say the address was`,
        `accepted on evidence rather than by signature; that is normal for an`,
        `exchange account. We will screen and lock it next, and you will see a test`,
        `payment of a fraction of a penny before the real amount.`,
        ``,
        `${CLIENT}/d/${row.tx_id}`,
      ].join("\n"),
      about: { kind: "address_attestations", id: attestationId },
    });
  });
}


// ---------------------------------------------------------------------------
// The data room
// ---------------------------------------------------------------------------

/** The viewer is sent their link. */
export async function roomShared(env: Env, actor: Actor, inviteId: string, url: string): Promise<void> {
  await quietly("room shared", async () => {
    const row = await env.DB.prepare(
      `SELECT i.viewer_name, i.viewer_email, i.expires_at, i.include_documents, i.created_by_kind,
              y.legal_name, y.display_name, t.ref
         FROM room_invites i JOIN parties y ON y.id = i.party_id JOIN transactions t ON t.id = i.transaction_id
        WHERE i.id = ?`).bind(inviteId).first<any>();
    if (!row?.viewer_email) return;
    const who = row.legal_name || row.display_name;
    await send(env, actor, {
      to: row.viewer_email,
      subject: `${who} has shared their ThePaymaster dossier with you`,
      text: [
        `${row.viewer_name.split(",")[0]},`,
        ``,
        `${row.created_by_kind === "party" ? who : `ThePaymaster, on behalf of ${who},`} has given you access to`,
        `their Peaceful Enjoyment dossier for transaction ${row.ref}: ThePaymaster's`,
        `Counterparty Certification, their record with cryptographic proofs${row.include_documents ? ", and" : ""}`,
        row.include_documents ? `the documents on file.` : `.`,
        ``,
        `${url}`,
        ``,
        `The link is for you alone and works until ${String(row.expires_at).slice(0, 10)}. Each page you`,
        `open is watermarked with your name and the time. To check any of it without`,
        `relying on us, paste the record.json at https://client.thepaymaster.co.uk/verify-record.`,
        ``,
        `ThePaymaster Ltd, 167-169 The Fifth Floor, Great Portland Street, London W1W 5PF`,
        `info@thepaymaster.co.uk · +44 20 7088 8267`,
      ].join("\n"),
      about: { kind: "room_invites", id: inviteId },
    });
  });
}

/** The party is told the first time their room is opened. */
export async function roomOpened(env: Env, actor: Actor, inviteId: string): Promise<void> {
  await quietly("room opened", async () => {
    const row = await env.DB.prepare(
      `SELECT i.viewer_name, y.display_name, y.email, t.id AS tx_id, t.ref
         FROM room_invites i JOIN parties y ON y.id = i.party_id JOIN transactions t ON t.id = i.transaction_id
        WHERE i.id = ?`).bind(inviteId).first<any>();
    if (!row) return;
    await send(env, actor, {
      to: row.email,
      subject: `${row.ref}: ${row.viewer_name} has opened your dossier`,
      text: [
        `${first(row.display_name)},`,
        ``,
        `The data-room link you made for ${row.viewer_name} on ${row.ref} has just been`,
        `opened for the first time. Every opening is recorded against the link, and`,
        `you can revoke it from your page at any time.`,
        ``,
        `${CLIENT}/d/${row.tx_id}`,
      ].join("\n"),
      about: { kind: "room_invites", id: inviteId },
    });
  });
}

// ---------------------------------------------------------------------------
// The return loop
// ---------------------------------------------------------------------------

/** A finished distribution has been cloned; staff set the amount and release it. */
export async function staffCloned(env: Env, actor: Actor, txId: string, fromRef: string,
                                  by: "party" | "admin"): Promise<void> {
  await quietly("cloned", async () => {
    const t = await tx(env, txId);
    const staff = await staffEmails(env);
    if (!t || !staff.length) return;
    const sender = (await peopleOn(env, txId)).find((p) => p.role === "sender");
    await send(env, actor, {
      to: staff,
      subject: `${t.ref}: ${fromRef} is to run again${by === "party" ? ` — asked for by ${sender?.display_name ?? "the sender"}` : ""}`,
      text: [
        `${by === "party" ? `${sender?.display_name ?? "The sender"} has asked to run ${fromRef} again.` : `${fromRef} has been cloned.`}`,
        `The new transaction is ${t.ref}: same recipients and shares, addresses and`,
        `proofs carried over, chain settings carried over. Still to do before release:`,
        ``,
        `  - set the amount (the split panel)`,
        `  - screen the addresses again and lock them (they arrive confirmed, not locked)`,
        `  - release, which invites everyone to their pages`,
        ``,
        `${ADMIN}/t/${txId}`,
      ].join("\n"),
      about: { kind: "transactions", id: txId },
    });
  });
}

/** A recipient has started a distribution of their own. */
export async function staffStartedOwn(env: Env, actor: Actor, txId: string, who: string): Promise<void> {
  await quietly("started own", async () => {
    const t = await tx(env, txId);
    const staff = await staffEmails(env);
    if (!t || !staff.length) return;
    await send(env, actor, {
      to: staff,
      subject: `${t.ref}: ${who} is starting a distribution of their own`,
      text: [
        `${who} — a verified party on an earlier transaction — has started ${t.ref} from`,
        `their own account and is filling in the recipients now. It will arrive for`,
        `release like any other draft; their identity clearance carries over.`,
        ``,
        `${ADMIN}/t/${txId}`,
      ].join("\n"),
      about: { kind: "transactions", id: txId },
    });
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Somebody has been invited to act for an organisation; the link is their login. */
export async function teamInvited(env: Env, actor: Actor, memberRowId: string, url: string,
                                  invitedByName: string): Promise<void> {
  await quietly("team invited", async () => {
    const row = await env.DB.prepare(
      `SELECT m.role, y.email, y.display_name, o.display_name AS org
         FROM party_members m JOIN parties y ON y.id = m.member_party_id JOIN parties o ON o.id = m.party_id
        WHERE m.id = ?`).bind(memberRowId).first<any>();
    if (!row) return;
    const what: Record<string, string> = {
      owner: "manage the team and do everything an approver can",
      approver: "approve and send payments — once you have verified your own identity",
      preparer: "enter recipients, details and wallets (sending is left to an approver)",
      viewer: "read the transactions and download the records",
    };
    await send(env, actor, {
      to: row.email,
      subject: `${invitedByName} has added you to ${row.org} on ThePaymaster`,
      text: [
        `${first(row.display_name)},`,
        ``,
        `${invitedByName} has added you to ${row.org}'s account on ThePaymaster as`,
        `${row.role}, which means you can ${what[row.role] ?? "take part"}.`,
        ``,
        `This link signs you in. It works once; afterwards, ask for a link back in`,
        `from the sign-in page with this email address.`,
        ``,
        `${url}`,
        ``,
        `Everything you do is recorded under your own name, with ${row.org} named.`,
      ].join("\n"),
      about: { kind: "party_members", id: memberRowId },
    });
  });
}
