/**
 * The screens where a wallet is proved, and the handler behind them.
 *
 * Two routes to the same signature, because clients will not all be the same.
 * Somebody with MetaMask signs in the page. Somebody whose USDT sits behind a
 * hardware wallet, a multisig or an exchange desk signs wherever they can and
 * pastes the result. Both end up in the same field and are checked identically
 * — refusing the second would mean refusing exactly the sort of client who
 * moves this kind of money.
 */

import { type Env, type Actor, id, log, insert, update } from "./db.ts";
import { esc } from "./views.ts";
import { challenge, proves } from "./wallets.ts";
import { railForTransaction, railForParticipation, type Rail } from "./rail.ts";

function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const PROOF_CSS = `
.chal{background:var(--panel);border:1px solid var(--rule);border-radius:9px;
  padding:14px 16px;white-space:pre-wrap;font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  margin:12px 0;overflow-x:auto}
.wallet{border:1px solid var(--rule);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.wallet.proved{background:#EAF7F0;border-color:#B7E0C9}
.wallet{position:relative}
.wallet form.rm{position:absolute;top:12px;right:12px;margin:0}
.wallet form.rm button.small{font-size:12.5px;padding:5px 10px}
@media(max-width:560px){.wallet form.rm{position:static;margin-top:10px}}
.wallet code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.lead{font-size:17px}
.addr{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;
  background:var(--panel);padding:2px 6px;border-radius:5px}
.note{background:#FFF8EE;border:1px solid #F0D8B4;border-radius:10px;padding:14px 18px;margin:14px 0}
.note ul.ways{margin:10px 0 0;padding-left:20px}
.note ul.ways li{margin-bottom:9px;line-height:1.55}
details.help{margin-top:20px;border-top:1px solid var(--rule);padding-top:14px}
details.help summary{cursor:pointer;font-weight:600;color:var(--ink)}
`;

/**
 * The signing widget.
 *
 * The message is rendered from the server and the page never composes one of
 * its own — a client that could choose its own words could obtain a signature
 * for something other than what we verify.
 */
