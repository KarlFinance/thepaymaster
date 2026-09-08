"""
Pull the real content out of the WordPress capture, leaving the builder junk
behind.

The capture's pages are Elementor markup: nested divs by the dozen, class soup,
inline styles. The CONTENT — the words, the images, the links — is what
ThePaymaster owns, and it is what the rebuild needs. This walks each page's
content area and emits clean semantic HTML. Nothing else survives.

Finding the content area is the whole trick. The theme renders three Elementor
blocks per page — header, content, footer — each classed `elementor-<id>`, and
only the middle one uses the page's own ID. That ID is on the body tag as
`page-id-NNNN`, so the content block can be picked out exactly rather than
guessed at by class name. Guessing was tried first and dragged in the WhatsApp
widget, the Google sign-in button and the whole footer menu.

Policies are extracted verbatim by construction: text nodes are copied, never
rewritten. The rebuild typesets them; it does not edit them.

    python3 extract.py         # writes content/<slug>.json
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString, Tag

HERE = Path(__file__).parent
SITE = HERE.parent / "site"
OUT = HERE / "content"

# Still served by WordPress through the worker, so not ours to rebuild; and two
# pages that have never had any content on them.
DROP_PAGES = {"form", "source-of-funds-verification", "ppp-stage-one-evaluation",
              "blog", "verified-wallet"}

KEEP = {"h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li",
        "table", "thead", "tbody", "tr", "th", "td",
        "blockquote", "strong", "em", "b", "i", "a", "img", "br"}

DROP_TAGS = {"script", "style", "noscript", "svg", "link", "meta", "form",
             "input", "select", "textarea", "button", "iframe"}

# Some widgets exist only to carry a third-party embed: HubSpot forms and
# booking, SuiteDash, a D-ID agent, a Google map. On several pages the embed IS
# the page. Those are lifted out whole before the cleaner runs and put back by
# the builder at the same position, because cleaning them would destroy them.
#
# The test is what the widget contains, not what type it claims to be. The
# introducer page keeps the whole Introducer Agreement — two thousand words of
# it — inside an html widget with no script in sight, and lifting that out
# verbatim would have carried Elementor's markup straight into the rebuild.
EMBED_WIDGETS = ("html.", "shortcode.", "google_maps.")
EMBED_TOKEN = "@@EMBED-%d@@"

# Widgets that sit inside the content block but are chrome, not content.
DROP_CLASS_RE = re.compile(
    r"elementskit-breadcrumb|ekit-breadcrumb|joinchat|elementor-widget-image\b.*logo|"
    r"back-to-top|preloader|magic-cursor|sib-form|elementor-widget-elementskit-header",
    re.I)


# Elementor ships its accordion widget with three demo entries — how to change
# your photo, your password, your PayPal plan — each answered with the "Far far
# away, behind the word mountains" placeholder. All three are live on the FAQ
# page. They are demo content, not content, so they do not come across.
DEMO_TEXT = re.compile(r"Far far away, behind the word mountains", re.I)
DEMO_TITLES = re.compile(
    r"How to Change my (Photo from Admin Dashboard|Password easily|"
    r"Subscription Plan using PayPal)", re.I)


def drop_demo(content: Tag) -> int:
    """Remove Elementor's placeholder accordion entries. Returns how many."""
    gone = 0
    for item in content.select(".elementor-accordion-item, .elementskit-card,"
                               ".elementor-tab-content, .elementor-tab-title"):
        text = item.get_text(" ", strip=True)
        if DEMO_TEXT.search(text) or DEMO_TITLES.search(text):
            item.decompose()
            gone += 1
    return gone


def cf_email(tag: Tag) -> str | None:
    """
    Decode a Cloudflare-obfuscated address.

    Cloudflare rewrites every mailto on the origin into a /cdn-cgi/ link with
    the address XOR'd into data-cfemail, and ships a script to undo it. Off that
    zone the link is dead and the script is gone, so the address is decoded here
    and written back as a plain mailto.
    """
    enc = tag.get("data-cfemail") or ""
    if not enc:
        inner = tag.find(attrs={"data-cfemail": True})
        enc = inner.get("data-cfemail") if inner else ""
    if not enc:
        return None
    try:
        key = int(enc[:2], 16)
        return "".join(chr(int(enc[i:i + 2], 16) ^ key)
                       for i in range(2, len(enc), 2))
    except ValueError:
        return None


