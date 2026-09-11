/**
 * The distribution, as the sender sees and performs it.
 *
 * One row per payment, our fee among them, each sent by the sender's own
 * wallet and each recorded against a hash the platform verifies against the
 * chain before it will call the leg done.
 */

import { type Env, type Actor, id, update, canMove } from "./db.ts";
import { esc } from "./views.ts";
import { format } from "./money.ts";
import { plan, transferData, gasNeeded,
         type Plan, type Line } from "./execute.ts";
import { record } from "./settlement.ts";
import { paymentLanded } from "./notify.ts";

/** Native currency, for gas. Four decimals is plenty and thousands of ETH
 *  should not run together into an unreadable number. */
const eth = (wei: bigint | null) =>
  wei === null ? "unknown"
    : (Number(wei) / 1e18).toLocaleString("en-GB",
        { minimumFractionDigits: 4, maximumFractionDigits: 4 });

function lineRow(l: Line, p: Plan): string {
  const amount = `${esc(format(l.amountMinor, p.decimals))} ${esc(p.currency)}`;

  if (l.paid) {
    return `<tr class="done">
      <td>${esc(l.name)}<div class="muted mono">${esc(l.address ?? "")}</div></td>
      <td class="num">${amount}</td>
      <td><span class="good">paid</span>${l.txHash
        ? ` <a class="mono" href="${esc(p.rail.explorer.tx(l.txHash))}"
             >${esc(l.txHash.slice(0, 12))}…</a>` : ""}</td>
    </tr>`;
  }

  // Everything except the missing test payment. A line whose only outstanding
  // item is the test must still be able to run the test.
  const otherProblems = l.problems.filter((x) => !x.startsWith("No test payment"));
  const untested = !l.testedHash;
  const blocked = otherProblems.length > 0 || p.blocking.length > 0 || untested;
  return `<tr>
    <td>${esc(l.name)}
      <div class="muted mono">${l.address
        ? `<a href="${esc(p.rail.explorer.address(l.address))}">${esc(l.address)}</a>`
        : "no address yet"}</div>
      ${l.problems.map((x) => `<div class="bad">${esc(x)}</div>`).join("")}
      ${l.notes.map((x) => `<div class="warn">${esc(x)}</div>`).join("")}</td>
    <td class="num">${amount}</td>
    <td>${l.testedHash
        ? `<div class="muted">test landed
             <a class="mono" href="${esc(p.rail.explorer.tx(l.testedHash))}"
               >${esc(l.testedHash.slice(0, 10))}…</a></div>`
        : ""}
      ${blocked
        ? (untested && !otherProblems.length && !p.blocking.length
            ? `<button type="button" class="test" data-to="${esc(l.address ?? "")}"
                 data-leg="${esc(l.participationId ?? "fee")}"
                 data-name="${esc(l.name)}">Send a test payment</button>`
            : `<span class="muted">blocked</span>`)
        : `<button type="button" class="pay" data-to="${esc(l.address ?? "")}"
             data-amount="${l.amountMinor}"
             data-leg="${esc(l.participationId ?? "fee")}"
             data-name="${esc(l.name)}">Send ${amount}</button>`}</td>
  </tr>`;
}

