/**
 * Server-rendered HTML. No framework, no build step, no client state.
 *
 * The palette is ThePaymaster's, so the panel and the public site look like
 * one company. Everything is a form post: an admin panel where every action is
 * a POST with a name attached is exactly the shape the audit log wants.
 */

import { typeName, isOnChain } from "./db.ts";
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
header{background:var(--ink);color:#fff;padding:0 22px;display:flex;align-items:center;gap:22px;height:56px}
header b{font-weight:800;letter-spacing:-.01em}
header a{color:#B6C0D0;text-decoration:none;font-weight:600;font-size:14px}
header a:hover,header a[aria-current]{color:var(--accent)}
header form{margin-left:auto}
header button{background:none;border:0;color:#B6C0D0;font:inherit;font-weight:600;font-size:14px;cursor:pointer}
main{padding:24px}
h1{margin:0 0 18px;font-size:22px;color:var(--ink);letter-spacing:-.01em}
h2{margin:26px 0 10px;font-size:15px;color:var(--ink);text-transform:uppercase;letter-spacing:.07em}
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px;align-items:start}
.col{background:#fff;border:1px solid var(--rule);border-radius:10px;min-height:90px}
.col h3{margin:0;padding:11px 13px;font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink);border-bottom:1px solid var(--rule)}
.col .n{float:right;color:var(--text);font-weight:600}
.card{display:block;padding:11px 13px;border-bottom:1px solid var(--rule);text-decoration:none}
.card:last-child{border-bottom:0}
.card:hover{background:var(--panel)}
.card .ref{font-size:11.5px;font-weight:700;color:var(--accent);letter-spacing:.04em}
.card .nm{color:var(--ink);font-weight:600;margin:2px 0}
.card .ty{font-size:12px}
.panel{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:18px 20px;margin-bottom:16px;max-width:900px}
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
.log td{padding:5px 10px}
.err{background:#FDECEA;border:1px solid #F5C2BC;color:#8A1F11;padding:10px 13px;border-radius:8px;margin-bottom:14px;max-width:420px}
.login{max-width:340px;margin:9vh auto}
`;

export function page(title: string, body: string, opts: { nav?: string } = {}): Response {
  return new Response(`<!doctype html><html lang="en-GB"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ThePaymaster admin</title>
<meta name="robots" content="noindex,nofollow">
<link rel="stylesheet" href="https://thepaymaster.co.uk/wp-content/uploads/elementor/google-fonts/css/plusjakartasans.css">
<style>${CSS}</style></head><body>${opts.nav ?? ""}<main>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function nav(current: string, who: string): string {
  const item = (href: string, label: string) =>
    `<a href="${href}"${current === href ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header><b>ThePaymaster</b>${item("/", "Pipeline")}${item("/enquiries", "Enquiries")}${item("/new", "New transaction")}${item("/log", "Audit log")}
    <form method="post" action="/logout"><button>${esc(who)} — sign out</button></form></header>`;
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
