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

/** Where the captured site is served from. */
const PAGES = "https://thepaymaster-3b4.pages.dev";

/**
 * The only name the WordPress box answers to.
 *
 * Its certificate carries thepaymaster.co.uk and nothing else, and WordPress
 * 404s any other Host. On the apex this is the hostname already, so rewriting
 * to it is a no-op and the pass-through below is the ordinary
 * fetch-goes-to-origin case. On a staging hostname it is what makes the same
 * code reach the same origin, so the WordPress half can be proven before the
 * live domain is routed anywhere.
 */
const CANONICAL = "thepaymaster.co.uk";

/**
 * Paths WordPress still owns.
 *
 * WPForms puts a WordPress nonce in the page and checks it on submit. Nonces
 * last about a day; the ones in the capture were dead within ten hours. A
 * captured form would render perfectly and reject every submission, which is
 * worse than not having it — so these pages come from WordPress, live, along
 * with the endpoint they post to.
 *
 * They are the KYC, source-of-funds and transaction-setup intake. They are also
 * the specification for the platform meant to replace them; until that exists
 * they stay on the system that already works.
 */
const WORDPRESS = [
  "/form",
  "/source-of-funds-verification",
  "/ppp-stage-one-evaluation",
  "/wp-admin/admin-ajax.php",
  "/wp-content/uploads/wpforms",
];

/**
 * Keep staging out of the index.
 *
 * new.thepaymaster.co.uk serves the same pages as the live domain, which to a
 * crawler is a second copy of the whole site competing with the real one. The
 * header is added at the edge rather than in the pages, so the two hosts serve
 * identical files and there is nothing to remember to change.
 */
function noindexIfStaging(response, url) {
  if (url.hostname === CANONICAL) return response;
  const out = new Response(response.body, response);
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}

function wordpressOwns(pathname) {
  return WORDPRESS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // One address per page. www and the apex serving the same thing would split
    // their ranking, and www has no working certificate at the origin anyway.
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    // Straight through to the origin, Host and all.
    if (wordpressOwns(url.pathname)) {
      const target = new URL(url);
      target.hostname = CANONICAL;
      const response = await fetch(new Request(target.toString(), request));
      // Forms carry session state; caching any of it would be a way to hand one
      // applicant another applicant's page.
      const out = new Response(response.body, response);
      out.headers.set("Cache-Control", "no-store");
      return noindexIfStaging(out, url);
    }

    const target = new URL(url.pathname + url.search, PAGES);
    const response = await fetch(new Request(target, request));
    return noindexIfStaging(response, url);
  },
};
