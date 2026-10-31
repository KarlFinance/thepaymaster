/**
 * The front door for thepaymaster.co.uk.
 *
 * The site is static, served from Cloudflare Pages, except for three pages that
 * are still WordPress. This worker decides which is which, and exists because
 * nothing simpler can:
 *
 *   - DNS cannot split a domain by path.
 *   - A Pages Function cannot reach the WordPress box once the domain points at
 *     Pages. The origin answers only to Host: thepaymaster.co.uk — its
 *     certificate covers that name and nothing else, which is why www and
 *     webmail both return 526 today — and a Function cannot set Host, cannot
 *     fetch the origin by IP (Cloudflare answers 403), and has cf.resolveOverride
 *     ignored. All three were tested.
 *
 * A worker on the zone can, because fetch(request) from here goes to the zone's
 * own origin with the Host intact. That is the one path to the WordPress box
 * that still works, so it is the one this uses.
 *
 * Consequence worth knowing: the DNS does not change at all. The A records stay
 * on Cloudways, mail stays exactly where it is, and going live is adding a route
 * to this worker. Rolling back is deleting it.
 */

/**
 * Paths the platform worker owns.
 *
 * /enquiry is the new front door: a real form writing into the platform's
 * database rather than the SuiteDash embed on /start-transaction/. Both are
 * live for now, deliberately — the old page keeps working until this one has
 * been looked at properly, and then /start-transaction/ points here.
 */
const PLATFORM_PATHS = ["/enquiry", "/distribute"];

