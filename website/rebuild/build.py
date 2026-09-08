"""
Typeset the extracted content into a static site.

One stylesheet, one template, no framework. The design is the one the site
already has — same palette, same typeface, same page order — rebuilt so that a
page is a page rather than seventy-four stylesheets and a database.

    python3 build.py        # content/*.json -> dist/

The three WordPress form pages are absent by design: the worker sends those
straight to Cloudways, and they are never ours to render.
"""
from __future__ import annotations

import html
import json
import re
import shutil
from pathlib import Path

HERE = Path(__file__).parent
CONTENT = HERE / "content"
ASSETS = HERE / "assets"
CAPTURE = HERE.parent / "site"          # for the images and files we reuse
OUT = HERE / "dist"

DOMAIN = "https://thepaymaster.co.uk"
LOGO = "/wp-content/uploads/2025/05/Thepaymaster-logo-300x100-1.png"

# Plus Jakarta Sans, self-hosted. These are the files the live site has always
# pointed at and never managed to load: Elementor wrote the URLs against the raw
# Cloudways hostname, whose certificate does not carry that name, so every one
# of them failed and the site fell back to a system face. Same files, served
# from the root, so they actually arrive.
FONT_CSS = "/wp-content/uploads/elementor/google-fonts/css/plusjakartasans.css"

# Lifted from the live header, in the live order. "Services" is the only branch.
NAV = [
    ("Home", "/"),
    ("How It Works", "/how-it-works/"),
    ("Why Choose Us?", "/why-choose-us/"),
    ("Crypto", "/crypto-transactions/"),
    ("FAQs", "/faqs/"),
    ("Contact Us", "/contact-us/"),
    ("Services", [
        ("Tax Advisory Service", "/tax-advisory-service/"),
        ("Karl Finance", "https://karl.finance/"),
        ("Peaceful Enjoyment", "/peaceful-enjoyment/"),
    ]),
]

FOOTER_LINKS = [
    ("About Us", "/about-us/"),
    ("Anti Bribery &amp; Corruption Policy", "/anti-bribery-corruption-policy/"),
    ("Anti-Money Laundering Statement", "/anti-money-laundering-statement/"),
    ("Complaints Policy", "/complaints-policy/"),
    ("Cookie Policy", "/cookie-policy/"),
    ("Customer Relations Charter", "/customer-relations-charter/"),
    ("Introducer Agreement",
     "/wp-content/uploads/2025/01/ThePaymaster-Introducer-Agreement.pdf"),
    ("Intellectual Property Statement", "/intellectual-property-statement/"),
    ("Modern Slavery &amp; Human Trafficking Statement",
     "/modern-slavery-human-trafficking-statement/"),
    ("Peaceful Enjoyment", "/peaceful-enjoyment/"),
    ("Privacy Policy", "/privacy-policy/"),
    ("Regulatory Framework", "/regulatory-framework/"),
    ("Sustainability &amp; Carbon Neutral Policy",
     "/sustainability-carbon-neutral-policy/"),
    ("Terms &amp; Conditions", "/terms-conditions/"),
    ("Training &amp; Development Policy", "/training-development-policy/"),
    ("Trust &amp; Security Policy", "/trust-security-policy/"),
]

SOCIALS = [
    ("LinkedIn", "https://www.linkedin.com/company/thepaymaster-limited/"),
    ("X", "https://x.com/thepaymasterltd"),
]

# The newsletter posts straight to Brevo, as it does now — no server of ours in
# the path, so it keeps working with nothing to maintain.
BREVO = ("https://4d40c94e.sibforms.com/serve/MUIFAMxiIFpXF3AL-bS8CEgX9h9yP6-3"
         "PvNXX4b22pXuxwkt8GNvqOojXxm4LG3EAahv5WC7oI6SZNbGxOGwfZhCZSTQuEQW81UF"
         "XqPw9IQ7UTnNIf6zK9rmXIMVvWXiKFKJr7Sw9r9pVdBnjOJnWC1")

TAGLINE = "Trust in every transaction. Confidence in every step."
PHONE = "+44 20 7088 8267"
EMAIL = "info@thepaymaster.co.uk"
COMPANY = "ThePaymaster Ltd®"

# Assets the rebuild actually uses, copied across from the capture rather than
# the whole 18MB of Elementor's leftovers.
ASSET_DIRS = ["wp-content/uploads/elementor/google-fonts"]


def nav_html(current: str) -> str:
    items = []
    for label, target in NAV:
        if isinstance(target, list):
            kids = "".join(
                f'<li><a href="{href}">{name}</a></li>' for name, href in target)
            items.append(
                f"<li><details><summary>{label}</summary><ul>{kids}</ul></details></li>")
        else:
            aria = ' aria-current="page"' if target == current else ""
            items.append(f'<li><a href="{target}"{aria}>{label}</a></li>')
    return f'<nav class="nav"><ul>{"".join(items)}</ul></nav>'


def crumbs_html(heading: str, is_home: bool) -> str:
    if is_home:
        return ""
    return (
        '<ol class="crumbs">'
        '<li><a href="/">Home</a></li>'
        '<li class="sep" aria-hidden="true">/</li>'
        f"<li>{heading}</li>"
        "</ol>")