export function executeBody(p: Plan, txId: string, notice: string, base = `/d/${txId}/send`): string {
  const modeC = p.execution === "client_wallet";
  const outstanding = p.lines.filter((l) => !l.paid);
  const done = p.lines.length - outstanding.length;

  const funders = p.funders.map((f) => {
    const short = gasNeeded(outstanding.length);
    const lowGas = f.gasWei !== null && f.gasWei < short;
    return `<tr>
      <td class="mono">${esc(f.address)}${f.label ? `<div class="muted">${esc(f.label)}</div>` : ""}</td>
      <td class="num">${f.tokenMinor === null ? "unknown"
        : esc(format(Number(f.tokenMinor), p.decimals))} ${esc(p.currency)}</td>
      <td class="num">${eth(f.gasWei)}${lowGas
        ? ` <span class="bad">low</span>` : ""}</td>
      <td>${f.proved ? `<span class="good">proved</span>`
                     : `<span class="bad">not proved</span>`}</td>
    </tr>`;
  }).join("");

  return `
    <h1>Send the distribution</h1>
    <p class="sub">${done} of ${p.lines.length} paid</p>
    ${notice ? `<div class="err">${esc(notice)}</div>` : ""}

    ${!outstanding.length ? `<div class="step-line done" style="margin-bottom:18px">
        <span class="sl-mark">&#10003;</span>
        <span class="sl-body"><b>Every payment has landed.</b>
          <span class="sl-sum">All ${p.lines.length} confirmed on the chain. There is nothing
          left for you to send; we are sealing the record and will email you when
          it is done.</span></span></div>`
      : p.blocking.length ? `<div class="err"><strong>Not ready to send</strong>
      <ul>${p.blocking.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : ""}

    <div class="card">
      <h2>Where it comes from</h2>
      <table class="log">
        <tr><th>Wallet</th><th class="num">Holds</th>
            <th class="num">For gas</th><th>Control</th></tr>
        ${funders || `<tr><td colspan="4" class="muted">No sending wallet yet.</td></tr>`}
      </table>
      <p class="muted">${modeC ? "ThePaymaster's client wallet for this transaction, holding the sender's funds on trust until they are paid out. Sign each payment from the wallet that holds its key." : "You may send from more than one wallet. There is no need"}
        to move funds into a single one first — each payment is its own
        transaction, and consolidating first adds a hop to explain later.</p>
    </div>

    <div class="card">
      <h2>Where it goes</h2>
      <table class="log">
        <tr><th>To</th><th class="num">Amount</th><th></th></tr>
        ${p.lines.map((l) => lineRow(l, p)).join("")}
        <tr class="total"><td><strong>Still to send</strong></td>
          <td class="num"><strong>${esc(format(p.totalMinor, p.decimals))}
            ${esc(p.currency)}</strong></td><td></td></tr>
      </table>
      <p class="muted"><strong>Each address is tested before it is paid.</strong>
        One unit of the token — a millionth of a ${esc(p.currency)} — is sent
        first, and the chain is checked for its arrival. Every other check tells
        us an address ought to work; only this one shows that it does. The real
        payment unlocks once the test has landed.</p>
      <p class="muted">Our fee is a payment like any other and is shown in full.
        Addresses were supplied and proved by their own owners; you are not
        asked to type any of them.</p>
    </div>

    <form method="post" id="record" action="${esc(base)}">
      <input type="hidden" name="leg" id="leg">
      <input type="hidden" name="kind" id="kind">
      <input type="hidden" name="tx_hash" id="hash">
    </form>

    ${outstanding.length && p.rail.batch ? batchCard(p) : ""}

    ${outstanding.length ? `<div class="card">
      <h2>Sent it another way?</h2>
      <p class="muted">The buttons above need a wallet in this browser. If you
        paid from a Safe, a hardware wallet through its own app, or a phone,
        make the transfer however you normally would and paste the transaction
        hash here. It is checked against the chain in exactly the same way —
        the token's own record of the transfer has to show the right amount
        reaching the right address, whatever sent it.</p>
      <form method="post" action="${esc(base)}">
        <label for="whichleg">Which payment</label>
        <select id="whichleg" name="leg" required>
          ${outstanding.map((l) => `<option value="${esc(l.participationId ?? "fee")}"
            >${esc(l.name)} — ${esc(format(l.amountMinor, p.decimals))}
             ${esc(p.currency)}</option>`).join("")}
          ${p.rail.batch ? `<option value="batch">Several of the above, in one transaction</option>` : ""}
        </select>
        <label for="kindsel">What was it</label>
        <select id="kindsel" name="kind">
          <option value="payment">The payment</option>
          <option value="test">A test payment (one unit)</option>
        </select>
        <label for="manualhash">Transaction hash</label>
        <input id="manualhash" name="tx_hash" placeholder="0x…" required
               autocomplete="off" spellcheck="false">
        <button type="submit" class="go">Check it and record it</button>
      </form>
    </div>` : ""}

    <script>${p.rail.browser.script}</script>
    <script>
    (function () {
      var wallet = window.railWallet;
      var base = ${JSON.stringify(base)};
      var hint = ${JSON.stringify(p.rail.browser.walletHint)};

      async function sign(button, kind) {
        if (!wallet || !wallet.present()) {
          alert("No wallet found in this browser (" + hint + "). You can still pay from any " +
                "wallet and record the transaction id under 'Sent it another way?'.");
          return;
        }
        button.disabled = true;
        var was = button.textContent;
        try {
          // Re-check at the moment of the click. This page may have been open
          // for hours, and an address can be frozen or a verdict withdrawn in
          // that time. The payload comes back from the server, freshly
          // checked, rather than being trusted from the rendered page.
          button.textContent = "Checking…";
          var check = await fetch(base + "/prepare", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "leg=" + encodeURIComponent(button.dataset.leg) + "&kind=" + kind,
          }).then(function (r) { return r.json(); });

          if (check.problem) {
            alert(check.problem + "\\n\\nThe page will reload with the current position.");
            location.reload();
            return;
          }

          if (!confirm("Send " + check.human + " to " + button.dataset.name +
                       "?\\n\\n" + check.to)) {
            button.textContent = was; button.disabled = false; return;
          }

          await wallet.accounts();
          await wallet.prepare();
          button.textContent = "Confirm in your wallet…";
          var hash = await wallet.send(check);

          // The wallet returns as soon as the transaction is broadcast, which
          // is well before it is in a block. Submitting then asks the chain
          // about a transaction that has not landed and gets a perfectly
          // correct "not found" — which reads as a failure when nothing has
          // failed. So wait for it here, for as long as this rail suggests.
          button.textContent = "Sent — waiting for it to land…";
          var landed = false;
          var ticks = Math.ceil((wallet.waitSeconds || 120) / 2);
          for (var i = 0; i < ticks && !landed; i++) {
            await new Promise(function (r) { setTimeout(r, 2000); });
            try { landed = await wallet.landed(hash); } catch (ignored) { /* keep waiting */ }
            if (!landed) button.textContent = "Waiting for it to land… " + ((i + 1) * 2) + "s";
          }
          if (!landed && wallet.pendingAdvice) {
            var box = document.getElementById("manualhash");
            if (box) box.value = hash;
            alert(wallet.pendingAdvice + "\\n\\nTransaction id: " + hash);
          }

          document.getElementById("leg").value = button.dataset.leg;
          document.getElementById("kind").value = kind;
          document.getElementById("hash").value = hash;
          button.textContent = landed ? "Landed — recording…"
            : "Taking a while — recording anyway…";
          document.getElementById("record").submit();
        } catch (err) {
          button.textContent = was;
          button.disabled = false;
          alert((err && (err.message || err.code)) || "Cancelled.");
        }
      }

      document.querySelectorAll("button.pay").forEach(function (b) {
        b.addEventListener("click", function () { sign(b, "payment"); });
      });

      // The whole distribution as one transaction, where the rail allows it.
      async function batch(button, kind) {
        var out = document.getElementById("batchsays");
        var psbtBox = document.getElementById("psbtbox");
        button.disabled = true;
        var was = button.textContent;
        try {
          button.textContent = "Composing…";
          var check = await fetch(base + "/prepare", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "leg=batch&kind=" + kind,
          }).then(function (r) { return r.json(); });
          if (check.problem) { out.textContent = check.problem; button.textContent = was; button.disabled = false; return; }

          var lines = check.outputs.map(function (o) {
            return "  " + (o.change ? "change back to you" : o.name) + "  " + o.human + "  " + o.to;
          }).join("\\n");
          if (!wallet || !wallet.present() || !wallet.signBatch) {
            // No wallet here: hand over the PSBT to sign elsewhere.
            psbtBox.hidden = false;
            document.getElementById("psbttext").value = check.payload.psbtBase64;
            out.textContent = "No wallet in this browser. Copy the transaction below into Sparrow " +
              "(File → Open Transaction → From Text), sign and broadcast it, then paste the " +
              "transaction id under 'Sent it another way?' choosing 'Several of the above'.";
            button.textContent = was; button.disabled = false; return;
          }
          if (!confirm(check.human + "\\n\\n" + lines + "\\n\\nSign it?")) {
            button.textContent = was; button.disabled = false; return;
          }
          await wallet.accounts();
          await wallet.prepare();
          button.textContent = "Sign in your wallet…";
          var hash = await wallet.signBatch(check.payload);

          button.textContent = "Broadcast — waiting for it to land…";
          var landed = false;
          var ticks = Math.ceil((wallet.waitSeconds || 120) / 2);
          for (var i = 0; i < ticks && !landed; i++) {
            await new Promise(function (r) { setTimeout(r, 2000); });
            try { landed = await wallet.landed(hash); } catch (ignored) {}
            if (!landed) button.textContent = "Waiting for it to land… " + ((i + 1) * 2) + "s";
          }
          if (!landed && wallet.pendingAdvice) {
            var box = document.getElementById("manualhash");
            if (box) box.value = hash;
            var sel = document.getElementById("whichleg");
            if (sel) sel.value = "batch";
            alert(wallet.pendingAdvice + "\\n\\nTransaction id: " + hash);
          }
          document.getElementById("leg").value = "batch";
          document.getElementById("kind").value = kind;
          document.getElementById("hash").value = hash;
          button.textContent = landed ? "Landed — recording…" : "Taking a while — recording anyway…";
          document.getElementById("record").submit();
        } catch (err) {
          button.textContent = was; button.disabled = false;
          out.textContent = (err && (err.message || err.code)) || "Cancelled.";
        }
      }
      var bt = document.getElementById("batchtest"), bp = document.getElementById("batchpay");
      if (bt) bt.addEventListener("click", function () { batch(bt, "test"); });
      if (bp) bp.addEventListener("click", function () { batch(bp, "payment"); });
      document.querySelectorAll("button.test").forEach(function (b) {
        b.addEventListener("click", function () { sign(b, "test"); });
      });
    })();
    </script>`;
}

/**
 * The payload for one payment, checked at the moment it is asked for.
 *
 * The rendered page is a snapshot. This is not: it re-runs the plan, so a
 * freeze, a withdrawn verdict, a screening that has gone stale or a leg
 * somebody else has already paid all stop the transaction before the wallet
 * ever opens.
 */
export async function prepare(env: Env, txId: string, legId: string,
                              kind: string): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status,
      headers: { "content-type": "application/json" } });

  const p = await plan(env, txId);
  if (legId === "batch") return json(await composeBatch(env, p, kind));
  const line = p.lines.find((l) => (l.participationId ?? "fee") === legId);
  if (!line) return json({ problem: "That payment is not part of this transaction." });
  if (!line.address) return json({ problem: "That payment has no address." });
  if (p.blocking.length) return json({ problem: p.blocking.join(" ") });

  const testing = kind === "test";

  // A missing test payment blocks the real payment, but not the test itself.
  const problems = testing
    ? line.problems.filter((x) => !x.startsWith("No test payment"))
    : line.problems;
  if (problems.length) return json({ problem: problems.join(" ") });
  if (line.paid) return json({ problem: "That payment is already recorded." });
  if (testing && line.testedHash) {
    return json({ problem: "A test payment has already reached that address." });
  }

  const amount = testing ? p.rail.dustMinor() : line.amountMinor;
  if (amount <= 0) return json({ problem: "There is no amount to send." });

  return json({
    to: line.address,
    token: p.token,
    native: Boolean(p.rail.native),
    // Ether by value; a token by calling its contract.
    value: p.rail.native ? "0x" + BigInt(amount).toString(16) : "0x0",
    data: p.rail.native ? "0x" : transferData(line.address, amount),
    amountMinor: String(amount),
    human: `${format(amount, p.decimals)} ${p.currency}`,
  });
}

/**
 * Record a test payment, once the chain shows it arrived.
 *
 * The same verification as a real leg, against one unit. It is deliberately
 * not a custody event: a test is not part of the settlement, and counting it
 * as one would make the amounts wrong.
 */
export async function recordTest(env: Env, actor: Actor, txId: string,
                                 legId: string, txHash: string): Promise<string> {
  const p = await plan(env, txId);
  if (legId === "batch") return recordBatch(env, actor, txId, p, "test", txHash);
  const line = p.lines.find((l) => (l.participationId ?? "fee") === legId);
  if (!line || !line.address) return "That payment is not part of this transaction.";
  if (line.testedHash) return "A test payment has already reached that address.";

  const shape = p.rail.hashProblem(txHash);
  if (shape) return shape;

  const moved = await p.rail.verify(env, txHash.trim(), {
    to: line.address, amountMinor: p.rail.dustMinor(),
  });
  if (!moved) return "Could not reach the chain to check that hash. Try again.";
  if (!moved.agreed) {
    return `The chain providers disagree about that transaction — ${moved.problem}.`;
  }
  if (moved.problem === "pending") {
    return "That payment has been broadcast but has not been included in a " +
           "block yet. Nothing is wrong — wait for it to confirm and record the " +
           `hash again: ${txHash.trim()}`;
  }
  if (moved.problem === "pending") {
    return "That test payment has been broadcast but has not been included in " +
           `a block yet. Wait for it to confirm and record the hash again: ${txHash.trim()}`;
  }
  if (moved.problem === "no such transaction") {
    return "No transaction with that hash. Check it, or wait for it to land.";
  }
  if (!moved.ok) {
    return "That transaction did not deliver a test payment to this address.";
  }

  await env.DB.prepare(
    `INSERT INTO address_tests (id, transaction_id, participation_id, address,
       chain_id, token, amount_minor, tx_hash, tx_block, verified_at, sent_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id("tst"), txId, line.participationId, line.address, p.chainId, p.token,
          p.rail.dustMinor(), txHash.trim(), moved.block,
          new Date().toISOString().replace("T", " ").slice(0, 19), actor.id)
    .run();
  return "";
}

