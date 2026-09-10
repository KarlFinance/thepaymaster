"""
Turn the capture into something Cloudflare Pages can serve.

The capture is byte-faithful WordPress output. Three things in it only made
sense while WordPress was behind it: the head links that advertise the REST
API, the feeds and oEmbed; the sitemap, which pointed at Cloudways; and the
robots.txt, which pointed at a sitemap that no longer exists. Those are
rewritten. Everything a visitor can see is left exactly as captured.

    python3 build.py        # site/ -> dist/
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).parent
SITE = HERE / "site"
DIST = HERE / "dist"
OVERLAY = HERE / "overlay"
FUNCTIONS = HERE / "functions"
DOMAIN = "https://thepaymaster.co.uk"

# Head links that only resolve when WordPress is answering. Left in place they
# are forty-four pages of 404s for anything that crawls them.
DEAD_HEAD = re.compile(
    r'[ \t]*<link rel=(?:"|\')(?:https://api\.w\.org/|alternate|EditURI|wlwmanifest|shortlink)'
    r'(?:"|\')[^>]*>\n?', re.I)
DEAD_HEAD_EXTRA = re.compile(
    r'[ \t]*<link[^>]+href=(?:"|\')(?:/wp-json/|/feed/|/comments/feed/)[^>]*>\n?', re.I)

HEADERS = """/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/wp-content/*
  Cache-Control: public, max-age=31536000, immutable

/wp-includes/*
  Cache-Control: public, max-age=31536000, immutable

/cdn-cgi/*
  Cache-Control: public, max-age=31536000, immutable

/*.html
  Cache-Control: public, max-age=0, must-revalidate
"""

# WordPress plumbing nobody should reach on a static site.
REDIRECTS = """/wp-login.php  /  301
/feed/*  /  301
/comments/feed/*  /  301
/xmlrpc.php  /  301
"""

ROBOTS = f"""User-agent: *
Allow: /
Disallow: /wp-admin/

Sitemap: {DOMAIN}/sitemap.xml
"""


# The WordPress box, by address.
#
# Since the worker took over the domain the REST API is no longer reachable
# through it — only the three form paths reach WordPress, everything else is
# served from this build. So the page list is read from the origin directly.
# curl rather than urllib because this needs the connection made to the address
# while the handshake and the Host header both say thepaymaster.co.uk: the
# origin's certificate carries that one name, and WordPress 404s anything else.
ORIGIN_IP = "157.245.37.150"
PAGES_API = "/wp-json/wp/v2/pages?per_page=100&_fields=link,modified,status"


# ---------------------------------------------------------------------------
# Corrections applied to every captured page
#
# These are done here rather than by hand in dist/ so that a recapture does not
# quietly undo them. Each one is a fact about the site being wrong, not a
# preference.
# ---------------------------------------------------------------------------

# The call to action now goes to the platform's own enquiry form rather than
# the old WordPress page. Matched on the button's text so that other links to
# /briefing-evaluation/ are left alone.
START_BUTTON = re.compile(
    r'(<a\b[^>]*?href=")([^"]*)("[^>]*>(?:(?!</a>).){0,600}?Start A Transaction)',
    re.S | re.I)

# Twitter, which they do not use. The whole list item goes, not just the link,
# so no empty bullet is left behind.
TWITTER_ITEM = re.compile(
    r'<li[^>]*>\s*<a\b[^>]*(?:x\.com|twitter\.com)[^>]*>.*?</a>\s*</li>',
    re.S | re.I)

# A Cloudways referral badge: the image is broken (it answers with HTML, not a
# picture) and the link is a referral code for the host this site has just
# moved off. On all forty-six pages.
CLOUDWAYS = re.compile(
    r'<a\b[^>]*vrlps\.co[^>]*>.*?</a>', re.S | re.I)


# The "SOFie recorded interview (transcript + artefacts)" deliverable is not part
# of the process: SOFie is a concept for later, not a service today. Only that
# one list item goes; the page's other mentions of SOFie stay as written.
SOFIE_ITEM = re.compile(
    r'<li[^>]*>\s*SOFie(?:\u2122|&trade;)?[^<]*recorded interview[^<]*</li>', re.S | re.I)


def edits(text: str) -> str:
    text = START_BUTTON.sub(r"\1/enquiry\3", text)
    text = TWITTER_ITEM.sub("", text)
    text = CLOUDWAYS.sub("", text)
    text = SOFIE_ITEM.sub("", text)
    return text


def page_list() -> list[tuple[str, str]]:
    """(url, lastmod) for every published page, straight from the origin."""
    out = subprocess.run(
        ["curl", "-sS", "--resolve", f"thepaymaster.co.uk:443:{ORIGIN_IP}",
         "-A", "Mozilla/5.0", f"https://thepaymaster.co.uk{PAGES_API}"],
        capture_output=True, text=True, timeout=120, check=True)
    pages = json.loads(out.stdout)
    return sorted((p["link"], p["modified"][:10]) for p in pages
                  if p.get("status", "publish") == "publish")


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SITE, DIST)

    stripped = 0
    for f in DIST.rglob("*.html"):
        text = f.read_text("utf-8", "replace")
        new = DEAD_HEAD_EXTRA.sub("", DEAD_HEAD.sub("", text))
        new = edits(new)
        if new != text:
            f.write_text(new)
            stripped += 1

    # The overlay goes last in the head so it wins on equal specificity, and is
    # cache-busted by its own mtime so a fix is never served stale.
    (DIST / "assets").mkdir(exist_ok=True)
    stamp = 0
    for css in OVERLAY.glob("*.css"):
        shutil.copy2(css, DIST / "assets" / css.name)
        stamp = max(stamp, int(css.stat().st_mtime))
    tags = "".join(
        f'<link rel="stylesheet" href="/assets/{c.name}?v={stamp}">'
        for c in sorted(OVERLAY.glob("*.css")))
    linked = 0
    for f in DIST.rglob("*.html"):
        text = f.read_text("utf-8", "replace")
        if "</head>" not in text:
            continue
        f.write_text(text.replace("</head>", tags + "</head>", 1))
        linked += 1

    if FUNCTIONS.is_dir():
        shutil.copytree(FUNCTIONS, DIST / "functions")

    (DIST / "_headers").write_text(HEADERS)
    (DIST / "_redirects").write_text(REDIRECTS)
    (DIST / "robots.txt").write_text(ROBOTS)

    pages = page_list()
    urls = "".join(
        f"  <url><loc>{u}</loc><lastmod>{m}</lastmod></url>\n" for u, m in pages)
    (DIST / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{urls}</urlset>\n")

    files = sum(1 for f in DIST.rglob("*") if f.is_file())
    size = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"  dist        {files} files, {size/1024/1024:.1f} MB")
    print(f"  head links  stripped from {stripped} pages")
    print(f"  overlay     linked into {linked} pages")
    print(f"  sitemap     {len(pages)} pages")
    fns = len(list((DIST / "functions").rglob("*.js"))) if (DIST / "functions").is_dir() else 0
    print(f"  functions   {fns}")


if __name__ == "__main__":
    main()