def footer_html() -> str:
    links = "".join(f'<li><a href="{h}">{t}</a></li>' for t, h in FOOTER_LINKS)
    socials = "".join(
        f'<li><a href="{h}" rel="noopener">{t}</a></li>' for t, h in SOCIALS)
    return f"""<footer class="colophon">
<div class="shell">
<h2>{TAGLINE}</h2>
<div class="cols">
  <div class="signup">
    <h3>Stay Updated</h3>
    <p>Subscribe to our newsletter today!</p>
    <form action="{BREVO}" method="POST" target="_blank">
      <label class="visually-hidden" for="nl-email">Email address</label>
      <input id="nl-email" type="email" name="EMAIL" placeholder="you@company.com" required>
      <button type="submit">Subscribe</button>
    </form>
    <small>I agree to receive your newsletters and accept the data privacy
      statement. Your details are held by Brevo —
      <a href="https://www.brevo.com/en/legal/privacypolicy/" rel="noopener">their
      privacy policy</a>.</small>
  </div>
  <div class="links"><h3>Quick Links</h3><ul>{links}</ul></div>
  <div>
    <h3>Say Hello</h3>
    <ul>
      <li><a href="tel:{PHONE.replace(' ', '')}">{PHONE}</a></li>
      <li><a href="mailto:{EMAIL}">{EMAIL}</a></li>
      <li>{COMPANY}</li>
    </ul>
    <h3 style="margin-top:28px">Socials</h3>
    <ul>{socials}</ul>
  </div>
</div>
<div class="baseline">© ThePaymaster Ltd ® 2026. All rights reserved.</div>
</div>
</footer>"""


def restore_embeds(body: str, embeds: list[str]) -> str:
    """Put the third-party embeds back where the extractor took them from."""
    for i, raw in enumerate(embeds):
        body = body.replace(f"@@EMBED-{i}@@", f'<div class="embed">{raw}</div>')
    # Any token whose embed went missing leaves nothing behind rather than
    # printing @@EMBED-3@@ at a visitor.
    return re.sub(r"@@EMBED-\d+@@", "", body)


def wrap_tables(body: str) -> str:
    return re.sub(r"(<table\b)", r'<div class="scroll">\1', body).replace(
        "</table>", "</table></div>")


def page(doc: dict) -> str:
    slug = doc["slug"]
    is_home = slug == "home"
    path = "/" if is_home else f"/{slug}/"
    heading = doc["heading"]
    title = doc["title"] or heading
    desc = doc["description"] or TAGLINE

    body = wrap_tables(restore_embeds(doc["body"], doc.get("embeds", [])))

    return f"""<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title, quote=False)}</title>
<meta name="description" content="{html.escape(desc, quote=True)}">
<link rel="canonical" href="{DOMAIN}{path}">
<meta property="og:title" content="{html.escape(title, quote=True)}">
<meta property="og:description" content="{html.escape(desc, quote=True)}">
<meta property="og:url" content="{DOMAIN}{path}">
<meta property="og:type" content="website">
<link rel="stylesheet" href="{FONT_CSS}">
<link rel="stylesheet" href="/assets/site.css">
<link rel="icon" href="{LOGO}">
</head>
<body>
<a class="visually-hidden" href="#main">Skip to content</a>
<header class="masthead">
  <div class="shell">
    <a class="wordmark" href="/"><img src="{LOGO}" alt="ThePaymaster" width="120" height="34"></a>
    {nav_html(path)}
  </div>
</header>
<main id="main">
<div class="band"><div class="shell">
  <h1>{html.escape(heading, quote=False)}</h1>
  {crumbs_html(html.escape(heading, quote=False), is_home)}
</div></div>
<div class="prose"><div class="shell">
{body}
</div></div>
</main>
{footer_html()}
</body>
</html>"""


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    docs = [json.loads(f.read_text("utf-8")) for f in sorted(CONTENT.glob("*.json"))]
    for doc in docs:
        target = OUT / "index.html" if doc["slug"] == "home" \
            else OUT / doc["slug"] / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page(doc), "utf-8")

    shutil.copytree(ASSETS, OUT / "assets", dirs_exist_ok=True)

    # Only the images and files the pages actually reference get copied.
    wanted: set[str] = {LOGO.lstrip("/")}
    for doc in docs:
        blob = doc["body"] + "".join(doc.get("embeds", []))
        wanted.update(m.lstrip("/") for m in
                      re.findall(r'(?:src|href)="(/wp-[^"?]+)"', blob))
    for _, href in FOOTER_LINKS:
        if href.startswith("/wp-"):
            wanted.add(href.lstrip("/"))
    for d in ASSET_DIRS:
        for f in (CAPTURE / d).rglob("*"):
            if f.is_file():
                wanted.add(str(f.relative_to(CAPTURE)))

    copied = missing = 0
    for rel in sorted(wanted):
        src = CAPTURE / rel
        if not src.is_file():
            missing += 1
            continue
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1

    urls = "".join(
        f"  <url><loc>{DOMAIN}/"
        f"{'' if d['slug'] == 'home' else d['slug'] + '/'}</loc></url>\n"
        for d in docs)
    (OUT / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{urls}</urlset>\n")

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    pages_size = sum(f.stat().st_size for f in OUT.rglob("*.html"))
    print(f"  pages      {len(docs)}")
    print(f"  assets     {copied} copied, {missing} missing")
    print(f"  html       {pages_size/1024:.0f} KB total, "
          f"{pages_size/len(docs)/1024:.0f} KB average")
    print(f"  everything {size/1024/1024:.1f} MB")


if __name__ == "__main__":
    main()
