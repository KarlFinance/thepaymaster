"""
Capture thepaymaster.co.uk as a static site.

The live site is WordPress with Elementor and twenty-six plugins: seventy-four
stylesheets and sixty-five scripts on the homepage, and seven seconds to first
byte. This takes the rendered output and everything it references, rewrites
same-origin links to root-relative, and leaves a directory that Cloudflare Pages
can serve directly.

Deliberately a faithful capture, not a rebuild. The pages keep Elementor's markup
and all of its CSS — which is not fast, but is identical, and identical is what
was asked for. Serving it as static files behind Cloudflare removes the database,
the PHP and the plugin chain, which is where the seven seconds actually goes.

Standard library only: the Mac this runs on has no requests, no bs4 and no wget.

Run again any time; it overwrites. `python3 capture.py`
"""
from __future__ import annotations

import gzip
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlparse

SITE = "https://thepaymaster.co.uk"
OUT = Path(__file__).parent / "site"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# Sitemaps that list real, user-facing URLs. The WordPress index lists twenty-one
# sitemaps, most of them taxonomy stubs for plugins that generate no page anyone
# visits; pulling those would triple the crawl for nothing.
PAGES_API = "/wp-json/wp/v2/pages?per_page=100&_fields=link,status"

# Same-origin references worth following. Anything else — Google Fonts, the
# Jetpack CDN, analytics — is left pointing at its original host, so the captured
# site still renders if we miss something.
ASSET_ATTRS = re.compile(
    r'(?:href|src|data-src|data-bg|content)\s*=\s*["\']([^"\']+)["\']', re.I)
SRCSET = re.compile(r'srcset\s*=\s*["\']([^"\']+)["\']', re.I)
CSS_URL = re.compile(r'url\(\s*["\']?([^"\')]+)["\']?\s*\)', re.I)
CSS_IMPORT = re.compile(r'@import\s+["\']([^"\']+)["\']', re.I)

ASSET_EXT = {".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
             ".ico", ".woff", ".woff2", ".ttf", ".eot", ".otf", ".mp4", ".webm",
             ".pdf", ".json", ".avif", ".cur"}

seen: set[str] = set()
failed: list[tuple[str, str]] = []
saved = 0


def fetch(url: str, tries: int = 4) -> bytes | None:
    """GET with a browser user agent. WordPress behind a CDN is picky about that."""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "*/*",
                "Accept-Encoding": "gzip",
                "Referer": SITE + "/",
            })
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data
        except urllib.error.HTTPError as e:
            if e.code in (404, 403, 410):
                body = e.read()
                if e.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                if body:
                    return body
                failed.append((url, f"HTTP {e.code}"))
                return None
            time.sleep(2 + attempt * 3)
        except Exception as e:
            if attempt == tries - 1:
                failed.append((url, type(e).__name__))
                return None
            time.sleep(2 + attempt * 3)
    return None


def local_path(url: str) -> Path:
    """Where a URL lands on disk. Directory URLs become index.html."""
    p = urlparse(url).path
    if p.endswith("/") or not Path(p).suffix:
        p = p.rstrip("/") + "/index.html"
    return OUT / p.lstrip("/")


def same_origin(url: str) -> bool:
    host = urlparse(url).netloc
    # The Cloudways hostname is the same box; its assets belong in the capture.
    if host.endswith(".cloudwaysapps.com"):
        return True
    return host in ("thepaymaster.co.uk", "www.thepaymaster.co.uk", "")


def rewrite(text: str) -> str:
    """
    Point same-origin absolute URLs at the root.

    Root-relative rather than relative-to-file: Cloudflare Pages serves from the
    root, and relative paths would break the moment a page lives more than one
    directory deep.
    """
    text = re.sub(r'https?://(?:www\.)?thepaymaster\.co\.uk/', '/', text)
    text = re.sub(r'(?<!:)//(?:www\.)?thepaymaster\.co\.uk/', '/', text)
    # Escaped form, as it appears inside inline JSON and JS config blocks.
    text = text.replace('https:\\/\\/thepaymaster.co.uk\\/', '\\/')
    text = text.replace('https:\\/\\/www.thepaymaster.co.uk\\/', '\\/')
    # Elementor's generated font CSS hardcodes the raw Cloudways hostname for
    # every webfont. That host resolves to the origin but its certificate covers
    # thepaymaster.co.uk alone, so the browser rejects all fifty-six of them and
    # the site has been falling back to a system font on WordPress too. Same
    # files, same paths, so pointing them at the root fixes it.
    text = re.sub(r'https?://wordpress-\d+-\d+\.cloudwaysapps\.com/', '/', text)
    return text