def clean(node: Tag, out: list[str]) -> None:
    """Walk the tree; emit kept tags with minimal attributes."""
    for child in node.children:
        if isinstance(child, NavigableString):
            text = str(child)
            if text.strip():
                out.append(text)
            continue
        if not isinstance(child, Tag):
            continue
        if child.name in DROP_TAGS:
            continue
        classes = " ".join(child.get("class") or [])
        if DROP_CLASS_RE.search(classes):
            continue

        if child.name == "img":
            src = child.get("src") or child.get("data-src")
            if src and "spinner" not in src and "logo" not in src.lower():
                alt = (child.get("alt") or "").replace('"', "&quot;")
                out.append(f'<img src="{src}" alt="{alt}">')
            continue

        if child.name == "a":
            href = child.get("href", "")
            if "/cdn-cgi/l/email-protection" in href:
                address = cf_email(child)
                if not address:
                    continue
                out.append(f'<a href="mailto:{address}">{address}</a>')
                continue
            inner: list[str] = []
            clean(child, inner)
            body = "".join(inner).strip()
            if body and href:
                out.append(f'<a href="{href}">{body}</a>')
            elif body:
                out.append(body)
            continue

        # The title band renders the heading; leaving it in the body would
        # print it twice, and dropping the tag alone would leak its text.
        if child.name == "h1":
            continue

        if child.name in KEEP:
            inner = []
            clean(child, inner)
            body = "".join(inner).strip()
            if body or child.name == "br":
                out.append(f"<{child.name}>{body}</{child.name}>")
            continue

        clean(child, out)


def tidy(html: str) -> str:
    html = re.sub(r"\s+", " ", html)
    html = re.sub(r"\s+([.,;:!?])", r"\1", html)
    # Elementor wraps single words in their own paragraphs constantly.
    html = re.sub(r"<p>\s*</p>", "", html)
    html = re.sub(r"(</(?:p|h[2-6]|ul|ol|table|blockquote)>)", r"\1\n", html)
    return html.strip()


def main() -> None:
    OUT.mkdir(exist_ok=True)
    rows = []
    for page in sorted(SITE.glob("*/index.html")) + [SITE / "index.html"]:
        slug = page.parent.name if page.parent != SITE else "home"
        if slug in DROP_PAGES:
            continue
        soup = BeautifulSoup(page.read_text("utf-8", "replace"), "html.parser")

        body_cls = " ".join(soup.body.get("class") or []) if soup.body else ""
        m = re.search(r"page-id-(\d+)", body_cls)
        if not m:
            print(f"  ! {slug}: no page id on the body tag, skipped")
            continue
        content = soup.select_one(f"div.elementor-{m.group(1)}")
        if content is None:
            # A page written in the classic editor rather than Elementor has no
            # block of its own; <main> is the theme's content wrapper.
            content = soup.select_one("main")
        if content is None:
            print(f"  ! {slug}: no content area found, skipped")
            continue

        dropped = drop_demo(content)

        embeds: list[str] = []
        for widget in content.select("[data-widget_type]"):
            if not widget.get("data-widget_type", "").startswith(EMBED_WIDGETS):
                continue
            inner = widget.select_one(".elementor-widget-container")
            if inner is None:
                continue
            if not inner.find(["script", "iframe"]):
                continue    # prose in an html widget is still prose
            embeds.append("".join(str(c) for c in inner.children).strip())
            widget.replace_with(NavigableString(EMBED_TOKEN % (len(embeds) - 1)))

        out: list[str] = []
        clean(content, out)
        html = tidy("".join(out))

        title = (soup.title.string or "").strip() if soup.title else slug
        desc = ""
        tag = soup.find("meta", attrs={"name": "description"})
        if tag:
            desc = tag.get("content", "")
        h1 = content.find(["h1"])
        heading = h1.get_text(" ", strip=True) if h1 else title.split("–")[0].strip()

        (OUT / f"{slug}.json").write_text(json.dumps({
            "slug": slug,
            "title": title,
            "heading": heading,
            "description": desc,
            "body": html,
            "embeds": embeds,
        }, indent=1, ensure_ascii=False))
        words = len(re.sub(r"<[^>]+>", " ", html).split())
        rows.append((slug, words, len(embeds), dropped))

    rows.sort(key=lambda r: -r[1])
    print(f"  {len(rows)} pages")
    for slug, words, n, dropped in rows:
        mark = f"  +{n} embed" + ("s" if n != 1 else "") if n else ""
        if dropped:
            mark += f"  (-{dropped} demo)"
        print(f"    {slug:46s}{words:6d} words{mark}")


if __name__ == "__main__":
    main()
