/**
 * Server-rendered HTML. No framework, no build step, no client state.
 *
 * The palette is ThePaymaster's, so the panel and the public site look like
 * one company. Everything is a form post: an admin panel where every action is
 * a POST with a name attached is exactly the shape the audit log wants.
 */

import { typeName, isOnChain } from "./db.ts";
import { FAVICON, thisYear } from "./chrome.ts";
import { HELP_CSS } from "./help.ts";
import { format } from "./money.ts";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const CSS = `
:root{--ink:#0C1524;--accent:#FF8159;--panel:#F5F7FA;--text:#4A5567;--rule:#DBDFEA;--good:#1B8A5A;--warn:#B4690E}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:15px/1.55 "Plus Jakarta Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--panel)}
a{color:var(--ink)}

/* A rail down the left, and the work centred in what is left over. Wide
   screens were putting everything against the left edge and leaving half the
   window empty. */
body{display:flex;min-height:100vh;align-items:stretch}
.rail{background:var(--ink);color:#C9D1DD;width:236px;flex:0 0 236px;
  display:flex;flex-direction:column;padding:22px 0}
.rail .mark{padding:0 22px 26px}
.rail .mark img{width:158px;height:auto;display:block}
.rail nav{display:flex;flex-direction:column}
.rail a{color:#C9D1DD;text-decoration:none;font-weight:600;font-size:14.5px;
  padding:10px 22px;border-left:3px solid transparent}
.rail a:hover{color:#fff;background:#131F33}
.rail a[aria-current]{color:#fff;background:#131F33;border-left-color:var(--accent)}
.rail .who{margin-top:auto;padding:18px 22px 0;border-top:1px solid #1E2A3C;
  font-size:13px;color:#8C99AC}
.rail .who b{display:block;color:#fff;font-size:14px;margin-bottom:8px;font-weight:700}
.rail .who a{display:block;padding:5px 0;border-left:0;font-size:13.5px}
.rail .who a:hover{background:none;color:var(--accent)}
.sheet{flex:1;min-width:0;display:flex;flex-direction:column}
main{flex:1;width:100%;max-width:1060px;margin:0 auto;padding:30px 26px 40px}
.panelfoot{padding:16px 26px 24px;text-align:center;font-size:13px;color:#8C99AC}
@media(max-width:860px){
  body{display:block}
  .rail{width:auto;flex:none;flex-direction:row;flex-wrap:wrap;align-items:center;
    gap:2px;padding:12px 14px}
  .rail .mark{padding:0 14px 0 0}
  .rail .mark img{width:118px}
  .rail nav{flex-direction:row;flex-wrap:wrap}
  .rail a{padding:7px 11px;border-left:0;border-bottom:3px solid transparent;font-size:13.5px}
  .rail a[aria-current]{border-left:0;border-bottom-color:var(--accent)}
  .rail .who{margin:0 0 0 auto;padding:0 0 0 12px;border:0}
  .rail .who b{display:inline;margin:0}
  .rail .who a{display:inline;padding:0 0 0 10px}
  main{padding:20px 16px 30px}
}
h1{margin:0 0 18px;font-size:26px;font-weight:800;color:var(--ink);letter-spacing:-.01em}
h2{margin:26px 0 10px;font-size:15px;color:var(--ink);text-transform:uppercase;letter-spacing:.07em}
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;align-items:start}
.col{background:#fff;border:1px solid var(--rule);border-radius:14px;min-height:90px}
.col h3{margin:0;padding:11px 13px;font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink);border-bottom:1px solid var(--rule)}
.col .n{float:right;color:var(--text);font-weight:600}
.card{display:block;padding:11px 13px;border-bottom:1px solid var(--rule);text-decoration:none}
.card:last-child{border-bottom:0}
.card:hover{background:var(--panel)}
.card .ref{font-size:11.5px;font-weight:700;color:var(--accent);letter-spacing:.04em}
.card .nm{color:var(--ink);font-weight:600;margin:2px 0}
.card .ty{font-size:12px}
.panel{background:#fff;border:1px solid var(--rule);border-radius:14px;padding:18px 20px;margin-bottom:16px;max-width:900px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink)}
tr:last-child td{border-bottom:0}
.tag{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11.5px;font-weight:700;background:var(--panel);color:var(--ink);border:1px solid var(--rule)}
.tag.chain{background:#FFF1EB;border-color:var(--accent);color:#8A3B1E}
label{display:block;margin:12px 0 4px;font-size:13px;font-weight:600;color:var(--ink)}
input,select,textarea{width:100%;max-width:420px;padding:9px 11px;border:1px solid var(--rule);border-radius:8px;font:inherit;background:#fff}
button.go{background:var(--accent);color:var(--ink);border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer}
button.plain{background:#fff;border:1px solid var(--rule);border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:14px}
.muted{color:var(--text);font-size:13px}
.log{font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

/* Wide tables scroll inside their panel rather than pushing through the side
   of it. The audit log carries 64-character hashes, which are one unbroken
   word and will widen any container given the chance. */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.scroll > table{min-width:760px}
/* A timestamp broken over three lines is unreadable; a hash may break
   anywhere, because there is no good place. */
.log td:first-child,.log th:first-child{white-space:nowrap}
.log td:last-child{overflow-wrap:anywhere;word-break:break-word;max-width:420px}
.panel{overflow:hidden}
/* Any table inside a full-width panel gets the same treatment as the audit
   log: it scrolls rather than escaping, and addresses may break. */
.panel > table,.panel > form > table{display:block;overflow-x:auto;max-width:100%}
.panel td .mono,.panel td code{overflow-wrap:anywhere}
.log td{padding:5px 10px}
.good{color:#1B7F4B;font-weight:600}
.warn{color:#9A6700;font-weight:600}
.bad{color:#8A1F11;font-weight:600}
.doc{max-width:900px}
.dochead{border-bottom:2px solid #1B2430;padding-bottom:12px;margin-bottom:18px}
.dochead .ref{font-size:19px;font-weight:700;margin:2px 0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.mono.big{font-size:14px}
.fact{border-top:1px solid #E6EAF0;padding:11px 0}
.fact h3{font-size:14px;margin:0 0 6px}
table.kv{border-collapse:collapse;width:100%}
table.kv th{text-align:left;width:210px;vertical-align:top;font-weight:600;color:#5A6B80;padding:3px 10px 3px 0;font-size:13px}
table.kv td{padding:3px 0;font-size:13px}
.leaf{color:#8A97A8;margin:6px 0 0}
.group h2,.seal h2,.howto h2{font-size:16px;margin:22px 0 4px}
.howto ol{padding-left:20px}.howto li{margin-bottom:7px}
@media print{
  header,.noprint,form{display:none!important}
  body{background:#fff}main{padding:0}
  .panel{border:none;padding:0}
  .fact{break-inside:avoid}
  a{color:inherit;text-decoration:none}
}
.err{background:#FDECEA;border:1px solid #F5C2BC;color:#8A1F11;padding:10px 13px;border-radius:8px;margin-bottom:14px;max-width:420px}
.login{max-width:340px;margin:9vh auto}
`;

