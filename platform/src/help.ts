/**
 * Help, in two voices.
 *
 * The client help is for somebody who has been sent a link and has never seen
 * a wallet proof or a dossier before. The admin help is for staff who have,
 * and want to know what a line on the readiness gate means and what to do when
 * it is not ticked. Both are one page each: a person looking for help is
 * already stuck, and a maze of pages is the last thing they need.
 *
 * `tip()` is the small "?" next to a label that opens the explanation in
 * place. It is a <details> element rather than a hover title so it works on a
 * phone, where nothing hovers.
 */

import { esc } from "./views.ts";

// ---------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------

/** A "?" that opens `text` in place. Keyboard- and touch-friendly. */
export function tip(text: string, label = "What does this mean?"): string {
  return `<details class="tip"><summary aria-label="${esc(label)}">?</summary>
    <div class="tipbody">${esc(text)}</div></details>`;
}

/** What each readiness line is asking for, and what to do when it is not met. */
export const GATE_TIPS: Record<string, string> = {
  sender: "One party on the transaction has the role of sender. Without one there is nobody to send the money. Add them from the roster, or send a start link and they will name themselves.",
  recipients: "At least one person or company receives money. The sender names them; you release the invitations.",
  split: "Every recipient's share, plus our fee, must account for exactly the whole amount — not a penny more or less. Fix it in the Split panel.",
  verified: "Every party has sent their documents and a member of staff has recorded a Pass with a ceiling and an expiry. Refused or expired clearances count as unverified.",
  proved: "Each recipient has signed a message from the wallet they gave us, proving they hold its key. An exchange deposit address cannot sign; staff may instead accept it on evidence that it belongs to the recipient's account at a named exchange, with the evidence attached — and the dossier says so in those words.",
  locked: "A recipient's details were entered, then confirmed by them, then locked by staff. Only a locked destination can be paid. Changing a locked one is a separate, logged request.",
  senderwallets: "The sender has proved control of the wallet they will send from, so the payment provably comes from the person we verified.",
  fee: "The transaction names the wallet our fee goes to. It is set per transaction, in Chain settings, so an address nobody reviews never ends up in code.",
  frozen: "Tether can freeze an address. We check every address against the token contract's blacklist before allowing a send.",
  balance: "The sender's proved wallet holds at least the amount being distributed. Read live from the chain each time the page is opened.",
  screened: "Every address has been through wallet screening within the last seven days and none came back sanctioned or high risk.",
  contracts: "An address that is a smart contract — a Safe, an exchange, a router — has been looked at by a person and marked acceptable.",
  agency: "The dossier records which side we act for. It matters for the wording of the agency agreement and it is asked once, here.",
};

/** Match a readiness check to its tip by the words in its label. */
export function gateTip(label: string): string {
  const l = label.toLowerCase();
  const key = l.includes("sender is named") ? "sender"
    : l.includes("recipient") && l.includes("least") ? "recipients"
    : l.includes("adds up") ? "split"
    : l.includes("verified") ? "verified"
    : l.includes("proved their wallet") ? "proved"
    : l.includes("locked") ? "locked"
    : l.includes("sender's wallets") ? "senderwallets"
    : l.includes("fee") ? "fee"
    : l.includes("frozen") ? "frozen"
    : l.includes("holds enough") ? "balance"
    : l.includes("screened") ? "screened"
    : l.includes("contract") ? "contracts"
    : l.includes("act for") ? "agency" : "";
  return key ? tip(GATE_TIPS[key]) : "";
}

