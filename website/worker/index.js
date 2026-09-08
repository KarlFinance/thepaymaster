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

    // Straight through to the zone's origin, Host and all.
    if (wordpressOwns(url.pathname)) {
      const response = await fetch(request);
      // Forms carry session state; caching any of it would be a way to hand one
      // applicant another applicant's page.
      const out = new Response(response.body, response);
      out.headers.set("Cache-Control", "no-store");
      return out;
    }

    const target = new URL(url.pathname + url.search, PAGES);
    return fetch(new Request(target, request));
  },
};