function platformOwns(pathname) {
  return PLATFORM_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** Where the captured site is served from. */
const PAGES = "https://thepaymaster-3b4.pages.dev";

/*
 * WordPress is gone (24 Oct 2026). Its three intake forms, its form endpoint
 * and its uploads were the last paths routed to it; those forms are now the
 * platform's own, built into the static pages, so every path is served from
 * Pages and nothing is fetched from the old server.
 */

/** The apex is the live site; any other hostname (staging) is kept out of search. */
const CANONICAL = "thepaymaster.co.uk";

function noindexIfStaging(response, url) {
  if (url.hostname === CANONICAL) return response;
  const out = new Response(response.body, response);
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}

// ---------------------------------------------------------------------------
// Traffic: one row per page view in the platform's database (traffic_hits),
// and a beacon in each page that proves a real browser ran it. Every part of
// this fails open: if logging breaks, the page is served exactly as before.
// ---------------------------------------------------------------------------

const BOTS = [
  [/googlebot|google-inspectiontool|googleother|storebot-google|adsbot-google|mediapartners-google/i, "Google"],
  [/bingbot|bingpreview|adidxbot/i, "Bing"], [/applebot/i, "Apple"], [/duckduckbot|duckassistbot/i, "DuckDuckGo"],
  [/yandex/i, "Yandex"], [/baiduspider/i, "Baidu"], [/petalbot/i, "Petal"], [/seznambot/i, "Seznam"],
  [/gptbot|oai-searchbot|chatgpt-user/i, "OpenAI"], [/claudebot|claude-web|anthropic/i, "Anthropic"],
  [/perplexitybot|perplexity-user/i, "Perplexity"], [/ccbot/i, "Common Crawl"], [/bytespider/i, "ByteDance"],
  [/meta-externalagent|facebookexternalhit|facebookcatalog/i, "Meta"], [/amazonbot/i, "Amazon"],
  [/linkedinbot/i, "LinkedIn"], [/twitterbot/i, "X/Twitter"], [/slackbot/i, "Slack"], [/whatsapp/i, "WhatsApp"],
  [/telegrambot/i, "Telegram"], [/discordbot/i, "Discord"],
  [/ahrefsbot/i, "Ahrefs"], [/semrushbot/i, "Semrush"], [/mj12bot/i, "Majestic"], [/dotbot/i, "Moz"],
  [/dataforseobot/i, "DataForSEO"], [/serpstatbot/i, "Serpstat"], [/barkrowler/i, "Babbar"],
  [/uptimerobot|pingdom|statuscake|site24x7|betteruptime/i, "Uptime monitor"],
  [/lighthouse|pagespeed|gtmetrix/i, "Speed test"], [/headlesschrome|phantomjs|puppeteer|playwright/i, "Headless browser"],
  [/curl|wget|python|go-http|java\/|okhttp|axios|node-fetch|libwww|httpclient|scrapy|aiohttp/i, "Script"],
  [/bot|crawl|spider|slurp|scan|fetch|preview|monitor|checker|archiver/i, "Other bot"],
];
const DATACENTRES = /amazon|aws|google cloud|google llc|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|contabo|m247|datacamp|vultr|choopa|leaseweb|scaleway|oracle|alibaba|tencent|hostinger|ionos|colocrossing|psychz|cogent|zenlayer|cdn77|g-core|gcore|stark industries|aeza|pfcloud|hostroyale|servers\.com|quadranet|packethub|tzulo|clouvider|worldstream|ponynet|frantech|buyvm|netcup|hivelocity|cloudflare/i;

function botName(ua, asOrg) {
  if (!ua) return "No user agent";
  for (const [re, name] of BOTS) if (re.test(ua)) return name;
  if (asOrg && DATACENTRES.test(asOrg)) return "Data centre";
  return null;
}

function parseUa(ua) {
  ua = ua || "";
  const browser = /edg\//i.test(ua) ? "Edge" : /opr\/|opera/i.test(ua) ? "Opera" : /samsungbrowser/i.test(ua) ? "Samsung"
    : /firefox|fxios/i.test(ua) ? "Firefox" : /chrome|crios/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "Other";
  const os = /windows/i.test(ua) ? "Windows" : /iphone|ipad|ipod/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android"
    : /mac os x|macintosh/i.test(ua) ? "macOS" : /cros/i.test(ua) ? "ChromeOS" : /linux/i.test(ua) ? "Linux" : "Other";
  const device = /ipad|tablet/i.test(ua) ? "Tablet" : /mobi|iphone|android/i.test(ua) ? "Mobile" : "Desktop";
  return { browser, os, device };
}

let saltCache = { day: "", salt: "" };
async function daySalt(db, day) {
  if (saltCache.day === day) return saltCache.salt;
  const fresh = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT OR IGNORE INTO traffic_salts (day, salt) VALUES (?, ?)").bind(day, fresh).run();
  const row = await db.prepare("SELECT salt FROM traffic_salts WHERE day = ?").bind(day).first();
  saltCache = { day, salt: row.salt };
  return row.salt;
}

/** The same function as the platform's visitorId(): a day's salt, the IP and the user agent. */
async function visitorId(db, ip, ua) {
  const day = new Date().toISOString().slice(0, 10);
  const salt = await daySalt(db, day);
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${ip}|${ua}`));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

async function logHit(env, request, url, id, status) {
  const ua = request.headers.get("User-Agent") || "";
  const cf = request.cf || {};
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ref = request.headers.get("Referer") || "";
  let refHost = null;
  try { refHost = ref ? new URL(ref).hostname : null; } catch {}
  const q = url.searchParams;
  const { browser, os, device } = parseUa(ua);
  await env.DB.prepare(
    `INSERT INTO traffic_hits (id, host, path, query, referrer, ref_host, utm_source, utm_medium, utm_campaign, visitor,
       country, region, city, asn, as_org, colo, ua, browser, os, device, bot, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, url.hostname, cut(url.pathname, 300), cut(url.search.slice(1), 500) || null, cut(ref, 500) || null, cut(refHost, 200),
    cut(q.get("utm_source"), 100), cut(q.get("utm_medium"), 100), cut(q.get("utm_campaign"), 150),
    await visitorId(env.DB, ip, ua),
    cf.country || null, cut(cf.region, 100), cut(cf.city, 100), cf.asn || null, cut(cf.asOrganization, 150), cf.colo || null,
    cut(ua, 400), browser, os, device, botName(ua, cf.asOrganization), status,
  ).run();
  // Old salts go after three days, so a visitor id can never be traced back to an IP.
  if (Math.random() < 0.01) {
    await env.DB.prepare("DELETE FROM traffic_salts WHERE day < date('now', '-3 days')").run();
  }
}

/** The page's beacon: a real browser ran the page; how long it was looked at; how far it was read. */
async function beacon(env, text) {
  try {
    const b = JSON.parse(text.slice(0, 2000));
    if (typeof b.id !== "string" || !/^[a-f0-9]{24}$/.test(b.id)) return;
    const engaged = Math.max(0, Math.min(Number(b.e) || 0, 4 * 3600_000));
    const scroll = Math.max(0, Math.min(Number(b.s) || 0, 100));
    await env.DB.prepare(
      `UPDATE traffic_hits SET js = 1, screen = coalesce(screen, ?), lang = coalesce(lang, ?), tz = coalesce(tz, ?),
         engaged_ms = max(coalesce(engaged_ms, 0), ?), scroll_pct = max(coalesce(scroll_pct, 0), ?)
       WHERE id = ? AND at > datetime('now', '-1 day')`).bind(
      cut(b.w, 20), cut(b.l, 20), cut(b.z, 60), Math.round(engaged), Math.round(scroll), b.id).run();
  } catch {}
}

const BEACON = (id) => `<script>(function(){try{var id="${id}",vis=0,last=document.visibilityState==="visible"?Date.now():0,max=0;
function sc(){var h=document.documentElement,b=document.body||h,y=(window.pageYOffset||h.scrollTop||0)+innerHeight,H=Math.max(h.scrollHeight,b.scrollHeight||0)||1,p=Math.min(100,Math.round(y/H*100));if(p>max)max=p}
addEventListener("scroll",sc,{passive:true});sc();
function send(){var e=vis+(last?Date.now()-last:0),d=JSON.stringify({id:id,e:e,s:max,w:screen.width+"x"+screen.height,l:navigator.language||"",z:(window.Intl&&Intl.DateTimeFormat().resolvedOptions().timeZone)||""});
if(navigator.sendBeacon)navigator.sendBeacon("/_t",d);else fetch("/_t",{method:"POST",body:d,keepalive:true})}
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden"){if(last){vis+=Date.now()-last;last=0}send()}else{last=Date.now()}});
addEventListener("pagehide",function(){if(last){vis+=Date.now()-last;last=0}send()});send()}catch(e){}})();</script>`;

const ASSET = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|zip|json|xml|txt)$/i;