export const HELP_CSS = `
.tip{display:inline-block;position:relative;vertical-align:middle;margin-left:6px}
.tip summary{list-style:none;cursor:pointer;width:18px;height:18px;border-radius:50%;
  border:1.5px solid #8C99AC;color:#5A6B80;font:700 11px/15px "Plus Jakarta Sans",sans-serif;
  text-align:center;display:inline-block;user-select:none}
.tip summary::-webkit-details-marker{display:none}
.tip summary:hover,.tip[open] summary{border-color:var(--accent,#F26A21);color:var(--accent,#F26A21)}
.tipbody{position:absolute;z-index:20;left:0;top:24px;width:300px;max-width:80vw;background:#1B2430;color:#E6EAF0;
  font-size:13px;line-height:1.5;font-weight:400;text-transform:none;letter-spacing:0;padding:10px 13px;border-radius:8px;
  box-shadow:0 8px 24px rgba(0,0,0,.25)}
.help h1{margin-bottom:6px}
.help .lead{color:#5A6B80;font-size:16px;margin:0 0 24px;max-width:66ch}
.help h2{text-transform:none;letter-spacing:0;font-size:20px;margin:34px 0 8px;font-weight:800}
.help h3{font-size:15px;margin:18px 0 4px}
.help p,.help li{max-width:70ch}
.help details.q{border-top:1px solid #E6EAF0;padding:10px 0}
.help details.q summary{cursor:pointer;font-weight:700;color:var(--ink,#1B2430);list-style:none;display:flex;gap:10px}
.help details.q summary::-webkit-details-marker{display:none}
.help details.q summary::before{content:"+";color:var(--accent,#F26A21);font-weight:800;width:14px}
.help details.q[open] summary::before{content:"\\2013"}
.help details.q .a{padding:6px 0 4px 24px}
.help .toc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}
.help .toc a{font-size:13px;font-weight:600;text-decoration:none;background:#F1F4F8;padding:6px 11px;border-radius:999px;color:var(--ink,#1B2430)}
.help .toc a:hover{background:#E6EAF0}
.help .steps{counter-reset:s;list-style:none;padding:0;margin:0}
.help .steps li{counter-increment:s;position:relative;padding:0 0 14px 40px}
.help .steps li::before{content:counter(s);position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;
  background:var(--ink,#1B2430);color:#fff;font-weight:800;font-size:13px;text-align:center;line-height:26px}
.help .steps b{display:block;margin-bottom:2px}
.help .note{background:#FFF7F2;border-left:3px solid var(--accent,#F26A21);padding:10px 14px;border-radius:0 8px 8px 0;margin:14px 0;max-width:70ch}
`;

const q = (question: string, answer: string) =>
  `<details class="q"><summary>${question}</summary><div class="a">${answer}</div></details>`;

// ---------------------------------------------------------------------------
// The client's help page
// ---------------------------------------------------------------------------