export function proofForm(opts: {
  action: string;
  message: string;
  address: string;
  rail: Rail;
  hidden?: Record<string, string>;
  error?: string;
}): string {
  const hidden = Object.entries(opts.hidden ?? {})
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  const btc = opts.rail.key.startsWith("btc:");

  return `
  <p class="lead">Before we can pay this wallet, you need to show us it is
    really yours. You do that by <b>signing a short message</b> with it.
    It moves no money, costs nothing, and cannot be used to spend anything.</p>

  ${opts.error ? `<div class="err"><b>That did not work.</b> ${esc(opts.error)}</div>` : ""}

  <p class="muted">The wallet being proved is
    <code class="addr">${esc(opts.address)}</code></p>

  <!-- The path for someone with a wallet in this browser. Shown only when one
       is actually there, and replaced by a plain explanation when it is not,
       because an absent button is the thing that leaves people stuck. -->
  <div id="haswallet" hidden>
    <button type="button" id="signit" class="go">Sign with my wallet</button>
    <p class="muted" id="whichacct" hidden></p>
  </div>

  <div id="nowallet" hidden>
    <div class="note">
      <b>No wallet found in this browser.</b>
      <p>That is normal — most people keep their wallet somewhere else. Pick
         whichever describes you:</p>
      ${btc ? `<ul class="ways">
        <li><b>My wallet is on my phone.</b> Open this same page inside the
            wallet app's own browser (Unisat and OKX have one), and a button
            will appear here.</li>
        <li><b>I use Sparrow or Electrum.</b> <i>Tools → Sign/Verify Message</i>:
            choose this address, paste the message below, sign, and copy the
            signature back here.</li>
        <li><b>I use a Ledger or Trezor.</b> Connect it to Sparrow and sign the
            message from there.</li>
        <li><b>I use Xverse or Leather.</b> Sign the message in the wallet's own
            <i>Sign message</i> screen and paste the result here.</li>
        <li><b>My funds are with an exchange.</b> An exchange deposit address
            cannot sign. Use <i>I cannot sign from this address</i> below and we
            will take it from there.</li>
      </ul>` : `<ul class="ways">
        <li><b>My wallet is on my phone.</b> Open this same page inside your
            wallet app's own browser (MetaMask, Trust and Coinbase Wallet all
            have one), and a button will appear here.</li>
        <li><b>I use MetaMask, but on a different browser.</b> Open this page
            there instead. The link works as many times as you need.</li>
        <li><b>I use a Trezor.</b> In Trezor Suite, open the account, then
            <i>Sign &amp; verify message</i>. Paste the message below into it,
            sign, and copy the signature back here.</li>
        <li><b>I use a Ledger.</b> Ledger's own app cannot sign a message —
            connect the Ledger through MetaMask or Rabby and use the button.</li>
        <li><b>My funds are with an exchange or custodian.</b> Ask them to sign
            the message below with that address and send you the signature.</li>
      </ul>`}
    </div>
  </div>

  <h3>The message to sign</h3>
  <div class="chal" id="challenge">${esc(opts.message)}</div>
  <p><button type="button" class="plain" id="copymsg">Copy the message</button>
     <span class="muted" id="copied" hidden>Copied.</span></p>

  <form method="post" action="${esc(opts.action)}">
    ${hidden}
    <label for="sig">Paste the signature here</label>
    <textarea id="sig" name="signature" rows="3" required spellcheck="false"
      placeholder="${btc ? "A long line of letters, digits and = signs" : "0x…"}"></textarea>
    <p class="muted">${btc
      ? "A signature is a long line of letters and digits, usually ending in <code>=</code>."
      : "A signature is a long line starting <code>0x</code>."} Copy all of it.</p>
    <div style="margin-top:12px"><button class="go">Check it</button></div>
  </form>

  <details class="help">
    <summary>Nothing here is working — what now?</summary>
    <p>Tell us and we will sort it out: it is a normal thing to get stuck on.
       Email <a href="mailto:info@thepaymaster.co.uk">info@thepaymaster.co.uk</a>
       or call <a href="tel:+442070888267">+44 20 7088 8267</a> and we will walk
       through it with you.</p>
    <p class="muted">One thing we cannot do is skip it. Paying a wallet nobody
       has proved is how money reaches the wrong person and never comes back.</p>
  </details>

  <script>${opts.rail.browser.script}</script>
  <script>
    (function () {
      var want = ${JSON.stringify(opts.address)};
      var wallet = window.railWallet;

      // Copying the message matters more than it looks: everybody signing
      // somewhere else has to get these exact words across intact.
      var copy = document.getElementById('copymsg');
      copy.addEventListener('click', function () {
        var text = document.getElementById('challenge').textContent;
        navigator.clipboard.writeText(text).then(function () {
          var ok = document.getElementById('copied');
          ok.hidden = false;
          setTimeout(function () { ok.hidden = true; }, 2500);
        });
      });

      if (!wallet || !wallet.present()) {
        document.getElementById('nowallet').hidden = false;
        return;
      }
      document.getElementById('haswallet').hidden = false;

      var btn = document.getElementById('signit');
      var says = document.getElementById('whichacct');
      function tell(html) { says.hidden = !html; says.innerHTML = html; }

      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var was = btn.textContent;
        btn.textContent = 'Check your wallet…';
        try {
          var accounts = await wallet.accounts();

          // The wallet signs with whichever account is selected, which is not
          // necessarily the one being proved. Signing with the wrong one gives
          // a valid signature that fails our check for reasons the failure
          // message cannot explain, so it is caught here instead.
          var match = (accounts || []).find(function (a) { return wallet.same(a, want); });
          if (!match) {
            var on = (accounts && accounts[0]) ? accounts[0] : 'no account';
            tell('Your wallet is currently on <code>' + on + '</code>, but this ' +
                 'address is <code>' + want + '</code>.<br>Switch to that account ' +
                 'in your wallet, then press the button again. If it is not in ' +
                 'the list, connect it to this site first.');
            btn.disabled = false; btn.textContent = was;
            return;
          }

          tell('');
          var msg = document.getElementById('challenge').textContent;
          var sig = await wallet.signMessage(match, msg);
          document.getElementById('sig').value = sig;
          tell('<b>Signed.</b> Now press <b>Check it</b> below.');
          document.getElementById('sig').scrollIntoView({ block: 'center' });
        } catch (e) {
          var m = (e && e.message) ? e.message : String(e);
          tell(/reject|denied/i.test(m)
            ? 'You cancelled it in your wallet. Press the button again when ready.'
            : 'That did not complete: ' + m);
        }
        btn.disabled = false;
        btn.textContent = was;
      });
    })();
  </script>`;
}