/** Record the view and hand the page its beacon. Anything that goes wrong leaves the response untouched. */
function track(env, ctx, request, url, response) {
  try {
    if (!env.DB || !ctx || request.method !== "GET" || ASSET.test(url.pathname)) return response;
    if (url.hostname !== CANONICAL && !env.TRACK_ANY_HOST) return response;   // TRACK_ANY_HOST: local testing only
    const type = response.headers.get("Content-Type") || "";
    if (!type.includes("text/html")) return response;
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
    ctx.waitUntil(logHit(env, request, url, id, response.status).catch(() => {}));
    if (response.status !== 200) return response;
    return new HTMLRewriter().on("body", { element(el) { el.append(BEACON(id), { html: true }); } }).transform(response);
  } catch {
    return response;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // One address per page. www and the apex serving the same thing would split
    // their ranking, and www has no working certificate at the origin anyway.
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    // The pages' beacon.
    if (url.pathname === "/_t" && request.method === "POST") {
      // The body is read before answering: once the response has gone, it may not be readable.
      const text = await request.text().catch(() => "");
      if (env.DB && ctx) ctx.waitUntil(beacon(env, text));
      return new Response(null, { status: 204 });
    }

    if (platformOwns(url.pathname) && env.PLATFORM) {
      return track(env, ctx, request, url, await env.PLATFORM.fetch(request));
    }

    const target = new URL(url.pathname + url.search, PAGES);
    const response = await fetch(new Request(target, request));
    return track(env, ctx, request, url, noindexIfStaging(response, url));
  },
};