/** Record a leg the sender has just sent, having checked the chain agrees. */
export async function recordLeg(env: Env, actor: Actor, txId: string,
                                legId: string, txHash: string): Promise<string> {
  const p = await plan(env, txId);
  if (legId === "batch") return recordBatch(env, actor, txId, p, "payment", txHash);
  const line = p.lines.find((l) =>
    (l.participationId ?? "fee") === legId);
  if (!line) return "That payment is not part of this transaction.";
  if (line.paid) return "That payment is already recorded.";
  if (!line.address) return "That payment has no address.";

  const shape = p.rail.hashProblem(txHash);
  if (shape) return shape;

  // A hash that exists and succeeded is not evidence that *this* payment was
  // made. Without this check any successful transaction would mark a leg paid.
  // The token's own Transfer event is the test, rather than the transaction's
  // calldata, so a payment routed through a Safe or a batch tool is recognised
  // exactly as one sent straight from a wallet.
  const moved = await p.rail.verify(env, txHash.trim(), {
    to: line.address, amountMinor: line.amountMinor,
  });
  if (!moved) return "Could not reach the chain to check that hash. Try again.";
  if (!moved.agreed) {
    return `The chain providers disagree about that transaction — ${moved.problem}.`;
  }
  if (moved.problem === "pending") {
    return "That payment has been broadcast but has not been included in a " +
           "block yet. Nothing is wrong — wait a few seconds and record the " +
           "hash again.";
  }
  if (moved.problem === "no such transaction") {
    return "No transaction with that hash. Check it, or wait for it to land.";
  }
  if (!moved.ok) {
    return `That transaction does not pay this line. It must transfer ` +
      `${format(line.amountMinor, p.decimals)} ${p.currency} to ${line.address}, ` +
      `and the chain shows no such transfer in it.`;
  }

  const result = await record(env, actor, txId, {
    holder: p.execution === "client_wallet" ? "thepaymaster_wallet" : "none",
    event: legId === "fee" ? "fee_taken" : "sent",
    amountMinor: line.amountMinor,
    currency: p.currency,
    decimals: p.decimals,
    occurredAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    txHash, chainId: p.chainId,
    // Verified above through the rail, whatever the chain; the custody record
    // must not re-check it as if every chain spoke Ethereum's JSON-RPC.
    preVerified: { block: moved.block, sources: moved.sources },
    note: p.execution === "client_wallet" ? `${line.name} — paid by ThePaymaster from the client wallet` : `${line.name} — sent by the sender`,
  });
  if (typeof result === "object") return result.problem;

  if (line.participationId) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO payout_legs (event_id, participation_id) VALUES (?, ?)")
      .bind(result, line.participationId).run();
  }
  // The stage follows the money. The first payment means settling has begun;
  // the last means it has finished. Left to a person, "ready" sat on a
  // transaction that was paid and sealed, and the sender's page said so.
  const after = await plan(env, txId);
  const outstanding = after.lines.filter((l) => !l.paid).length;
  const st = await env.DB.prepare("SELECT status FROM transactions WHERE id = ?")
    .bind(txId).first<any>();
  const advanceTo = outstanding === 0 && canMove(st?.status, "settled") ? "settled"
    : outstanding === 0 && st?.status === "ready" ? "settling"
    : st?.status === "ready" ? "settling" : null;
  if (advanceTo) {
    await update(env.DB, actor, `transaction.${advanceTo}`, "transactions", txId,
      { status: advanceTo, updated_at: new Date().toISOString().replace("T", " ").slice(0, 19) },
      { status: st.status },
      { note: outstanding === 0 ? "every payment has landed" : "first payment has landed" });
    // ready → settling → settled is two moves; take the second at once if due.
    if (advanceTo === "settling" && outstanding === 0) {
      await update(env.DB, actor, "transaction.settled", "transactions", txId,
        { status: "settled" }, { status: "settling" }, { note: "every payment has landed" });
    }
  }

  await paymentLanded(env, actor, txId, {
    participationId: line.participationId, name: line.name, amountMinor: line.amountMinor,
  }, txHash.trim(), p.rail.explorer.tx(txHash.trim()));
  return "";
}

