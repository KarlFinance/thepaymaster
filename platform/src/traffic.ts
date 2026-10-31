/**
 * Website traffic: who visits thepaymaster.co.uk, from where, what they read,
 * and which visits became enquiries.
 *
 * The router worker in front of the site writes one row per page view into
 * traffic_hits and puts a small beacon in each page. Three kinds of view:
 *
 *   people       the beacon reported back (a real browser ran the page) and
 *                nothing marks it as a bot
 *   bots         the user agent names a crawler, or it came from a data centre
 *   unconfirmed  HTML fetched, beacon never reported: mostly bots that do not
 *                say so, plus a few people who left at once or block scripts
 *
 * A visitor is a hash of the day's salt, the IP and the user agent, so one
 * person is one visitor for a day and is never followed beyond it. No IP is
 * kept. Forms store the same hash, which is how an enquiry is traced back to
 * the visit that led to it.
 *
 * History from before this existed comes from Cloudflare's own analytics,
 * when a read-only Cloudflare API token is stored as CF_ANALYTICS_TOKEN.
 */

import { type Env } from "./db.ts";
import { page, nav, esc } from "./views.ts";

// ---------------------------------------------------------------------------
// The visitor id, identical to the router's.
// ---------------------------------------------------------------------------

async function daySalt(env: Env, day: string): Promise<string> {
  const fresh = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT OR IGNORE INTO traffic_salts (day, salt) VALUES (?, ?)").bind(day, fresh).run();
  const row = await env.DB.prepare("SELECT salt FROM traffic_salts WHERE day = ?").bind(day).first<any>();
  return row.salt;
}