// ---------------------------------------------------------------------------
// A recipient proving the wallet they want paying to
// ---------------------------------------------------------------------------

export async function challengeForDestination(env: Env, actor: Actor, dest: any,
                                              ref: string): Promise<string> {
  let n = dest.proof_nonce;
  if (!n) {
    n = nonce();
    await env.DB.prepare("UPDATE destinations SET proof_nonce = ? WHERE id = ?")
      .bind(n, dest.id).run();
  }
  return challenge({ ref, address: dest.address, role: "recipient", nonce: n });
}

export async function proveDestination(env: Env, actor: Actor, destinationId: string,
                                       ref: string, signature: string): Promise<string | null> {
  const d = await env.DB.prepare("SELECT * FROM destinations WHERE id = ?")
    .bind(destinationId).first<any>();
  if (!d || d.kind !== "wallet") return "There is no wallet to prove.";
  if (!d.proof_nonce) return "Start again — the challenge has gone.";

  const message = challenge({
    ref, address: d.address, role: "recipient", nonce: d.proof_nonce,
  });
  // A contract wallet has no key to recover, so the chain is asked instead.
  // Which kind of wallet it is does not need to be known here.
  const rail = await railForParticipation(env, d.participation_id);
  if (!await rail.provesControl(env, { address: d.address, message, signature })) {
    return "That signature does not come from that wallet. Check you signed with " +
           "the right account, and that the whole signature was copied. " +
           "If this is a Safe or another contract wallet, the signature has to " +
           "be one the wallet itself will vouch for.";
  }

  await update(env.DB, actor, "destination.proved", "destinations", destinationId, {
    proof_signature: signature.trim(),
    proved_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  }, { proved_at: d.proved_at ?? null },
    { note: `control of ${d.address} proved by signature` });
  return null;
}

// ---------------------------------------------------------------------------
// A sender declaring, and proving, the wallets they will send from
// ---------------------------------------------------------------------------