export { plan, transferData };


// ---------------------------------------------------------------------------
// The whole distribution in one transaction
// ---------------------------------------------------------------------------

/** Which lines a batch of this kind would pay right now, and why the rest would not. */
function batchLines(p: Plan, kind: string): { lines: Line[]; skipped: string[] } {
  const testing = kind === "test";
  const lines: Line[] = [], skipped: string[] = [];
  for (const l of p.lines) {
    if (l.paid || !l.address) continue;
    const problems = testing ? l.problems.filter((x) => !x.startsWith("No test payment")) : l.problems;
    if (testing && l.testedHash) { skipped.push(`${l.name}: already tested`); continue; }
    if (!testing && !l.testedHash) { skipped.push(`${l.name}: no test payment yet`); continue; }
    if (problems.length) { skipped.push(`${l.name}: ${problems.join("; ")}`); continue; }
    lines.push(l);
  }
  return { lines, skipped };
}

/** The batch the sender's wallet will sign, composed at the moment of the click. */
async function composeBatch(env: Env, p: Plan, kind: string): Promise<unknown> {
  if (!p.rail.batch) return { problem: "This rail cannot pay several lines in one transaction." };
  if (p.blocking.length) return { problem: p.blocking.join(" ") };
  const { lines, skipped } = batchLines(p, kind);
  if (!lines.length) {
    return { problem: skipped.length
      ? `Nothing can go in a batch right now — ${skipped.join("; ")}.`
      : "Nothing left to send." };
  }
  const funder = p.funders.find((f) => f.proved);
  if (!funder) return { problem: "No proved sending wallet." };

  const testing = kind === "test";
  const composed = await p.rail.batch.compose(env, {
    from: funder.address,
    legs: lines.map((l) => ({
      ref: l.participationId ?? "fee", to: l.address!,
      amountMinor: testing ? p.rail.dustMinor() : l.amountMinor,
    })),
  });
  if (!composed.ok) return { problem: composed.why };
  const nameOf = (ref: string | null) => lines.find((l) => (l.participationId ?? "fee") === ref)?.name ?? "";
  return {
    batch: true,
    payload: composed.payload,
    txid: composed.txid,
    human: composed.human + (skipped.length ? ` Left out: ${skipped.join("; ")}.` : ""),
    outputs: composed.outputs.map((o) => ({
      name: nameOf(o.ref), to: o.to, change: o.change,
      human: `${format(Number(o.amountMinor), p.decimals)} ${p.currency}`,
    })),
  };
}