def collect(base: str, body: str, is_css: bool) -> set[str]:
    """Every same-origin asset this document references."""
    found: set[str] = set()
    raw: list[str] = []
    if is_css:
        raw += CSS_URL.findall(body) + CSS_IMPORT.findall(body)
    else:
        raw += ASSET_ATTRS.findall(body)
        raw += CSS_URL.findall(body)                       # inline style blocks
        for s in SRCSET.findall(body):
            raw += [c.strip().split()[0] for c in s.split(",") if c.strip()]

    for u in raw:
        u = u.strip()
        if not u or u.startswith(("data:", "mailto:", "tel:", "javascript:", "#")):
            continue
        full = urljoin(base, u).split("#")[0]
        if not same_origin(full):
            continue
        ext = Path(urlparse(full).path).suffix.lower()
        # Query strings are WordPress cache-busters; the file behind them is the
        # same, so they are dropped rather than turned into separate files.
        if ext in ASSET_EXT:
            found.add(full.split("?")[0])
    return found


def save(path: Path, data: bytes) -> None:
    global saved
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    saved += 1


def grab_asset(url: str, depth: int = 0) -> set[str]:
    """Fetch one asset. CSS is parsed for the fonts and images it pulls in."""
    if url in seen:
        return set()
    seen.add(url)
    data = fetch(url)
    if data is None:
        return set()

    more: set[str] = set()
    if url.lower().endswith(".css") and depth < 3:
        try:
            text = rewrite(data.decode("utf-8", "replace"))
            more = collect(url, text, is_css=True)
            data = text.encode("utf-8")
        except Exception:
            pass
    save(local_path(url), data)
    return more


def main() -> None:
    print(f"capturing {SITE} -> {OUT}")
    OUT.mkdir(parents=True, exist_ok=True)

    # ---- the page list -----------------------------------------------------
    import json as _json
    pages: list[str] = []
    raw = fetch(SITE + PAGES_API)
    if raw:
        pages += [p["link"] for p in _json.loads(raw)
                  if p.get("status", "publish") == "publish"]
    pages = [p for p in dict.fromkeys(pages) if same_origin(p)]
    print(f"  {len(pages)} pages listed")

    # ---- pages -------------------------------------------------------------
    assets: set[str] = set()

    def do_page(url: str) -> int:
        # Resume rather than refetch. The origin is a single WordPress droplet
        # taking seven seconds a page; on the first run four concurrent requests
        # timed out fourteen of thirty-six. Anything already on disk and
        # plausibly complete is left alone, so a re-run only chases the gaps.
        existing = local_path(url)
        if existing.exists() and existing.stat().st_size > 20_000:
            text = existing.read_text("utf-8", "replace")
            assets.update(collect(url, text, is_css=False))
            return -existing.stat().st_size

        data = fetch(url)
        if data is None:
            print(f"  ! {url}")
            return 0
        text = data.decode("utf-8", "replace")
        assets.update(collect(url, text, is_css=False))
        save(local_path(url), rewrite(text).encode("utf-8"))
        return len(text)

    # Two at a time, not four. Slower, and it actually finishes.
    with ThreadPoolExecutor(max_workers=2) as pool:
        for i, size in enumerate(pool.map(do_page, pages), 1):
            mark = "cached" if size < 0 else ("FAILED" if size == 0 else "      ")
            print(f"  [{i:2d}/{len(pages)}] {abs(size)/1024:6.0f} KB  {mark}")

    print(f"  {len(assets)} assets referenced")

    # ---- assets, plus whatever the CSS pulls in ----------------------------
    queue = set(assets)
    round_no = 0
    while queue and round_no < 4:
        round_no += 1
        print(f"  assets, pass {round_no}: {len(queue)}")
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(grab_asset, queue))
        queue = {u for r in results for u in r} - seen

    # ---- Pages needs a 404 -------------------------------------------------
    nf = fetch(f"{SITE}/this-page-does-not-exist-{int(time.time())}/")
    if nf:
        save(OUT / "404.html", rewrite(nf.decode("utf-8", "replace")).encode("utf-8"))

    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print()
    print(f"  files saved   {saved}")
    print(f"  total size    {total/1024/1024:.1f} MB")
    if failed:
        print(f"  failed        {len(failed)}")
        for u, why in failed[:12]:
            print(f"     {why:12s} {u}")


if __name__ == "__main__":
    main()
