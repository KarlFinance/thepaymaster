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
import { challenge, proves, addressProblem, toChecksum } from "./wallets.ts";

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
.wallet code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
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
  hidden?: Record<string, string>;
  error?: string;
}): string {
  const hidden = Object.entries(opts.hidden ?? {})
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `
  ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
  <p>Prove you hold the key to <code>${esc(opts.address)}</code> by signing this.
     It moves nothing and costs nothing.</p>
  <div class="chal" id="challenge">${esc(opts.message)}</div>
  <form method="post" action="${esc(opts.action)}">
    ${hidden}
    <button type="button" id="signit" class="plain" hidden>Sign with my wallet</button>
    <label for="sig">Signature</label>
    <textarea id="sig" name="signature" rows="3" required spellcheck="false"
      placeholder="0x…"></textarea>
    <p class="muted">If you signed elsewhere — a hardware wallet, a multisig, your
       exchange desk — paste the signature here.</p>
    <div style="margin-top:12px"><button>Check it</button></div>
  </form>
  <script>
    // Only offered when a browser wallet is actually present; everyone else
    // uses the box, which is the same field and the same check.
    if (window.ethereum) {
      var btn = document.getElementById('signit');
      btn.hidden = false;
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        var was = btn.textContent;
        btn.textContent = 'Check your wallet…';
        try {
          var accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
          var msg = document.getElementById('challenge').textContent;
          var sig = await window.ethereum.request({
            method: 'personal_sign', params: [msg, accounts[0]]
          });
          document.getElementById('sig').value = sig;
        } catch (e) {
          alert('That did not complete: ' + (e && e.message ? e.message : e));
        }
        btn.disabled = false;
        btn.textContent = was;
      });
    }
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
  if (!proves(message, signature, d.address)) {
    return "That signature does not come from that wallet. Check you signed with " +
           "the right account, and that the whole signature was copied.";
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
    `SELECT * FROM sending_wallets WHERE transaction_id = ? ORDER BY created_at`)
    .bind(transactionId).all<any>();
  return results ?? [];
}

export async function addSendingWallet(env: Env, actor: Actor, opts: {
  transactionId: string; partyId: string; chain: string; address: string; label?: string;
}): Promise<string | null> {
  const problem = addressProblem(opts.address);
  if (problem) return problem;
  const address = toChecksum(opts.address.trim());

  const existing = await env.DB.prepare(
    "SELECT id FROM sending_wallets WHERE transaction_id = ? AND lower(address) = ?")
    .bind(opts.transactionId, address.toLowerCase()).first<any>();
  if (existing) return "That wallet is already on this transaction.";

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
  if (!w.proof_nonce) return "Start again — the challenge has gone.";

  const message = challenge({
    ref, address: w.address, role: "sender", nonce: w.proof_nonce,
  });
  if (!proves(message, signature, w.address)) {
    return "That signature does not come from that wallet. Check you signed with " +
           "the right account, and that the whole signature was copied.";
  }

  await update(env.DB, actor, "sending_wallet.proved", "sending_wallets", walletId, {
    proof: signature.trim(),
    proved_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  }, { proved_at: w.proved_at ?? null }, { note: `control of ${w.address} proved` });
  return null;
}

export function challengeForSendingWallet(w: any, ref: string): string {
  return challenge({ ref, address: w.address, role: "sender", nonce: w.proof_nonce });
}