/**
 * One hash, many lines. Each outstanding line is checked against the
 * transaction's outputs on its own, and recorded on its own, so the record
 * reads exactly as it would had they been paid one at a time — with the same
 * hash on each. Lines the transaction did not pay are simply left outstanding.
 */
async function recordBatch(env: Env, actor: Actor, txId: string, p: Plan,
                           kind: string, txHash: string): Promise<string> {
  const shape = p.rail.hashProblem(txHash);
  if (shape) return shape;
  const testing = kind === "test";
  const candidates = p.lines.filter((l) => !l.paid && l.address && (testing ? !l.testedHash : true));
  if (!candidates.length) return "There is nothing outstanding for that transaction to have paid.";

  const done: string[] = [], missed: string[] = [];
  let pending = false, unreachable = false;
  for (const line of candidates) {
    const moved = await p.rail.verify(env, txHash.trim(), {
      to: line.address!, amountMinor: testing ? p.rail.dustMinor() : line.amountMinor,
    });
    if (!moved) { unreachable = true; break; }
    if (moved.problem === "pending") { pending = true; break; }
    if (!moved.ok) { missed.push(line.name); continue; }
    const legId = line.participationId ?? "fee";
    const problem = testing
      ? await recordTest(env, actor, txId, legId, txHash)
      : await recordLeg(env, actor, txId, legId, txHash);
    if (problem) missed.push(`${line.name} (${problem})`); else done.push(line.name);
  }
  if (unreachable) return "Could not reach the chain to check that transaction. Try again.";
  if (pending) {
    return "That transaction has been broadcast but has not been included in a block " +
           `yet. Nothing is wrong — wait for it to confirm and record it again: ${txHash.trim()}`;
  }
  if (!done.length) {
    return `That transaction does not pay any of the outstanding ${testing ? "test " : ""}lines. ` +
           "Each output has to carry the exact amount to the exact address.";
  }
  return `Recorded ${done.length} ${testing ? "test payment" : "payment"}${done.length === 1 ? "" : "s"} ` +
         `from that transaction: ${done.join(", ")}.` +
         (missed.length ? ` Not in it: ${missed.join(", ")}.` : "");
}