/** The one line of footer an internal panel needs. */
export function panelFoot(): string {
  return `<div class="panelfoot">&copy; ThePaymaster Ltd &reg; ${thisYear()} ` +
         `All Rights Reserved</div>`;
}

export function page(title: string, body: string, opts: { nav?: string } = {}): Response {
  return new Response(`<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ThePaymaster admin</title>
<meta name="robots" content="noindex,nofollow">${FAVICON}
<link rel="stylesheet" href="https://thepaymaster.co.uk/wp-content/uploads/elementor/google-fonts/css/plusjakartasans.css">
<style>${CSS}${HELP_CSS}</style></head><body>${opts.nav ?? ""}
<div class="sheet"><main>${body}</main>${panelFoot()}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function nav(current: string, who: string): string {
  const item = (href: string, label: string) =>
    `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  return `<aside class="rail">
    <div class="mark"><img
      src="https://thepaymaster.co.uk/wp-content/uploads/2024/05/b-logo.png"
      alt="ThePaymaster" width="158" height="45"></div>
    <nav>
      ${item("/", "Pipeline")}
      ${item("/enquiries", "Enquiries")}
      ${item("/kyc", "Verification")}
      ${item("/new", "New transaction")}
      ${item("/log", "Audit log")}
      ${item("/chain", "Chain")}
      ${item("/providers", "Providers")}
      ${item("/help", "Help")}
    </nav>
    <div class="who"><b>${esc(who)}</b>
      ${item("/account", "Your password")}<a href="/signout">Sign out</a></div>
  </aside>`;
}

const COLUMNS: [string, string][] = [
  ["draft", "Draft"], ["awaiting_parties", "Awaiting parties"], ["kyc", "KYC"],
  ["ready", "Ready"], ["settling", "Settling"], ["settled", "Settled"],
];

export interface Row {
  id: string; ref: string; name: string; status: string;
  inbound: string; outbound: string; converts: number;
  currency_in: string; decimals_in: number; gross_expected_minor: number | null;
}

export function board(rows: Row[]): string {
  const cols = COLUMNS.map(([key, label]) => {
    const mine = rows.filter((r) => r.status === key);
    const cards = mine.map((r) => `<a class="card" href="/t/${esc(r.id)}">
      <div class="ref">${esc(r.ref)}</div>
      <div class="nm">${esc(r.name)}</div>
      <div class="ty muted">${esc(typeName(r))}${isOnChain(r) ? ' <span class="tag chain">on-chain</span>' : ""}</div>
      ${r.gross_expected_minor ? `<div class="ty">${esc(r.currency_in)} ${format(r.gross_expected_minor, r.decimals_in)}</div>` : ""}
    </a>`).join("");
    return `<div class="col"><h3>${label}<span class="n">${mine.length}</span></h3>${cards}</div>`;
  }).join("");

  const dead = rows.filter((r) => ["closed", "abandoned", "declined"].includes(r.status));
  const deadList = dead.length
    ? `<h2>Closed, abandoned and declined</h2><div class="panel"><table>
       ${dead.map((r) => `<tr><td><a href="/t/${esc(r.id)}">${esc(r.ref)}</a></td>
       <td>${esc(r.name)}</td><td><span class="tag">${esc(r.status)}</span></td></tr>`).join("")}
       </table></div>`
    : "";

  return `<h1>Pipeline</h1><div class="board">${cols}</div>${deadList}`;
}


/**
 * The show-and-hide eye on password fields, shared by staff and client screens.
 *
 * Wrap any password input in <div class="pw"> and this attaches the toggle. It
 * only changes the field's type — nothing is submitted or stored differently —
 * and it exists because people mistype long passwords, and a colleague behind
 * you is a smaller risk than a lockout.
 *
 * The icon carries an accessible label that changes with it, so it is not a
 * mystery button to anyone using a screen reader.
 */
export const REVEAL_CSS = `
.pw{position:relative}
.pw input{padding-right:48px}
.pw .eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:0;padding:7px;cursor:pointer;color:#4A5567;border-radius:7px;line-height:0}
.pw .eye:hover{background:#F5F7FA;color:#0C1524}
.pw .eye:focus-visible{outline:2px solid #FF8159;outline-offset:1px}
.pw .eye svg{width:20px;height:20px;display:block;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
`;

export const REVEAL_JS = `
<script>
(function () {
  var OPEN  = '<path d="M1.8 12S5.4 5.8 12 5.8 22.2 12 22.2 12 18.6 18.2 12 18.2 1.8 12 1.8 12Z"/><circle cx="12" cy="12" r="3.1"/>';
  var SHUT  = '<path d="M1.8 12S5.4 5.8 12 5.8 22.2 12 22.2 12 18.6 18.2 12 18.2 1.8 12 1.8 12Z"/><circle cx="12" cy="12" r="3.1"/><path d="M4 20 20 4"/>';
  function svg(paths) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>';
  }
  document.querySelectorAll('.pw').forEach(function (wrap) {
    var field = wrap.querySelector('input');
    if (!field) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'eye';
    btn.innerHTML = svg(SHUT);
    btn.setAttribute('aria-label', 'Show password');
    btn.addEventListener('click', function () {
      var showing = field.type === 'text';
      field.type = showing ? 'password' : 'text';
      btn.innerHTML = svg(showing ? SHUT : OPEN);
      btn.setAttribute('aria-label', (showing ? 'Show' : 'Hide') + ' password');
      field.focus();
    });
    wrap.appendChild(btn);
  });
})();
</script>`;
