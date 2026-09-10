/**
 * The dossier as a document somebody reads, prints, and files.
 *
 * Deliberately plain. This is the thing that gets attached to an email to a
 * compliance officer at a bank, printed to PDF, and opened in five years by
 * somebody who has never heard of us — so it explains itself, states its own
 * verification rules, and does not depend on this software still existing.
 */

import { type Env, type Actor } from "./db.ts";
import { page, nav, esc } from "./views.ts";
import { build, seals, seal, anchor, anchorData, ALGORITHM,
         type Fact, type Seal } from "./dossier.ts";
import { format } from "./money.ts";
import { explorerLink, CHAINS } from "./chain.ts";
import { badgesFor, contractFor, explorerToken, BADGE_CHAINS } from "./badge.ts";

/** Anchors go here and nowhere else. See anchorPanel for why. */
export const ANCHOR_CHAIN = 1;

/**
 * Where an anchor is addressed when the transaction names no fee wallet.
 *
 * It has to go somewhere, and it cannot go to the signer: MetaMask refuses to
 * attach data to a transaction addressed to one of your own accounts. Our own
 * fee wallet is the honest choice — we are publishing our own record to our
 * own address, and it will be the same address on every dossier.
 */
export const ANCHOR_TO = "0x048B3C145F05Fef0e2f837A5207bd912EdFf7e5e";

const MINOR = /_minor$/;

/** Values that are money or hashes deserve better than a raw dump. */
function value(key: string, v: unknown, decimals: number, chainId: number | null): string {
  if (v === null || v === undefined || v === "") return "&mdash;";
  const s = String(v);
  if (MINOR.test(key) && /^-?\d+$/.test(s)) {
    return `${esc(format(Number(s), decimals))} <span class="muted">(${esc(s)} minor)</span>`;
  }
  if (key === "tx_hash" && chainId) {
    return `<a href="${esc(explorerLink(chainId, s))}" class="mono">${esc(s)}</a>`;
  }
  if (/^0x[0-9a-fA-F]{40,66}$/.test(s)) return `<span class="mono">${esc(s)}</span>`;
  if (key === "sha256") return `<span class="mono">${esc(s)}</span>`;
  return esc(s);
}

function factBlock(f: Fact, leaf: string, index: number,
                   decimals: number, chainId: number | null): string {
  const rows = Object.entries(f.data)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `<tr><th>${esc(k.replace(/_/g, " "))}</th>
      <td>${value(k, v, decimals, chainId)}</td></tr>`).join("");
  return `<section class="fact">
    <h3>${index + 1}. ${esc(f.title)}</h3>
    <table class="kv">${rows}</table>
    <p class="leaf mono">leaf ${esc(leaf)}</p>
  </section>`;
}