/** This request's visitor id for today; null if it cannot be worked out. Never throws. */
export async function visitorId(env: Env, request: Request): Promise<string | null> {
  try {
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    const ua = request.headers.get("User-Agent") ?? "";
    const salt = await daySalt(env, new Date().toISOString().slice(0, 10));
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}|${ua}`));
    return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Where a visit came from.
// ---------------------------------------------------------------------------

const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.com|ecosia\.org|baidu\.com|yandex\.[a-z]+|search\.brave\.com|startpage\.com|qwant\.com|googlequicksearchbox)$/i;
const SOCIAL = /(^|\.)(linkedin\.com|lnkd\.in|facebook\.com|fb\.com|instagram\.com|t\.co|x\.com|twitter\.com|youtube\.com|reddit\.com|tiktok\.com|whatsapp\.com|wa\.me|telegram\.org|t\.me)$/i;
const EMAIL = /sendibm|sendinblue|brevo|mailchimp|list-manage|mail\.google|outlook\.|office\.net|safelinks|mimecast|proofpoint|hubspotemail|hs-sites|campaign-archive/i;
const AI = /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com|poe\.com)$/i;

export function channel(refHost: string | null, utmSource: string | null, utmMedium: string | null): string {
  const m = (utmMedium ?? "").toLowerCase(), s = (utmSource ?? "").toLowerCase();
  if (m === "email" || m === "newsletter" || EMAIL.test(s)) return "Email";
  if (m === "cpc" || m === "ppc" || m === "paid" || m === "paidsearch") return "Paid";
  if (m === "social" || SOCIAL.test(s)) return "Social";
  if (!refHost) return s ? "Campaign" : "Direct";
  if (/(^|\.)thepaymaster\.co\.uk$/i.test(refHost)) return "Direct";
  if (SEARCH.test(refHost)) return "Search";
  if (AI.test(refHost)) return "AI assistants";
  if (SOCIAL.test(refHost)) return "Social";
  if (EMAIL.test(refHost)) return "Email";
  return "Referral";
}

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

const PEOPLE = "js = 1 AND bot IS NULL";
const RANGES: [number, string][] = [[1, "Today"], [7, "7 days"], [30, "30 days"], [90, "90 days"]];

const n = (v: unknown) => Number(v ?? 0);
const fmt = (v: number) => v.toLocaleString("en-GB");
const secs = (ms: number) => !ms ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const FLAGS = (cc: string | null) => !cc || cc.length !== 2 || cc === "XX" || cc === "T1" ? "" :
  String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const COUNTRY = (() => { try { return new Intl.DisplayNames(["en-GB"], { type: "region" }); } catch { return null; } })();
const countryName = (cc: string | null) => { if (!cc) return "Unknown"; try { return COUNTRY?.of(cc) ?? cc; } catch { return cc; } };

function delta(now: number, before: number): string {
  if (!before && !now) return "";
  if (!before) return `<span class="up">new</span>`;
  const d = Math.round(((now - before) / before) * 100);
  return d === 0 ? `<span class="flat">same as before</span>`
    : `<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d)}% on the previous period</span>`;
}

function bars(rows: { k: string; v: number }[], total: number, opts: { flag?: boolean; label?: (k: string) => string } = {}): string {
  if (!rows.length) return `<p class="muted">Nothing yet.</p>`;
  const max = Math.max(...rows.map((r) => r.v), 1);
  return `<div class="bars">${rows.map((r) => `<div class="bar"><span class="lbl">${opts.flag ? FLAGS(r.k) + " " : ""}${esc(opts.label ? opts.label(r.k) : r.k || "Unknown")}</span>
    <span class="track"><span style="width:${Math.max(2, (r.v / max) * 100)}%"></span></span><span class="num">${fmt(r.v)}<em>${pct(r.v, total)}</em></span></div>`).join("")}</div>`;
}

function dailyChart(days: string[], series: Record<string, Record<string, number>>): string {
  const W = 860, H = 210, P = { l: 40, r: 10, t: 10, b: 28 };
  const keys: [string, string, string][] = [["people", "People", "#FF8159"], ["unconfirmed", "Unconfirmed", "#C9D1DD"], ["bots", "Bots and crawlers", "#0C1524"]];
  const totals = days.map((d) => keys.reduce((a, [k]) => a + (series[k][d] ?? 0), 0));
  const max = Math.max(...totals, 1);
  // Four gridlines on round numbers: a step of 1, 2 or 5 times a power of ten.
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const top = step * 4;
  const bw = (W - P.l - P.r) / days.length;
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - v / top);
  let svg = "";
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i, yy = y(v);
    svg += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}" stroke="#DBDFEA" stroke-width="1"/><text x="${P.l - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#4A5567">${fmt(Math.round(v))}</text>`;
  }
  days.forEach((d, i) => {
    let base = 0;
    for (const [k, label, colour] of keys) {
      const v = series[k][d] ?? 0;
      if (!v) continue;
      const y1 = y(base + v), y0 = y(base);
      svg += `<rect x="${P.l + i * bw + 1}" y="${y1}" width="${Math.max(1, bw - 2)}" height="${Math.max(0.5, y0 - y1)}" fill="${colour}"><title>${d}: ${fmt(v)} ${label.toLowerCase()}</title></rect>`;
      base += v;
    }
    const every = Math.ceil(days.length / 10);
    if (i % every === 0) svg += `<text x="${P.l + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#4A5567">${d.slice(5)}</text>`;
  });
  const legend = keys.map(([, label, c]) => `<span><i style="background:${c}"></i>${label}</span>`).join("");
  return `<div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Page views per day, people against bots" style="width:100%;height:auto">${svg}</svg>`;
}

const CSS = `
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:18px;max-width:1200px}
.tile{background:#fff;border:1px solid var(--rule);border-radius:14px;padding:14px 16px}
.tile b{display:block;font-size:26px;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.tile .k{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink);font-weight:700}
.tile small{display:block;font-size:12px;color:var(--text);margin-top:2px}
.up{color:var(--good)}.down{color:#B3261E}.flat{color:var(--text)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;max-width:1200px}
.grid2 .panel{max-width:none;margin:0}
.wide{max-width:1200px}.wide > table{display:table;width:100%}
.bars{display:flex;flex-direction:column;gap:6px}
.bar{display:grid;grid-template-columns:minmax(120px,38%) 1fr auto;gap:10px;align-items:center;font-size:13.5px}
.bar .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.bar .track{background:var(--panel);border-radius:4px;height:10px;overflow:hidden}.bar .track span{display:block;height:100%;background:var(--accent);border-radius:4px}
.bar .num{font-variant-numeric:tabular-nums;font-weight:700;color:var(--ink);min-width:70px;text-align:right}.bar .num em{font-style:normal;font-weight:400;color:var(--text);font-size:12px;margin-left:6px}
.legend{display:flex;gap:16px;font-size:12.5px;margin-bottom:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.ranges{display:flex;gap:8px;margin:0 0 16px}.ranges a{padding:6px 12px;border:1px solid var(--rule);border-radius:20px;text-decoration:none;font-size:13px;background:#fff}
.ranges a[aria-current]{background:var(--ink);color:#fff;border-color:var(--ink)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.path{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.trail{font-size:12.5px;color:var(--text)}.trail b{color:var(--ink);font-weight:600}
.note{font-size:13px;color:var(--text);max-width:900px}`;