export async function sendingWallets(env: Env, transactionId: string) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM sending_wallets WHERE transaction_id = ? AND removed_at IS NULL
      ORDER BY created_at`)
    .bind(transactionId).all<any>();
  return results ?? [];
}

export async function addSendingWallet(env: Env, actor: Actor, opts: {
  transactionId: string; partyId: string; chain: string; address: string; label?: string;
}): Promise<string | null> {
  const rail = await railForTransaction(env, opts.transactionId);
  const shape = rail.normalise(opts.address);
  if (!shape.ok) return shape.why;
  const address = shape.address;

  // The token's own contract address is not a wallet. Pasting it here is an
  // easy mistake — both are 0x addresses on the same screen — and it would
  // otherwise sit in the list blocking the gate with a proof nobody can give.
  const t = await env.DB.prepare(
    "SELECT token_address, fee_wallet FROM transactions WHERE id = ?")
    .bind(opts.transactionId).first<any>();
  if (t?.token_address &&
      String(t.token_address).toLowerCase() === address.toLowerCase()) {
    return "That is the token's contract address, not a wallet. You want the " +
           "address of the wallet the coins are held in.";
  }
  if (t?.fee_wallet &&
      String(t.fee_wallet).toLowerCase() === address.toLowerCase()) {
    return "That is our fee address, not a sending wallet.";
  }

  const live = await env.DB.prepare(
    `SELECT id FROM sending_wallets
      WHERE transaction_id = ? AND lower(address) = ? AND removed_at IS NULL`)
    .bind(opts.transactionId, address.toLowerCase()).first<any>();
  if (live) return "That wallet is already on this transaction.";

  // A wallet that was withdrawn and is now being added back. The row is
  // revived rather than replaced: the table holds a UNIQUE across
  // (transaction, chain, address), which a second row would violate — it did,
  // with a 500 that told the sender nothing. The proof goes, so control is
  // demonstrated again rather than inherited from before it was withdrawn.
  const withdrawn = await env.DB.prepare(
    `SELECT id FROM sending_wallets
      WHERE transaction_id = ? AND lower(address) = ? AND removed_at IS NOT NULL
      ORDER BY rowid DESC LIMIT 1`)
    .bind(opts.transactionId, address.toLowerCase()).first<any>();
  if (withdrawn) {
    await update(env.DB, actor, "sending_wallet.restored", "sending_wallets",
      withdrawn.id, {
        removed_at: null, removed_by: null,
        chain: opts.chain.trim() || "ethereum",
        label: opts.label?.trim() || null,
        proved_at: null, proof: null, proof_nonce: null,
      }, { removed_at: "set" }, { note: `${address} put back on the transaction` });
    return null;
  }

  await insert(env.DB, actor, "sending_wallet.added", "sending_wallets", id("swl"), {
    transaction_id: opts.transactionId,
    party_id: opts.partyId,
    chain: opts.chain.trim(),
    address,
    label: opts.label?.trim() || null,
    proof_nonce: nonce(),
  }, { note: address });
  return null;
}

export async function proveSendingWallet(env: Env, actor: Actor, walletId: string,
                                         ref: string, signature: string): Promise<string | null> {
  const w = await env.DB.prepare("SELECT * FROM sending_wallets WHERE id = ?")
    .bind(walletId).first<any>();
  if (!w) return "No such wallet.";
  if (w.removed_at) return "That wallet has been taken off this transaction.";
  if (!w.proof_nonce) return "Start again — the challenge has gone.";

  const message = challenge({
    ref, address: w.address, role: "sender", nonce: w.proof_nonce,
  });
  const rail = await railForTransaction(env, w.transaction_id);
  if (!await rail.provesControl(env, { address: w.address, message, signature })) {
    return "That signature does not come from that wallet. Check you signed with " +
           "the right account, and that the whole signature was copied. " +
           "If this is a Safe or another contract wallet, the signature has to " +
           "be one the wallet itself will vouch for.";
  }

  await update(env.DB, actor, "sending_wallet.proved", "sending_wallets", walletId, {
    proof: signature.trim(),
    proved_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  }, { proved_at: w.proved_at ?? null }, { note: `control of ${w.address} proved` });
  return null;
}

/**
 * A sending wallet's challenge, minting the nonce if there is not one.
 *
 * This used to read the nonce and trust it to be there. It is not there on a
 * wallet that has been withdrawn and put back, because reviving the row clears
 * the proof — so the challenge rendered "Nonce: null" and no signature of it
 * could ever be accepted. The destination version has always minted on demand;
 * this one now does the same.
 */
export async function challengeForSendingWallet(env: Env, w: any,
                                                ref: string): Promise<string> {
  let n = w.proof_nonce;
  if (!n) {
    n = nonce();
    await env.DB.prepare("UPDATE sending_wallets SET proof_nonce = ? WHERE id = ?")
      .bind(n, w.id).run();
  }
  return challenge({ ref, address: w.address, role: "sender", nonce: n });
}

/** The chain a transaction runs on, defaulting to Ethereum. */

/**
 * Take a sending wallet back off a transaction.
 *
 * Kept rather than deleted: that an address was declared and then withdrawn is
 * worth knowing, especially if it reappears. Refused once the money is moving,
 * because by then the declaration is part of what happened.
 */
export async function removeSendingWallet(env: Env, actor: Actor,
                                          walletId: string): Promise<string | null> {
  const w = await env.DB.prepare(
    `SELECT s.*, t.status FROM sending_wallets s
       JOIN transactions t ON t.id = s.transaction_id
      WHERE s.id = ?`).bind(walletId).first<any>();
  if (!w) return "No such wallet.";
  if (w.removed_at) return null;
  if (["settling", "settled", "closed"].includes(String(w.status))) {
    return "This transaction is already being settled, so the wallets it " +
           "declared cannot be changed. Tell us and we will note it.";
  }
  await update(env.DB, actor, "sending_wallet.removed", "sending_wallets", walletId, {
    removed_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    removed_by: actor.id,
  }, { removed_at: null }, { note: `${w.address} withdrawn` });
  return null;
}
