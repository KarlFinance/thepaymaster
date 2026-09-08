"""
Fetch the Elementor bundles the crawl cannot see.

Elementor's webpack runtime builds its chunk URLs at load time from a
name -> hash map baked into frontend.min.js, so those files are never named in
any HTML and capture.py has nothing to follow. Without them the accordions,
tabs, lightbox and text-editor widgets 404 the moment a visitor scrolls to one.

This reconstructs the URLs from the map and fetches whatever really exists.
Run after capture.py, before build.py.
"""
from __future__ import annotations

import gzip
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SITE = "https://thepaymaster.co.uk"
OUT = Path(__file__).parent / "site"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
PAIR = re.compile(r'"([a-z0-9\-]+)":"([0-9a-f]{20})"')
NAMED = re.compile(r'([a-z0-9\-]+\.[0-9a-f]{20}\.bundle\.min\.js)')

# Loaded by WordPress itself rather than referenced in the markup.
EXTRA = ["/wp-includes/js/wp-emoji-release.min.js"]


def candidates() -> list[str]:
    want: set[str] = set(EXTRA)
    for js in OUT.rglob("*.js"):
        text = js.read_text("utf-8", "replace")
        for name, digest in PAIR.findall(text):
            for plugin in ("elementor", "elementor-pro"):
                want.add(f"/wp-content/plugins/{plugin}/assets/js/"
                         f"{name}.{digest}.bundle.min.js")
        for fname in NAMED.findall(text):
            want.add(f"/wp-content/plugins/elementor/assets/js/{fname}")
    return [u for u in sorted(want) if not (OUT / u.lstrip("/")).exists()]


def get(url: str) -> tuple[str, int]:
    # Most guesses are wrong by construction: one hash map serves both plugins
    # and only some names exist in each. A miss is expected, not an error.
    try:
        req = urllib.request.Request(
            SITE + url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                data = gzip.decompress(data)
    except Exception:
        return url, 0
    path = OUT / url.lstrip("/")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return url, len(data)


def main() -> None:
    todo = candidates()
    print(f"  {len(todo)} candidates")
    with ThreadPoolExecutor(max_workers=8) as pool:
        got = [r for r in pool.map(get, todo) if r[1]]
    print(f"  {len(got)} fetched, {sum(n for _, n in got)/1024:.0f} KB")


if __name__ == "__main__":
    main()