/** The card offering the whole distribution as one transaction. */
function batchCard(p: Plan): string {
  const tests = batchLines(p, "test"), pays = batchLines(p, "payment");
  return `<div class="card">
    <h2>Or pay everyone in one transaction</h2>
    <p class="muted">${esc(p.rail.name)} lets one transaction carry every payment. We compose
      it — an output for each line below, our fee among them, and any change back to your
      wallet — and your wallet signs it once. Each line is then verified against that one
      transaction and recorded exactly as if paid on its own.</p>
    <div class="row" style="gap:10px;flex-wrap:wrap">
      <button type="button" id="batchtest"${tests.lines.length && !p.blocking.length ? "" : " disabled"}
        >Test every address in one transaction (${tests.lines.length})</button>
      <button type="button" id="batchpay" class="go"${pays.lines.length && !p.blocking.length ? "" : " disabled"}
        >Pay every tested line in one transaction (${pays.lines.length})</button>
    </div>
    <p class="muted" id="batchsays" style="margin:8px 0 0">${
      !pays.lines.length && tests.lines.length ? "Tests first; the real batch unlocks once they have landed."
      : !tests.lines.length && !pays.lines.length ? "Nothing is ready to go in a batch yet." : ""}</p>
    <div id="psbtbox" hidden style="margin-top:10px">
      <label for="psbttext">The unsigned transaction (PSBT), to sign in your own wallet</label>
      <textarea id="psbttext" rows="4" readonly spellcheck="false" style="font-family:ui-monospace,monospace;font-size:12px"></textarea>
    </div>
  </div>`;
}