export function clientHelp(): string {
  return `<div class="help">
  <h1>Help</h1>
  <p class="lead">Everything on your page is one of a handful of steps. This explains each one,
    what we are asking for and why, and what to do when something does not work.</p>

  <nav class="toc">
    <a href="#steps">The steps</a><a href="#verify">Verifying yourself</a>
    <a href="#wallet">Wallets and proving one</a><a href="#send">Sending</a>
    <a href="#record">Your record</a><a href="#trouble">When something goes wrong</a>
    <a href="#contact">Contact us</a>
  </nav>

  <h2 id="steps">The steps, in order</h2>
  <p>Your page shows a strip of steps across the top. A green tick means the step is done;
    the orange one is the step that needs you now; a grey circle is not yet open. If a step
    shows a small clock, you are waiting on us or on somebody else, and there is nothing to do.
    We email you the moment a step opens.</p>
  <ol class="steps">
    <li><b>Verify yourself</b> Tell us who you are and send us the documents. Every person on
      the transaction does this, on both sides, once.</li>
    <li><b>Give your details</b> Recipients: the wallet, or bank account, the money should go
      to. Senders: the wallet you will send from.</li>
    <li><b>Prove your wallet</b> Sign a short message from the wallet, so we know the address
      really is yours. It costs nothing and moves nothing.</li>
    <li><b>Locked</b> We confirm your details with you and lock them. From this point nobody,
      including us, can quietly change where the money goes.</li>
    <li><b>Send, or be paid</b> The sender presses Send in their own wallet. Recipients see
      the payment land, with the transaction hash to check on any block explorer.</li>
    <li><b>Your record</b> Once everything has landed we seal the record and you can keep
      your own copy — proof of what was agreed, who was checked, and what was paid.</li>
  </ol>

  <h2 id="verify">Verifying yourself</h2>
  ${q("Why do you need my passport and a proof of address?",
      "Because we are checking every person the money goes to or comes from, and saying so in the record. That is what makes the record worth having: a recipient can show their bank exactly who paid them and that the payer was checked.")}
  ${q("What happens to my documents?",
      "They are stored encrypted, a fingerprint (SHA-256) of each file is taken as it arrives, and only staff at ThePaymaster can open them. Other parties on the transaction never see them. They form part of the sealed record, but the record other parties receive shows only their own details.")}
  ${q("It says I am waiting to be verified. How long does it take?",
      "Usually the same working day. You will get an email when we have decided. If it has been more than a day, contact us.")}
  ${q("I am a company. Who has to verify?",
      "The company itself — registered name and number — and each director and each owner of 25% or more. Each of them gets their own link.")}

  <h2 id="wallet">Wallets and proving one</h2>
  ${q("Which wallets can I use?",
      "Any wallet whose key you hold and can sign from. For USDT on Ethereum: MetaMask, Ledger, Trezor, Rabby, Coinbase Wallet, Trust Wallet, a Gnosis Safe and most others. For Bitcoin: Unisat, OKX, Xverse, Leather, Sparrow, Electrum, Ledger and Trezor. The address has to be on the right network — Ethereum mainnet or Bitcoin mainnet for a real transaction; your page says which.")}
  ${q("Can I use my exchange deposit address (Binance, Coinbase, Kraken…)?",
      "You cannot sign a message from it — the exchange holds the key, not you — so the simplest route is a wallet you control, moving the money on to the exchange afterwards. If that is not possible, use 'I cannot sign from this address' under the proof step and tell us. We can accept an exchange deposit address on evidence that it is yours — usually a screenshot of the exchange's deposit page showing your name and the address — and the record will state it was accepted that way rather than by signature. A test payment of one unit still goes first.")}
  ${q("What does 'prove your wallet' actually do?",
      "Your wallet signs a short message that includes your name, our reference and a one-time code. Signing is free, sends nothing and gives us no access to your funds; it just shows the address is yours. We check the signature on our side.")}
  ${q("The Sign button does nothing.",
      "Your browser needs a wallet extension (MetaMask or similar) unlocked and on the account you gave us. If the wallet is in another browser or on a phone, use Copy the message, sign it there, and paste the signature into the box below.")}
  ${q("It says the connected account does not match.",
      "The wallet extension is on a different account from the one you gave us. Switch account in the extension and try again, or correct the address on your page if you gave us the wrong one.")}
  ${q("I gave the wrong address.",
      "Use Something is wrong under your details. Until your details are locked you can correct them yourself; a corrected address has to be proved again. After lock, a change is a request to us and is recorded.")}

  <h2 id="send">Sending (for senders)</h2>
  ${q("When can I send?",
      "When every recipient is verified, has proved their wallet and is locked, and we have released the transaction. You will get an email saying so; before then the Send page tells you what is still outstanding.")}
  ${q("What is the test payment?",
      "Before a real payment to any address we send a single smallest unit of the token — a dust payment — to that address and confirm it arrived. It costs a fraction of a penny and catches a wrong address before it costs anything real. Each real send button unlocks after its test.")}
  ${q("Who moves the money?",
      "You do, from your own wallet. Nothing passes through us. The Send page prepares each payment for your wallet to sign, waits for it to be mined and records the hash.")}
  ${q("I sent from a Safe, a hardware wallet or another app and the page did not see it.",
      "Use Sent it another way? on the Send page and paste the transaction hash. We verify it against the chain — the token, the amount and the recipient all have to match.")}

  <h2 id="record">Your record</h2>
  ${q("What is the record, and why would I want it?",
      "A sealed statement of the transaction: who was involved, that each was checked, what was agreed and what was paid, each fact fingerprinted and the whole thing rolled into one hash that can be verified without trusting us. Recipients see their own details and the sender's; not other recipients'. Banks and accountants ask for exactly this.")}
  ${q("What is the certificate in my wallet?",
      "Once a transaction's record is sealed, ThePaymaster can mint a soulbound token to the address you proved — a certificate that lives on the Base blockchain for as long as the chain does. Its id is derived from the sealed record root; it carries no name and no amount. It cannot be transferred or sold. Anyone who sees it can check the record at the verifier. It is a badge, not the proof — the proof is the signed record in your dossier.")}
  ${q("Is there a statement for my accountant?",
      "Yes. Annual statements on your account page: one PDF per calendar year with every payment you sent or received through ThePaymaster — date, transaction, counterparty, amount, the chain transaction, and the sealed record it belongs to — with totals per asset and our signature. A JSON copy carries the same lines and can be checked at the verifier. Members of a company account see the company's statements too.")}
  ${q("Can my colleagues use our company's account?",
      "Yes. A company account has a team: from Your team on the account page, invite a colleague by name and email and give them a role — approver (sends and signs; must verify their own identity first), preparer (enters recipients, details and wallets but cannot send), viewer (reads and downloads only) or owner (manages the team as well). They get their own login. The transactions they can see are labelled with the company's name, and everything they do is recorded under their own name with the company named. Remove anyone at any time; the record keeps who could act when.")}
  ${q("Can I run the same distribution again?",
      "Yes — on a finished distribution's page, Set up the same distribution again. The new one has the same recipients and shares, their addresses and proofs carried over and the same chain settings. We set the amount with you, screen the addresses again (screening is only good for a week), lock them and release. Your recipients are not asked for anything they have already given.")}
  ${q("Can I start a distribution of my own?",
      "Once you are verified, yes: Start a new distribution on your account page opens the sender's form — recipients' names, emails and amounts. Your identity clearance carries over. Everyone you have paid before is listed under Everyone you have paid, with whether each is still cleared.")}
  ${q("How do I show my dossier to my bank?",
      "Share it with your bank on your page: give the name of the person (and their organisation), optionally their email, choose how long the link should work, and whether to include your documents as well as the certification and record. They get a private data room — every page watermarked with their name and the time — and you are emailed the first time they open it. Revoke the link whenever you like. It saves emailing PDFs about, and the bank can verify everything they see without contacting anyone.")}
  ${q("How does a bank check my dossier is genuine?",
      "Without asking us. Anyone can go to client.thepaymaster.co.uk/verify-record and paste the record.json from your dossier, or type the reference printed on your Counterparty Certification. Every entry is recomputed from its own contents and matched to the sealed root, and the page says when ThePaymaster sealed that root and where it is published on Ethereum. Nothing pasted is stored, and nothing is revealed beyond what they already hold.")}
  ${q("Where is my copy?",
      "Your Peaceful Enjoyment dossier, on your page, from the moment you are verified: Download my dossier gives you a ZIP with our Counterparty Certification (who you are and that we verified you, what was paid to which address by whom, the chain transaction, the record's root and seal, and what ThePaymaster certifies about every party), your own record with the proofs that tie each entry to the sealed whole, and your documents. It is marked provisional until the payment has landed and the record is sealed; the same buttons then give you the final version. Keep it — it is how you show, years from now, where the funds came from or went.")}

  <h2 id="trouble">When something goes wrong</h2>
  ${q("My link says it no longer works.",
      "Links are one-use and expire. From the sign-in page, enter your email and we send a fresh one. Your progress is saved.")}
  ${q("I did not get an email.",
      "Check spam and promotions for mail from send.thepaymaster.co.uk. If it is not there, request another from the sign-in page; if that fails, contact us and we will check the address we hold.")}
  ${q("The page says something is still outstanding but I have done it.",
      "Some steps need us or another party to act after you — confirming details, locking, deciding a verification. The step shows a clock while that is happening. If it has been more than a working day, contact us.")}

  <h2 id="contact">Contact us</h2>
  <p>Reply to any email we have sent you, write to
    <a href="mailto:info@thepaymaster.co.uk">info@thepaymaster.co.uk</a>, or call +44 20 7088 8267.
    Quote your reference — it is at the top of your page.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// The staff help page
// ---------------------------------------------------------------------------

export function adminHelp(): string {
  const gate = Object.entries(GATE_TIPS).map(([, t]) => `<li>${esc(t)}</li>`).join("");
  return `<div class="help">
  <h1>Staff help</h1>
  <p class="lead">How a transaction moves from an enquiry to a sealed dossier, what each
    screen is for, and what to do when something is not ticked. The rule underneath all of it:
    nothing is marked done by a person when the platform can check it instead.</p>

  <nav class="toc">
    <a href="#flow">The flow</a><a href="#attention">Needs attention</a><a href="#kyc">Verification</a>
    <a href="#gate">The readiness gate</a><a href="#chain">Chain settings</a>
    <a href="#screening">Wallet screening</a><a href="#send">Sending</a>
    <a href="#dossier">The dossier</a><a href="#mandate">Acting for the sender</a>
    <a href="#trouble">Common problems</a>
  </nav>

  <h2 id="flow">The flow</h2>
  <ol class="steps">
    <li><b>Enquiry</b> Arrives from the website form into Enquiries. Mark it contacted or booked; when it is real,
      Create transaction from this.</li>
    <li><b>Draft</b> The transaction exists. Set Chain settings (chain, token, fee wallet). Send the sender their
      start link; they name the recipients and shares.</li>
    <li><b>Release</b> Read what the sender submitted, then Release and invite everyone. This is the first email
      any recipient gets.</li>
    <li><b>Waiting for everyone</b> Parties verify, enter details and prove wallets. You get an email for each
      submission and each proved address.</li>
    <li><b>Verification</b> Decide each party in Verification: Pass with a ceiling and expiry, or Refuse. Upload
      the Themis report against the party first so it is in the dossier.</li>
    <li><b>Confirm and lock</b> Confirm each destination with its owner through a second channel, then Lock it.</li>
    <li><b>Ready</b> When every gate line is green, move the transaction to kyc and then ready. The sender is
      emailed that they can send.</li>
    <li><b>Settling → settled</b> Advances itself as payments land and are verified on chain.</li>
    <li><b>Seal</b> Open the Dossier, upload anything still missing, Seal it. Download the bundle for the file.
      Anchor the root on Ethereum when you have a signing wallet to hand.</li>
  </ol>

  <h2 id="attention">Needs attention</h2>
  <p>The panel at the top of the Pipeline lists everything waiting on a member of staff: new enquiries,
    verifications to decide, confirmed destinations to lock, transactions whose gate is green but which
    have not been moved on, and settled transactions not yet sealed. Empty means nothing is waiting on us.
    Each line links to the place where the thing is done.</p>

  <h2 id="kyc">Verification</h2>
  ${q("What am I deciding?",
      "That the documents and the screening report support this person or company taking part, up to a stated amount, for a stated time. Both are required: a clearance with no ceiling and no expiry is what lets somebody checked for a small deal through a large one years later.")}
  ${q("Where does the Themis report go?",
      "On the party's page, Documents → Upload, kind 'kyc_report'. It is fingerprinted on arrival and becomes a fact in the dossier of every transaction that party is on. Upload it before you record the decision so the note can refer to it.")}
  ${q("A company has directors who have not verified.",
      "Each director and 25%+ owner has their own party record and their own link. The company shows as verified only when you have passed it; whether you require every director first is your judgement — the platform records it, it does not decide it.")}

  <h2 id="gate">The readiness gate</h2>
  <p>Each line is checked by the platform, not ticked by a person. Moving a transaction on while any line is
    unmet is refused. The lines:</p>
  <ul>${gate}</ul>
  <div class="note">The ? beside each line on the transaction page shows the same explanation in place.</div>

  <h2 id="chain">Chain settings</h2>
  ${q("What am I setting?",
      "The rail — the chain and the asset together: USDT on Ethereum, or Bitcoin — the token contract address where the rail has one (USDT on mainnet is shown as a hint, not a value, until you save it), and the fee wallet our 1% goes to, which must be an address on the rail you chose. The two 'rehearsal only' rails are test networks where nothing is worth anything; use them to walk a transaction through before a real one. Everything must be saved before anything is sent.")}
  ${q("What is different about Bitcoin?",
      "Nobody can freeze a Bitcoin address, so that gate line does not appear. A payment takes about ten minutes to confirm rather than seconds, so the sender's page waits a few minutes and then tells them to come back and paste the transaction id under 'Sent it another way?' once it has confirmed. The test payment is 1,000 sats rather than one unit, because Bitcoin will not carry anything smaller. Proof of control is a BIP-322 or legacy signed message — Unisat, OKX, Sparrow, Electrum, Ledger and Trezor all produce one — and exchange deposit addresses go through attestation exactly as on Ethereum. And Bitcoin can pay everyone in one transaction: the Send page offers 'Or pay everyone in one transaction', which composes a single PSBT with an output per line and change back to the sender; their wallet signs it once, and each line is verified against that one transaction and recorded on its own.")}
  ${q("The page says 'Still to set' but the boxes have text in them.",
      "Grey text in a box is a placeholder showing the shape of the answer. Type or paste the value and Save.")}
  ${q("What does the Chain page show?",
      "The health of the three RPC endpoints we cross-check against each other (Alchemy, Infura, a public one) and the latest block from each. If they disagree, sends are refused until they agree.")}

  <h2 id="screening">Wallet screening</h2>
  ${q("How do I screen the wallets?",
      "On the transaction page, Screen all addresses. Each address goes to the screening provider (Nominis) and the verdict is recorded with a timestamp. A screening older than seven days does not count; the gate says so.")}
  ${q("An address came back high risk or sanctioned.",
      "The gate stays closed and the send buttons stay dead. Talk to the party; a replacement address goes through confirm, prove and lock again. Never override a sanctioned verdict.")}
  ${q("Screening says the provider is off.",
      "The Nominis key is set in Providers. Sepolia rehearsals are not covered by the provider and are recorded as such.")}

  <h2 id="send">Sending</h2>
  ${q("Who presses Send?",
      "The sender, in their own wallet, on their own Send page. Staff never hold or move funds. Under a signed mandate a member of staff may prepare the payments on the sender's behalf; the sender still signs.")}
  ${q("What is the dust test?",
      "One smallest unit of the token to each recipient before the real amount. The real button for that recipient unlocks only after its test is confirmed on chain.")}
  ${q("A payment was made outside the page.",
      "The sender uses Sent it another way? and pastes the hash. We verify the Transfer event on chain — token, amount, recipient. It counts only if all three match.")}

  <h2 id="dossier">The dossier</h2>
  ${q("What is in it?",
      "Every fact about the transaction — parties, verifications, destinations, proofs, screenings, payments, mandates, documents and the audit log — each hashed, the hashes rolled up into one Merkle root. The page explains how anyone can verify it without us.")}
  ${q("What does each party get?",
      "Their Peaceful Enjoyment dossier: certification.pdf (the Counterparty Certification — the transaction as it concerns them, drawn from the record, with the executive summary and their source-of-funds narrative; the letter a bank asks for), record.pdf and record.json (their entries with Merkle proofs; nothing about anyone else), and documents (their uploads, plus anything you ticked 'Share with the party' when uploading). They download it from their account; you can download it from the roster to send on; and the main dossier bundle carries a parties/ folder with one for each. A Themis report goes into their folder only if you ticked the box — it stays in the main dossier regardless.")}
  ${q("Certificates on chain",
      "Badges in the rail: the attestation key's address and its ETH balance on Base (fund it there for gas), and the certificate contract — deploy it once per chain from that page. Then, on a sealed transaction's dossier page, Mint the certificates: one soulbound token per party with a proved address (recipients' locked addresses, the sender's proved wallet) plus one to our fee wallet, id derived from the root. Parties already holding theirs are skipped, so it can be re-run. Nothing personal goes on chain; metadata served from client…/badge/<id>.json names only the reference, root and role.")}
  ${q("Annual statements",
      "On a party's page, one per year in which they sent or received anything: every paid leg (as recipient) or every leg and fee (as sender), totals per asset, the transactions and their sealed roots, a digest over the lines and ThePaymaster's EIP-712 signature over (party, year, digest, issued-at). Parties download their own; the verifier checks the JSON. Issued fresh each time; the digest is what ties one to its contents.")}
  ${q("Teams on company accounts",
      "A company party can have members — colleagues with their own party records and logins, each with a role. The company's own login is the owner and manages the team from its account page; you can see and remove members on the party page. Approvers must pass their own KYC before the Send page opens for them. Actions are logged against the person, never against the company: the audit line and the dossier name the human.")}
  ${q("Fiat: the penny test and the statement",
      "A recipient's bank account is proved the way a wallet is proved by signature: you press Send the penny on the roster, pay 0.01 from the client mandated account with the reference it shows (TPM PENNY plus six characters), and the recipient types the six characters from their statement into their account. Three wrong codes and you send a fresh penny. Payments: every leg has a reference — TPM-2026-0002 for the sender's money in, -01, -02… for each recipient in roster order, -FEE for ours — and the Bank operations panel gives a CSV of the outgoing payments for the bank's bulk upload. Then import the statement (paste or CSV, any bank's headings) and press Reconcile: a line with the exact reference and amount becomes a custody event, a line with the reference but a different amount is shown for you to decide, and nothing else is touched. Lines are held once across every transaction on the account.")}
  ${q("Running a distribution again",
      "Run it again on a settled or closed transaction (or the sender asks from their page) clones it: same recipients and shares, chain settings kept, addresses carried over as confirmed with their proof dates — not locked, because screening lasts a week and locking is our act. It arrives submitted. Set the amount in the split panel, screen and lock, release. Verified parties are cleared already; recipients who have not verified since are asked again.")}
  ${q("The data room",
      "Data room, on the roster, per party: a private expiring link for a bank or accountant to view that party's certification and record (and documents if you tick it), watermarked with the viewer's name and time. Every opening is logged; the party is emailed on the first. Parties can make their own from their page. Revoke from the same screen. Reads stay out of the sealed record, so viewing never drifts a seal.")}
  ${q("Seal or download first?",
      "Upload anything still to go in, then Seal, then Download. The download is a ZIP: the dossier as a self-contained HTML document, the same facts as JSON, and every uploaded document. Keep it with the compliance file. Downloading before sealing is allowed but the bundle will say it is unsealed.")}
  ${q("The record changed after sealing.",
      "The page says so. It is not wrong — facts were added — but seal again once the record is complete. Every seal is kept.")}
  ${q("Anchoring",
      "Publishes the sealed root on Ethereum mainnet in a transaction's calldata, addressed to our fee wallet, so the date of the record can be proved by anyone. Sign it from any wallet other than the fee wallet itself. It is manual and can be done any time after sealing.")}

  <h2 id="mandate">Acting for the sender</h2>
  <p>Where a sender wants us to prepare the payments for them, request a mandate from the transaction page.
    They sign it with their wallet; the wording and signature become a fact in the dossier. It never covers
    moving money — the sender still signs every payment.</p>

  <h2 id="trouble">Common problems</h2>
  ${q("A party says they never got their email.",
      "Check the audit log for the send. Ask them to look in spam for mail from send.thepaymaster.co.uk, or request a fresh link from the sign-in page. Their progress is not lost.")}
  ${q("A recipient's address is an exchange deposit address.",
      "They cannot sign from it. First choice: ask for a wallet they control; they forward to the exchange afterwards. Second: accept it on evidence. On the transaction page, under Where the money goes, 'Accept without a signature' asks for the custodian's name, what you saw, and the evidence file (a screenshot of their deposit page with their name on it, or a letter from the exchange). It is recorded under your name, the dossier says in plain words that the address was accepted on evidence and not by signature, and a change of address voids it. It can be revoked by anyone on staff with a reason. Screening, confirmation, locking and the dust test all still apply.")}
  ${q("The sender's wallet is a Safe or a hardware wallet.",
      "Both work. Safes prove control through the contract (EIP-1271); hardware wallets sign through their companion app. The Send page's Sent it another way? covers payments the page cannot watch itself.")}
  ${q("Something is stuck and I cannot tell why.",
      "The transaction page's readiness gate names the unmet line and what would meet it. The audit log shows every action, by whom, in order. If both look right and it is still stuck, that is a bug — send the reference to the developer.")}
  </div>`;
}
