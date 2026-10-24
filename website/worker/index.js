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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // One address per page. www and the apex serving the same thing would split
    // their ranking, and www has no working certificate at the origin anyway.
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    if (platformOwns(url.pathname) && env.PLATFORM) {
      return env.PLATFORM.fetch(request);
    }

    const target = new URL(url.pathname + url.search, PAGES);
    const response = await fetch(new Request(target, request));
    return noindexIfStaging(response, url);
  },
};