export async function trafficPage(env: Env, admin: { name: string }, url: URL): Promise<Response> {
  const days = RANGES.some(([d]) => d === Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const since = `datetime('now', '-${days} days')`;
  const before = `datetime('now', '-${days * 2} days')`;
  const db = env.DB;
  const all = async (sql: string, ...b: unknown[]) => ((await db.prepare(sql).bind(...b).all<any>()).results ?? []);
  const one = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<any>()) ?? {};

  const started = await one("SELECT min(at) AS first, count(*) AS n FROM traffic_hits");

  // Headline, this period against the one before.
  const head = async (from: string, to: string) => one(
    `SELECT count(DISTINCT CASE WHEN ${PEOPLE} THEN visitor END) AS visitors,
            sum(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS views,
            avg(CASE WHEN ${PEOPLE} AND engaged_ms > 0 THEN engaged_ms END) AS engaged,
            avg(CASE WHEN ${PEOPLE} THEN scroll_pct END) AS scroll,
            sum(CASE WHEN bot IS NOT NULL THEN 1 ELSE 0 END) AS bots,
            sum(CASE WHEN js = 0 AND bot IS NULL THEN 1 ELSE 0 END) AS unconfirmed,
            count(*) AS total
       FROM traffic_hits WHERE at >= ${from} AND at < ${to}`);
  const [now, prev] = await Promise.all([head(since, "datetime('now')"), head(before, since)]);
  const enquiries = async (from: string, to: string) => n((await one(
    `SELECT count(*) AS n FROM enquiries WHERE created_at >= ${from} AND created_at < ${to}
        AND id NOT IN (SELECT enquiry_id FROM site_forms WHERE status = 'spam' AND enquiry_id IS NOT NULL)`)).n);
  const [enqNow, enqPrev] = await Promise.all([enquiries(since, "datetime('now')"), enquiries(before, since)]);

  // Per day.
  const daily = await all(
    `SELECT date(at) AS d, sum(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS people,
            sum(CASE WHEN js = 0 AND bot IS NULL THEN 1 ELSE 0 END) AS unconfirmed,
            sum(CASE WHEN bot IS NOT NULL THEN 1 ELSE 0 END) AS bots
       FROM traffic_hits WHERE at >= ${since} GROUP BY d ORDER BY d`);
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const series: Record<string, Record<string, number>> = { people: {}, unconfirmed: {}, bots: {} };
  for (const r of daily) for (const k of ["people", "unconfirmed", "bots"]) series[k][r.d] = n(r[k]);

  // Each person's visit: entry page, source, pages, time.
  const visits = await all(
    `SELECT visitor, min(at) AS first_at, max(at) AS last_at, count(*) AS views, sum(coalesce(engaged_ms,0)) AS engaged,
            group_concat(path, ' › ') AS trail,
            (SELECT h2.ref_host FROM traffic_hits h2 WHERE h2.visitor = h.visitor ORDER BY h2.at LIMIT 1) AS ref_host,
            (SELECT h2.referrer FROM traffic_hits h2 WHERE h2.visitor = h.visitor ORDER BY h2.at LIMIT 1) AS referrer,
            (SELECT h2.utm_source FROM traffic_hits h2 WHERE h2.visitor = h.visitor ORDER BY h2.at LIMIT 1) AS utm_source,
            (SELECT h2.utm_medium FROM traffic_hits h2 WHERE h2.visitor = h.visitor ORDER BY h2.at LIMIT 1) AS utm_medium,
            (SELECT h2.utm_campaign FROM traffic_hits h2 WHERE h2.visitor = h.visitor ORDER BY h2.at LIMIT 1) AS utm_campaign,
            (SELECT h2.path FROM traffic_hits h2 WHERE h2.visitor = h.visitor ORDER BY h2.at LIMIT 1) AS entry,
            max(country) AS country, max(city) AS city, max(device) AS device, max(browser) AS browser, max(os) AS os
       FROM (SELECT * FROM traffic_hits WHERE ${PEOPLE} AND at >= ${since} ORDER BY at) h
      GROUP BY visitor ORDER BY first_at DESC`);
  const channels = new Map<string, number>(), refs = new Map<string, number>(), campaigns = new Map<string, number>(), entries = new Map<string, number>();
  for (const v of visits) {
    const c = channel(v.ref_host, v.utm_source, v.utm_medium);
    v.channel = c;
    channels.set(c, (channels.get(c) ?? 0) + 1);
    if (v.ref_host && !/thepaymaster\.co\.uk$/.test(v.ref_host)) refs.set(v.ref_host, (refs.get(v.ref_host) ?? 0) + 1);
    if (v.utm_campaign || v.utm_source) {
      const k = [v.utm_source, v.utm_medium, v.utm_campaign].filter(Boolean).join(" / ");
      campaigns.set(k, (campaigns.get(k) ?? 0) + 1);
    }
    entries.set(v.entry, (entries.get(v.entry) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, k = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([k, v]) => ({ k, v }));
  const visitorsN = visits.length;

  // Pages.
  const pages = await all(
    `SELECT path, sum(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS views,
            count(DISTINCT CASE WHEN ${PEOPLE} THEN visitor END) AS visitors,
            avg(CASE WHEN ${PEOPLE} AND engaged_ms > 0 THEN engaged_ms END) AS engaged,
            avg(CASE WHEN ${PEOPLE} THEN scroll_pct END) AS scroll,
            sum(CASE WHEN bot IS NOT NULL OR js = 0 THEN 1 ELSE 0 END) AS other,
            max(CASE WHEN bot = 'Google' THEN at END) AS google_at
       FROM traffic_hits WHERE at >= ${since} GROUP BY path ORDER BY views DESC, other DESC LIMIT 40`);

  // Audience.
  const dim = async (col: string, k = 10) => (await all(
    `SELECT coalesce(${col}, 'Unknown') AS k, count(DISTINCT visitor) AS v FROM traffic_hits
      WHERE ${PEOPLE} AND at >= ${since} GROUP BY k ORDER BY v DESC LIMIT ${k}`)).map((r: any) => ({ k: String(r.k), v: n(r.v) }));
  const [countries, cities, devices, browsers, oses, screens, langs] = await Promise.all([
    dim("country", 12), dim("city || ', ' || coalesce(country,'')", 10), dim("device", 4), dim("browser", 6), dim("os", 6), dim("screen", 8), dim("lang", 8)]);

  // Bots.
  const bots = await all(
    `SELECT bot, count(*) AS v, max(at) AS last_at, count(DISTINCT path) AS pages FROM traffic_hits
      WHERE bot IS NOT NULL AND at >= ${since} GROUP BY bot ORDER BY v DESC LIMIT 20`);
  const unconfirmedOrgs = await all(
    `SELECT coalesce(as_org, 'Unknown network') AS k, count(*) AS v FROM traffic_hits
      WHERE js = 0 AND bot IS NULL AND at >= ${since} GROUP BY k ORDER BY v DESC LIMIT 8`);
  const google = await one(
    `SELECT count(*) AS crawls, count(DISTINCT path) AS pages, max(at) AS last_at FROM traffic_hits WHERE bot = 'Google' AND at >= ${since}`);
  const fromSearch = visits.filter((v: any) => v.channel === "Search");

  // Enquiries traced to their visit.
  const traced = await all(
    `SELECT e.id, e.created_at, e.name, e.source, e.visitor, e.status FROM enquiries e
      WHERE e.created_at >= ${since} ORDER BY e.created_at DESC LIMIT 30`);
  const sf = await all(`SELECT enquiry_id, visitor, status FROM site_forms WHERE created_at >= ${since}`);
  const sfBy = new Map(sf.map((r: any) => [r.enquiry_id, r]));
  const visitBy = new Map(visits.map((v: any) => [v.visitor, v]));
  for (const e of traced) {
    const s = sfBy.get(e.id) as any;
    e.v = e.visitor ?? s?.visitor ?? null;
    e.spam = s?.status === "spam";
    e.visit = e.v ? visitBy.get(e.v) : null;
  }

  // Only enquiries traced to a recorded visit count towards the rate: the
  // others came before recording began, or without visiting the site.
  const tracedN = traced.filter((e: any) => e.visit && !e.spam).length;

  // Cloudflare history (before our own log began), when a token is set.
  const cf = await cloudflareHistory(env);

  // --- render ---
  const tile = (k: string, v: string, small = "") => `<div class="tile"><span class="k">${k}</span><b>${v}</b>${small ? `<small>${small}</small>` : ""}</div>`;
  const total = n(now.total);
  const people = n(now.views);
  const ranges = RANGES.map(([d, l]) => `<a href="/traffic?days=${d}"${d === days ? ' aria-current="page"' : ""}>${l}</a>`).join("");
  const fresh = !n(started.n);

  const body = `
  <style>${CSS}</style>
  <h1>Traffic</h1>
  <p class="note">Every page view on thepaymaster.co.uk, recorded by the site itself. <b>People</b> are views where a real browser ran the page. <b>Bots</b> named themselves or came from a data centre. <b>Unconfirmed</b> views fetched the page but never ran it: mostly bots that do not say so. Times are UTC. ${started.first ? `Recording since ${esc(String(started.first).slice(0, 16))}.` : ""}</p>
  ${fresh ? `<div class="panel"><b>Recording has just started.</b> Figures appear here as people visit the site. Cloudflare's history from before this is further down.</div>` : ""}
  <div class="ranges">${ranges}</div>
  <div class="tiles">
    ${tile("Visitors", fmt(visitorsN), delta(visitorsN, n(prev.visitors)))}
    ${tile("Page views by people", fmt(people), delta(people, n(prev.views)))}
    ${tile("Pages per visit", visitorsN ? (people / visitorsN).toFixed(1) : "—")}
    ${tile("Time on a page", secs(n(now.engaged)), "average time the page was looked at")}
    ${tile("Read down the page", now.scroll != null ? `${Math.round(n(now.scroll))}%` : "—", "average scroll depth")}
    ${tile("Enquiries", fmt(enqNow), `${delta(enqNow, enqPrev)}${visitorsN ? `<br>${pct(tracedN, visitorsN)} of visitors enquired` : ""}`)}
    ${tile("Bots and crawlers", pct(n(now.bots), total), `${fmt(n(now.bots))} of ${fmt(total)} page views`)}
    ${tile("Unconfirmed", pct(n(now.unconfirmed), total), `${fmt(n(now.unconfirmed))} page views`)}
  </div>

  <div class="panel wide"><h2 style="margin-top:0">Page views per day</h2>${dailyChart(dayList, series)}</div>

  <div class="grid2">
    <div class="panel"><h2 style="margin-top:0">How people found the site</h2>${bars(top(channels), visitorsN)}
      <p class="muted" style="margin-top:10px">By the first page of each visit. Direct means typed in, bookmarked, or a link with no referrer such as an app or a PDF.</p></div>
    <div class="panel"><h2 style="margin-top:0">Referring sites</h2>${bars(top(refs, 12), visitorsN)}</div>
    <div class="panel"><h2 style="margin-top:0">Campaigns</h2>${campaigns.size ? bars(top(campaigns, 10), visitorsN) : `<p class="muted">No tagged links yet. Add <span class="path">?utm_source=…&amp;utm_medium=…&amp;utm_campaign=…</span> to links in emails, posts and adverts and they appear here.</p>`}</div>
    <div class="panel"><h2 style="margin-top:0">Landing pages</h2>${bars(top(entries, 12), visitorsN)}</div>
  </div>

  <div class="panel wide"><h2 style="margin-top:0">Pages</h2>
    <table><tr><th>Page</th><th class="n">Views</th><th class="n">Visitors</th><th class="n">Time on page</th><th class="n">Read</th><th class="n">Bots &amp; unconfirmed</th><th>Google last crawled</th></tr>
    ${pages.map((p: any) => `<tr><td class="path"><a href="https://thepaymaster.co.uk${esc(p.path)}" target="_blank" rel="noopener">${esc(p.path)}</a></td>
      <td class="n">${fmt(n(p.views))}</td><td class="n">${fmt(n(p.visitors))}</td><td class="n">${secs(n(p.engaged))}</td>
      <td class="n">${p.scroll != null ? Math.round(n(p.scroll)) + "%" : "—"}</td><td class="n">${fmt(n(p.other))}</td>
      <td class="muted">${p.google_at ? esc(String(p.google_at).slice(0, 16)) : "not in this period"}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">Nothing yet.</td></tr>`}
    </table></div>

  <div class="panel wide"><h2 style="margin-top:0">Enquiries and the visits behind them</h2>
    <table><tr><th>When</th><th>Who</th><th>Came from</th><th>Landed on</th><th>Pages before</th><th class="n">Time</th></tr>
    ${traced.map((e: any) => `<tr><td class="muted">${esc(String(e.created_at).slice(0, 16))}</td>
      <td><a href="/e/${esc(e.id)}">${esc(e.name)}</a><div class="muted">${esc(e.source ?? "")}${e.spam ? ' <span class="tag">spam</span>' : ""}</div></td>
      ${e.visit ? `<td>${esc(e.visit.channel)}${e.visit.ref_host ? `<div class="muted">${esc(e.visit.ref_host)}</div>` : ""}${e.visit.utm_campaign ? `<div class="muted">${esc(e.visit.utm_campaign)}</div>` : ""}</td>
        <td class="path">${esc(e.visit.entry)}</td><td class="trail">${esc(String(e.visit.trail).slice(0, 220))}</td><td class="n">${secs(n(e.visit.engaged))}</td>`
        : `<td colspan="4" class="muted">${e.v ? "No page views recorded for this visitor (a bot, or scripts blocked)." : "Before visits were recorded, or sent without visiting the site."}</td>`}</tr>`).join("") || `<tr><td colspan="6" class="muted">No enquiries in this period.</td></tr>`}
    </table></div>

  <div class="grid2">
    <div class="panel"><h2 style="margin-top:0">Countries</h2>${bars(countries, visitorsN, { flag: true, label: countryName })}</div>
    <div class="panel"><h2 style="margin-top:0">Cities</h2>${bars(cities, visitorsN)}</div>
    <div class="panel"><h2 style="margin-top:0">Devices</h2>${bars(devices, visitorsN)}<h2>Browsers</h2>${bars(browsers, visitorsN)}</div>
    <div class="panel"><h2 style="margin-top:0">Operating systems</h2>${bars(oses, visitorsN)}<h2>Languages</h2>${bars(langs, visitorsN)}</div>
    <div class="panel"><h2 style="margin-top:0">Screen sizes</h2>${bars(screens, visitorsN)}</div>
    <div class="panel"><h2 style="margin-top:0">Search</h2>
      <table>
        <tr><td>Visitors who came from a search engine</td><td class="n"><b>${fmt(fromSearch.length)}</b></td></tr>
        <tr><td>Times Google crawled a page</td><td class="n"><b>${fmt(n(google.crawls))}</b></td></tr>
        <tr><td>Different pages Google crawled</td><td class="n"><b>${fmt(n(google.pages))}</b></td></tr>
        <tr><td>Google's last visit</td><td class="n">${google.last_at ? esc(String(google.last_at).slice(0, 16)) : "—"}</td></tr>
      </table>
      <p class="muted" style="margin-top:10px">What people searched for is only visible in Google Search Console, which Google does not share with the site.</p></div>
  </div>

  <div class="grid2">
    <div class="panel"><h2 style="margin-top:0">Bots and crawlers</h2>
      <table><tr><th>Who</th><th class="n">Page views</th><th class="n">Pages</th><th>Last seen</th></tr>
      ${bots.map((b: any) => `<tr><td>${esc(b.bot)}</td><td class="n">${fmt(n(b.v))}</td><td class="n">${fmt(n(b.pages))}</td><td class="muted">${esc(String(b.last_at).slice(0, 16))}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">None yet.</td></tr>`}
      </table></div>
    <div class="panel"><h2 style="margin-top:0">Unconfirmed views, by network</h2>${bars(unconfirmedOrgs.map((r: any) => ({ k: String(r.k), v: n(r.v) })), n(now.unconfirmed))}
      <p class="muted" style="margin-top:10px">Pages fetched but never run. Large numbers from one network are usually a scraper or an email link scanner.</p></div>
  </div>

  <div class="panel wide"><h2 style="margin-top:0">Recent visitors</h2>
    <table><tr><th>When</th><th>Where</th><th>Device</th><th>Came from</th><th>Pages</th><th class="n">Time</th></tr>
    ${visits.slice(0, 40).map((v: any) => `<tr><td class="muted">${esc(String(v.first_at).slice(5, 16))}</td>
      <td>${FLAGS(v.country)} ${esc(v.city ?? "")}${v.city ? ", " : ""}${esc(countryName(v.country))}</td>
      <td class="muted">${esc(v.device ?? "")} · ${esc(v.browser ?? "")} · ${esc(v.os ?? "")}</td>
      <td>${esc(v.channel)}${v.ref_host && !/thepaymaster/.test(v.ref_host) ? `<div class="muted">${esc(v.ref_host)}</div>` : ""}${v.utm_campaign ? `<div class="muted">${esc(v.utm_campaign)}</div>` : ""}</td>
      <td class="trail">${esc(String(v.trail).slice(0, 240))}</td><td class="n">${secs(n(v.engaged))}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No visitors yet.</td></tr>`}
    </table></div>

  ${cf}`;
  return page("Traffic", body, { nav: nav("/traffic", admin.name) });
}

// ---------------------------------------------------------------------------
// Cloudflare's own figures: the history before the site's log began.
// ---------------------------------------------------------------------------

const ZONE = "423b95a61547dd1819666fc2de7c1a58";
const ACCOUNT = "c2102a85d6857866b83b6146e44cad1b";

async function cloudflareHistory(env: Env): Promise<string> {
  const token = env.CF_ANALYTICS_TOKEN;
  const head = `<div class="panel wide"><h2 style="margin-top:0">Cloudflare's figures, including the months before</h2>`;
  if (!token) {
    return `${head}<p class="note">Cloudflare holds the history from before this page existed. To show it here, create a Cloudflare API token with
      <b>Account Analytics: Read</b> and <b>Zone Analytics: Read</b>, then store it on the platform with
      <span class="path">wrangler secret put CF_ANALYTICS_TOKEN</span>. The token never appears on this page.</p></div>`;
  }
  const gql = async (query: string, variables: Record<string, unknown>) => {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10_000),
    });
    const d: any = await r.json();
    if (d.errors?.length) throw new Error(d.errors[0].message);
    return d.data;
  };
  try {
    const months: [string, string][] = [];
    const d = new Date();
    for (let i = 5; i >= 0; i--) {
      const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
      const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
      months.push([s.toISOString().slice(0, 10), (e > d ? d : e).toISOString().slice(0, 10)]);
    }
    const rows: string[] = [];
    for (const [s, e] of months) {
      const z = await gql(`query($z:String!,$s:Date!,$e:Date!){viewer{zones(filter:{zoneTag:$z}){httpRequests1dGroups(limit:40,filter:{date_geq:$s,date_leq:$e}){sum{requests pageViews threats bytes}}}}}`, { z: ZONE, s, e });
      const g = z.viewer.zones[0]?.httpRequests1dGroups ?? [];
      const sum = (k: string) => g.reduce((a: number, x: any) => a + n(x.sum[k]), 0);
      let real = "—";
      try {
        const a = await gql(`query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){rumPageloadEventsAdaptiveGroups(limit:1,filter:{date_geq:$s,date_leq:$e,requestHost:"thepaymaster.co.uk"}){sum{visits}}}}}`, { a: ACCOUNT, s, e });
        const v = a.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups?.[0]?.sum?.visits;
        if (v != null) real = `about ${fmt(n(v))}`;
      } catch { /* Web Analytics may not be readable with this token */ }
      rows.push(`<tr><td>${new Date(s + "T00:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}</td>
        <td class="n">${real}</td><td class="n">${fmt(sum("pageViews"))}</td><td class="n">${fmt(sum("requests"))}</td>
        <td class="n">${fmt(sum("threats"))}</td><td class="n">${(sum("bytes") / 1e9).toFixed(1)} GB</td></tr>`);
    }
    return `${head}<table><tr><th>Month</th><th class="n">Real visits</th><th class="n">Page views, all</th><th class="n">Requests</th><th class="n">Threats blocked</th><th class="n">Data served</th></tr>${rows.join("")}</table>
      <p class="muted" style="margin-top:10px">Real visits are Cloudflare Web Analytics' estimate from a one-in-ten sample of browsers. Page views and requests include every bot, crawler and scanner, across all of thepaymaster.co.uk's subdomains.</p></div>`;
  } catch (err) {
    return `${head}<p class="note">Cloudflare did not answer: ${esc((err as Error).message.slice(0, 160))}. Check the token has Account Analytics: Read and Zone Analytics: Read.</p></div>`;
  }
}
