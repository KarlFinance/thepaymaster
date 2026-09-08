/**
 * Two jobs: send www to the apex, and keep the three intake forms on WordPress.
 */

/** Cloudways box behind thepaymaster.co.uk, from the A record it replaced. */
const ORIGIN = "origin.thepaymaster.co.uk";

/**
 * The only name the origin answers to.
 *
 * Its certificate carries thepaymaster.co.uk and nothing else — no www, no
 * subdomain, which is why both of those return 526 today — and WordPress 404s
 * any other Host. So the upstream URL is pinned to the apex whatever hostname
 * this worker was reached on. That also means the whole thing can be proven on
 * a staging subdomain before the real domain is pointed anywhere.
 */
const CANONICAL = "thepaymaster.co.uk";

/**
 * Paths WordPress still owns.
 *
 * The three intake forms cannot be served from the capture. WPForms embeds a
 * WordPress nonce in the page and checks it on submit; nonces last a day, and
 * the ones in the capture were dead within ten hours. A captured form would
 * render perfectly and reject every submission. Proxying only the AJAX endpoint
 * would not help either — the stale nonce is in the page, not the request — so
 * the pages themselves have to come from the origin, fresh, along with the
 * endpoint they post to and the uploader they use.
 *
 * These are the KYC, source-of-funds and transaction-setup forms. They are the
 * specification for the platform that replaces them; until that exists they
 * stay exactly as they are, on the system that already works.
 */
const WORDPRESS = [
  "/form",
  "/source-of-funds-verification",
  "/ppp-stage-one-evaluation",
  "/wp-admin/admin-ajax.php",
];

/**
 * Set on the way out and checked on the way in.
 *
 * The proxy fetch keeps the original URL so the Host header stays
 * thepaymaster.co.uk — the origin 404s on anything else, and its certificate
 * covers that name and nothing else — and redirects the connection with
 * resolveOverride. If that override were ever ignored the request would arrive
 * back here and recurse until it was killed. This makes the second pass serve
 * static instead, so the failure is a wrong page rather than a hung worker.
 */
const LOOP = "x-tpm-proxied";

function wordpressOwns(pathname) {
  return WORDPRESS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
    return Response.redirect(url.toString(), 301);
  }

  if (!wordpressOwns(url.pathname) || request.headers.get(LOOP)) {
    return context.next();
  }

  const headers = new Headers(request.headers);
  headers.set(LOOP, "1");
  // Cloudways serves these over plain HTTP and would otherwise answer every
  // request with a 301 to the https URL, which is this worker again.
  headers.set("X-Forwarded-Proto", "https");

  const target = new URL(url.toString());
  target.hostname = CANONICAL;

  const upstream = new Request(target.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : request.body,
    redirect: "manual",
  });

  const response = await fetch(upstream, {
    cf: { resolveOverride: ORIGIN, cacheEverything: false },
  });

  // Forms carry session cookies and CSRF state; caching any of it would be a
  // way to hand one applicant another applicant's page.
  const out = new Response(response.body, response);
  out.headers.set("Cache-Control", "no-store");
  return out;
}