export async function dossierPage(env: Env, admin: { name: string }, txId: string,
                                  notice?: string): Promise<Response> {
  const tx = await env.DB.prepare("SELECT * FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  if (!tx) return new Response("No such transaction", { status: 404 });

  const built = await build(env, txId);
  const history = await seals(env, txId);
  const latest: Seal | undefined = history[0];
  const drifted = latest && latest.root !== built.root;

  const groups = new Map<string, string[]>();
  built.facts.forEach((f, i) => {
    const name = f.kind.replace(/^\d+-/, "").replace(/-/g, " ");
    const list = groups.get(name) ?? [];
    list.push(factBlock(f, built.leaves[i], i, tx.decimals_in ?? 2, tx.chain_id));
    groups.set(name, list);
  });

  const state = !latest
    ? `<p class="warn">Not yet sealed. The root below is what a seal would commit to now.</p>`
    : drifted
      ? `<p class="bad">The record has changed since it was last sealed.
         That is not necessarily wrong — facts are still being added — but the
         sealed root no longer describes what is on this page. Seal again when
         the record is complete.</p>`
      : `<p class="good">Sealed and unchanged since.</p>`;

  return page(`Dossier ${tx.ref}`, `
    ${notice ? `<div class="err">${esc(notice)}</div>` : ""}
    <div class="doc">
      <header class="dochead">
        <h1>Transaction dossier</h1>
        <p class="ref">${esc(tx.ref)} — ${esc(tx.name ?? "")}</p>
        <p class="muted">Produced by ThePaymaster Ltd. Every fact below is
          recorded at the time it happened and cannot be edited afterwards.</p>
      </header>

      <section class="panel seal">
        <h2>Seal</h2>
        ${state}
        <table class="kv">
          <tr><th>Root, as the record stands</th>
              <td><span class="mono big">${esc(built.root)}</span></td></tr>
          <tr><th>Facts</th><td>${built.leaves.length}</td></tr>
          <tr><th>Algorithm</th><td class="mono">${esc(ALGORITHM)}</td></tr>
        </table>
        ${history.length ? `<h3>Seals</h3><table class="log">
          <tr><th>When</th><th>Root</th><th>Facts</th><th>On chain</th></tr>
          ${history.map((h) => `<tr><td>${esc(h.sealed_at)}</td>
            <td class="mono">${esc(h.root)}</td><td>${h.leaf_count}</td>
            <td>${h.anchor_tx_hash && h.anchor_chain_id
              ? `<a href="${esc(explorerLink(h.anchor_chain_id, h.anchor_tx_hash))}"
                   class="mono">${esc(h.anchor_tx_hash.slice(0, 14))}…</a>`
              : `<span class="muted">not anchored</span>`}</td></tr>`).join("")}
        </table>` : ""}
        <div class="row noprint" style="align-items:center;gap:14px">
          <form method="post" action="/t/${esc(txId)}/dossier/seal" style="margin:0">
            <button type="submit">Seal the record as it stands</button>
          </form>
          <a href="/t/${esc(txId)}/dossier.pdf" target="_blank"
             style="display:inline-block;padding:9px 14px;border:1.5px solid #1B2430;border-radius:8px;text-decoration:none;font-weight:600;color:#1B2430">
            Open as PDF</a>
          <a href="/t/${esc(txId)}/dossier/download"
             style="display:inline-block;padding:9px 14px;border:1.5px solid #1B2430;border-radius:8px;text-decoration:none;font-weight:600;color:#1B2430">
            Download the bundle</a>
          <span class="muted" style="font-size:13px">The PDF is the record for the file. The bundle is a ZIP:
            the PDF, the same record as HTML and JSON, and every uploaded file.${latest ? "" : " It will say it is unsealed."}</span>
        </div>
      </section>

      ${latest ? anchorPanel(latest, tx) : ""}
      ${latest ? await badgePanel(env, txId, latest) : ""}

      ${[...groups].map(([name, blocks]) => `<section class="group">
        <h2>${esc(name.charAt(0).toUpperCase() + name.slice(1))}</h2>
        ${blocks.join("")}
      </section>`).join("")}

      <section class="panel howto">
        <h2>How to verify this dossier without trusting us</h2>
        <ol>
          <li>Take one fact. Serialise it as JSON containing exactly its kind,
            its id and its data, with object keys sorted by Unicode code point,
            no whitespace, and any null or empty value omitted. Encode as UTF-8
            and take the SHA-256. That is its leaf, printed beneath it.</li>
          <li>Order every leaf by kind, then by id, both ascending as strings.</li>
          <li>Pair them left to right. Each parent is the SHA-256 of its two
            children's digests concatenated as raw bytes — not as hex text. A
            node with no partner is promoted unchanged; it is never duplicated.</li>
          <li>Repeat until one hash remains. It must equal the root above.</li>
        </ol>
        <p>To check a single document without being given the rest, ask us for
          that document's leaf and its audit path — a short list of hashes, each
          marked left or right. Fold them into the leaf in order and you arrive
          at the same root. Nothing about the other parties is disclosed.</p>
        <p class="muted">A document's own SHA-256 appears in its entry. Hash the
          file you were sent and compare: if it matches, the file is the one
          that was recorded, and the root proves when.</p>
      </section>
    </div>`, { nav: nav("", admin.name) });
}

/**
 * What to send, and where to put the answer.
 *
 * The instruction is deliberately explicit rather than a button: nothing here
 * can sign, and pretending otherwise by hiding the steps would misrepresent
 * what the platform is able to do.
 */
function anchorPanel(s: Seal, tx: any): string {
  // Always mainnet, whatever chain the deal itself settled on. A testnet
  // anchor would prove nothing: test chains are periodically reset and their
  // history is not something to rest a compliance record on. The cost of an
  // anchor is pennies, so there is no reason to economise here.
  const chainId = ANCHOR_CHAIN;
  const chain = CHAINS[chainId]?.name ?? `chain ${chainId}`;
  const data = anchorData(s.root);
  const gas = 21_000 + ((data.length - 2) / 2) * 16;

  if (s.anchor_tx_hash && s.anchor_chain_id) {
    return `<section class="panel">
      <h2>On the chain</h2>
      <p class="good">This root is published. ${esc(chain)} says the record
        existed no later than ${esc(s.anchored_at ?? "")} UTC, and that is the
        chain's word rather than ours.</p>
      <table class="kv">
        <tr><th>Block time</th><td>${esc(s.anchored_at ?? "")} UTC</td></tr>
        <tr><th>Transaction</th><td><a class="mono"
          href="${esc(explorerLink(s.anchor_chain_id, s.anchor_tx_hash))}"
          >${esc(s.anchor_tx_hash)}</a></td></tr>
        <tr><th>What it carries</th><td><span class="mono">${esc(anchorData(s.root))}</span></td></tr>
      </table>
      <p class="muted">Anyone can open that transaction on a block explorer and
        read the root out of its input data. The tag is plain text; the sixty-four
        characters after it are the root printed above.</p>
    </section>`;
  }

  return `<section class="panel noprint">
    <h2>Put this root on the chain</h2>
    <p>Sealing records the root here. Anchoring publishes it, so the date does
      not depend on our database. It moves no money and needs no contract —
      a zero-value transaction to ourselves, carrying the root as its data.</p>
    <p class="muted">Always on ${esc(chain)}, whatever chain the transaction
      itself used. A test network would be free but its history is not
      permanent, and a date nobody can rely on is not worth recording.</p>

    <div id="wallet" hidden>
      <p><button type="button" id="send">Send it from my wallet</button>
        <span id="walletmsg" class="muted"></span></p>
      <p class="muted">Your wallet signs; nothing here can. The hash comes back
        into the box below and is checked against the chain before it is recorded.</p>
    </div>

    <details id="byhand">
      <summary>Send it by hand instead</summary>
      <table class="kv">
        <tr><th>Network</th><td>${esc(chain)} <span class="muted">(chain ${chainId})</span></td></tr>
        <tr><th>To</th><td><span class="mono">${esc(tx.fee_wallet || ANCHOR_TO)}</span>
          <span class="muted">— our own wallet. Never leave this blank: an
            empty recipient means "deploy a contract". Do not send it from
            this same account either — a wallet will not attach data to a
            transaction addressed to itself.</span></td></tr>
        <tr><th>Value</th><td>0</td></tr>
        <tr><th>Data (hex)</th><td><span class="mono">${esc(data)}</span></td></tr>
        <tr><th>Gas</th><td>about ${gas.toLocaleString("en-GB")}</td></tr>
      </table>
      <p class="muted">Some wallets hide the data field. In the MetaMask
        extension it is Settings → Advanced → Show hex data, after which a Hex
        data box appears on the send screen. If you cannot find it, use the
        button above instead — it fills the field in for you.</p>
    </details>

    <form method="post" action="/t/${esc(tx.id)}/dossier/anchor">
      <input type="hidden" name="seal" value="${esc(s.id)}">
      <input type="hidden" name="chain_id" value="${chainId}">
      <label>Transaction hash
        <input name="tx_hash" id="txhash" placeholder="0x…" size="70" required></label>
      <button type="submit">Verify and record</button>
    </form>

    <script>
    (function () {
      var eth = window.ethereum;
      if (!eth) return;                       // no wallet: the manual route stands
      document.getElementById("wallet").hidden = false;
      document.getElementById("byhand").open = false;

      var want = "0x${chainId.toString(16)}";
      // The recipient is genuinely irrelevant, so it is the sender's own
      // address. Never leave this empty: a transaction with no recipient is a
      // contract deployment, which is emphatically not what this is.
      var to = ${JSON.stringify(tx.fee_wallet || ANCHOR_TO)};
      var data = ${JSON.stringify(data)};
      var say = function (m) { document.getElementById("walletmsg").textContent = m; };

      document.getElementById("send").addEventListener("click", async function () {
        var button = this;
        button.disabled = true;
        try {
          var accounts = await eth.request({ method: "eth_requestAccounts" });
          if (!accounts || !accounts.length) throw new Error("No account selected.");

          // The wrong network would publish the root somewhere nobody looks.
          if (await eth.request({ method: "eth_chainId" }) !== want) {
            say("Switching network…");
            await eth.request({ method: "wallet_switchEthereumChain",
                                params: [{ chainId: want }] });
          }

          say("Confirm it in your wallet…");
          // MetaMask will not attach data to a transaction addressed to one
          // of your own accounts, so signing from the destination fails with
          // a message that does not explain itself. Say what to do instead.
          if (accounts[0].toLowerCase() === to.toLowerCase()) {
            throw new Error("This wallet is the destination. Switch MetaMask to " +
              "a different account — a wallet cannot attach data to a " +
              "transaction sent to itself.");
          }
          var hash = await eth.request({ method: "eth_sendTransaction", params: [{
            from: accounts[0], to: to, value: "0x0", data: data }] });

          document.getElementById("txhash").value = hash;
          say("Sent. Wait for it to be included, then press Verify and record.");
        } catch (err) {
          say((err && (err.message || err.code)) || "Cancelled.");
        } finally {
          button.disabled = false;
        }
      });
    })();
    </script>
  </section>`;
}

export async function anchorNow(env: Env, actor: Actor, txId: string,
                                request: Request): Promise<Response> {
  const f = await request.formData();
  const result = await anchor(env, actor, String(f.get("seal") ?? ""), {
    chainId: Number(f.get("chain_id") ?? 1),
    txHash: String(f.get("tx_hash") ?? ""),
  });
  if ("problem" in result) {
    const admin = { name: "" };
    return dossierPage(env, admin, txId, result.problem);
  }
  return Response.redirect(new URL(`/t/${txId}/dossier`, request.url).toString(), 302);
}

export async function sealNow(env: Env, actor: Actor, txId: string,
                              request: Request): Promise<Response> {
  // Sealing an unchanged record produces a second commitment to exactly the
  // same facts. It proves nothing the first one did not, and a column of
  // identical roots makes the genuine changes harder to see.
  const [current, latest] = await Promise.all([build(env, txId), seals(env, txId)]);
  if (latest[0] && latest[0].root === current.root) {
    return dossierPage(env, { name: "" }, txId,
      "The record has not changed since it was last sealed, so that seal still " +
      "stands. Seal again once something has been added.");
  }
  await seal(env, actor, txId);
  return Response.redirect(
    new URL(`/t/${txId}/dossier`, request.url).toString(), 302);
}


/**
 * Certificates on chain: what has been minted for this record, and the button
 * that mints the rest. Costs gas from the attestation key, so it is a
 * deliberate act by staff, after sealing, never automatic.
 */
async function badgePanel(env: Env, txId: string, latest: Seal): Promise<string> {
  const badges = await badgesFor(env, txId);
  // A rehearsal record (Sepolia) gets its certificates on Base Sepolia; a real one on Base.
  const t = await env.DB.prepare("SELECT chain_id, rail FROM transactions WHERE id = ?").bind(txId).first<any>();
  const rehearsal = t?.chain_id === 11155111 || /signet|sepolia/i.test(String(t?.rail ?? ""));
  const chainId = rehearsal ? BADGE_CHAINS.rehearsal : BADGE_CHAINS.live;
  const contract = await contractFor(env, chainId);
  const rows = badges.map((b) => `<tr>
    <td>${b.party_id ? `<a href="/p/${esc(b.party_id)}">party</a>` : "the transaction"}</td>
    <td class="mono">${esc(b.to_address)}</td>
    <td><a class="mono" href="${esc(explorerToken(b.chain_id, b.contract, b.token_id))}" target="_blank" rel="noopener">${esc(b.token_id.slice(0, 14))}…</a></td>
    <td class="muted">${esc(String(b.minted_at).slice(0, 16))}</td>
    <td><a class="mono" href="${esc(explorerLink(b.chain_id, b.tx_hash))}" target="_blank" rel="noopener">${esc(b.tx_hash.slice(0, 12))}…</a></td>
  </tr>`).join("");
  return `<section class="panel">
    <h2>Certificates on chain</h2>
    <p class="muted">A soulbound token per party, minted by our attestation key to the address they proved,
      with an id derived from the sealed root. Nothing personal goes on chain. It costs a little gas on
      ${esc(CHAINS[chainId]?.name ?? "Base")}; the key's balance and the contract are on the <a href="/badges">Badges</a> page.</p>
    ${badges.length ? `<table class="log"><tr><th>For</th><th>Holder</th><th>Token</th><th>Minted</th><th>Transaction</th></tr>${rows}</table>` : `<p class="muted">None minted yet.</p>`}
    ${contract ? `<form method="post" action="/t/${esc(txId)}/badges/mint" class="noprint" style="margin-top:10px">
        <input type="hidden" name="chain" value="${chainId}">
        <button type="submit">Mint the certificates${badges.length ? " still missing" : ""} on ${esc(CHAINS[chainId]?.name ?? "Base")}</button>
        <span class="muted" style="font-size:13px"> — one per party with a proved address, plus one to our fee wallet. Parties already holding theirs are skipped.</span>
      </form>`
      : `<p class="warn noprint">The certificate contract is not deployed on ${esc(CHAINS[chainId]?.name ?? "Base")} yet — deploy it from the <a href="/badges">Badges</a> page first.</p>`}
  </section>`;
}
