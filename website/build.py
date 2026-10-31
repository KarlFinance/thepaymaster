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
import html
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).parent
SITE = HERE / "site"
DIST = HERE / "dist"
OVERLAY = HERE / "overlay"
FUNCTIONS = HERE / "functions"
DOMAIN = "https://thepaymaster.co.uk"
PHONE = "+44 20 7038 6792"          # the one public number (24 Oct 2026)
PHONE_TEL = "+442070386792"

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
REDIRECTS = """/start-transaction/  /enquiry  301
/start-transaction  /enquiry  301
/wp-login.php  /  301
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


# ---------------------------------------------------------------------------
# The website's own forms, replacing the HubSpot embeds.
#
# Five pages embedded a HubSpot form. Each embed is swapped for a plain HTML
# form with the same fields, labels, options and thank-you page, posting to
# the platform, which keeps a record and emails staff. The definitions live in
# platform/src/site-forms.json — the same file the platform validates against
# — so the page and the server can never disagree about a field.
# ---------------------------------------------------------------------------
FORMS_JSON = HERE.parent / "platform" / "src" / "site-forms.json"
FORM_ACTION = "https://client.thepaymaster.co.uk/site-form/"
# Cloudflare Turnstile, widget "ThePaymaster forms" (the site key is public). Loaded once per
# page however many forms it carries; the platform verifies the token on submission.
TURNSTILE_SITEKEY = "0x4AAAAAAFn2yf5ILAKBjqKm"
TURNSTILE_LOADER = ("<script>if(!window.__tpmTurnstile){window.__tpmTurnstile=1;var s=document.createElement('script');"
                    "s.src='https://challenges.cloudflare.com/turnstile/v0/api.js';s.async=true;s.defer=true;document.head.appendChild(s);}</script>")
HUBSPOT_FORM_IDS = {
    "4d6a8576-c0c2-45fa-b1e3-0862f4e89180": "briefing-evaluation",
    "3aae0322-b41b-430c-bf26-c50ef872904b": "contact-us",
    "4e6e7ff7-55dd-40a0-a412-a219b2dfb471": "crypto-transactions",
    "6f79b5e6-dfc0-4cc5-aaff-2be1168953b2": "introducer-program",
    "44b9842a-8b7a-48b5-832c-54a51ca4f2d0": "recipient-onboarding",
}
HS_V2 = re.compile(
    r'<script[^>]*js\.hsforms\.net/forms/embed/v2\.js[^>]*></script>\s*'
    r'<script>\s*hbspt\.forms\.create\(\{(?P<body>.*?)\}\);?\s*</script>', re.S)
# Brevo's newsletter form on every page, and the three WordPress (WPForms)
# forms. Both go: the forms are ours now, and nothing talks to WordPress.
# The container opens two divs before the form (#sib-form-container and
# #sib-container), so both closing tags after it go too — leaving one behind
# closed the footer's left column early and collapsed its layout.
BREVO_FORM = re.compile(r'<div id="sib-form-container" class="sib-form-container">.*?</form>\s*</div>\s*</div>', re.S)
BREVO_SCRIPT = re.compile(r'<script defer src="https://sibforms\.com/forms/end-form/build/main\.js"></script>')
WPFORMS = re.compile(r'<div class="wpforms-container[^"]*"[^>]*id="wpforms-(?P<id>\d+)".*?</form>\s*</div>', re.S)
WPFORMS_IDS = {"5932": "transaction-brief", "7470": "source-of-funds-verification", "7419": "ppp-stage-one-evaluation"}
# SuiteDash embeds on the start and join pages: both render nothing any more.
SUITEDASH = re.compile(r'<script src="https://app\.suitedash\.com/frm/(?P<k>[A-Za-z0-9]+)\.js"></script>')
SUITEDASH_IDS = {"2uyysgNpLFJNpvTXd": "recipient-onboarding"}
COUNTRIES_TS = HERE.parent / "platform" / "src" / "countries.ts"
HS_V4 = re.compile(
    r'<script[^>]*js\.hsforms\.net/forms/embed/\d+\.js[^>]*></script>\s*'
    r'<div class="hs-form-frame"[^>]*data-form-id="(?P<id>[^"]+)"[^>]*></div>', re.S)


def _esc(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


_COUNTRIES: list[tuple[str, str]] = []


def countries() -> list[tuple[str, str]]:
    if not _COUNTRIES:
        _COUNTRIES.extend(re.findall(r'\["([A-Z]{2})", "([^"]+)"\]', COUNTRIES_TS.read_text("utf-8")))
    return _COUNTRIES


def _show(f: dict) -> str:
    c = f.get("show_if")
    if not c:
        return ""
    cond = (f' data-show-field="{c["field"]}"' +
            (f' data-show-in="{_esc(json.dumps(c["in"]))}"' if "in" in c else "") +
            (f' data-show-min="{c["min"]}"' if "min" in c else ""))
    return cond + " hidden"


# A few lines that show a section when its trigger is chosen, and make its
# required fields required only while shown. Without JavaScript every section
# shows and the server still requires only what applies.
CONDITIONS_JS = """<script>(function(){document.querySelectorAll('form.tpm-form').forEach(function(form){
var deps=form.querySelectorAll('[data-show-field]');if(!deps.length)return;
function val(n){var els=form.querySelectorAll('[name="'+n+'"]');for(var i=0;i<els.length;i++){var e=els[i];
if(e.type==='radio'||e.type==='checkbox'){if(e.checked)return e.value}else return e.value}return ''}
function apply(){deps.forEach(function(d){var v=val(d.dataset.showField),ok;
if(d.dataset.showIn){ok=JSON.parse(d.dataset.showIn).indexOf(v)>=0}else{ok=Number(v)>=Number(d.dataset.showMin)}
d.hidden=!ok;d.querySelectorAll('[data-req]').forEach(function(i){i.required=ok})})}
form.addEventListener('change',apply);apply()})})();</script>"""


def render_form(slug: str, spec: dict) -> str:
    compact = " tpm-compact" if spec.get("compact") else ""
    out = [f'<form class="tpm-form{compact}" method="post" action="{FORM_ACTION}{slug}" '
           f'enctype="multipart/form-data" accept-charset="utf-8">']
    if spec.get("intro_html"):
        out.append(f'<div class="tpm-intro">{spec["intro_html"]}</div>')
    elif spec.get("intro"):
        out.append(f'<p class="tpm-intro">{_esc(spec["intro"])}</p>')
    for i, f in enumerate(spec["fields"]):
        fid = f"tpm-{slug}-{i}"
        cond = _show(f)
        # A conditional field is made required by the script only while shown.
        req = (" data-req" if f.get("show_if") else " required") if f.get("required") else ""
        if f["type"] == "note":
            out.append(f'<div class="tpm-note-block"{cond}>{f.get("html", "")}</div>')
            continue
        star = ' <span class="tpm-req">*</span>' if f.get("required") else ""
        help_ = f'<span class="tpm-help">{_esc(f["help"])}</span>' if f.get("help") else ""
        t = f["type"]
        if t in ("checkboxes", "radio"):
            kind = "checkbox" if t == "checkboxes" else "radio"
            single = kind == "checkbox" and len(f.get("options", [])) == 1
            opts = "".join(
                f'<label class="tpm-opt"><input type="{kind}" name="{f["name"]}" value="{_esc(o)}"'
                f'{req if (kind == "radio" and j == 0) or single else ""}> {_esc(o)}</label>'
                for j, o in enumerate(f.get("options", [])))
            legend = "" if spec.get("compact") else f'<legend>{_esc(f["label"])}{star}</legend>'
            out.append(f'<fieldset class="tpm-field"{cond}>{legend}{help_}{opts}</fieldset>')
            continue
        label = f'<label for="{fid}">{_esc(f["label"])}{star}</label>'
        if t == "select":
            opts = '<option value="">Please select</option>' + "".join(
                f'<option>{_esc(o)}</option>' for o in f.get("options", []))
            ctl = f'<select id="{fid}" name="{f["name"]}"{req}>{opts}</select>'
        elif t == "textarea":
            ctl = f'<textarea id="{fid}" name="{f["name"]}" rows="4"{req}></textarea>'
        elif t == "file":
            ctl = (f'<input id="{fid}" type="file" name="{f["name"]}" multiple '
                   f'accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv"{req}>')
        elif t == "country":
            opts = '<option value="">Please select</option>' + "".join(
                f'<option>{_esc(n)}</option>' for _, n in countries())
            ctl = f'<select id="{fid}" name="{f["name"]}"{req}>{opts}</select>'
        elif t == "signature":
            ctl = f'<input id="{fid}" type="text" name="{f["name"]}" class="tpm-signature" autocomplete="name"{req}>'
            help_ = help_ or '<span class="tpm-help">Typing your full name here is your signature. It is recorded with the date and time.</span>' 
        else:
            html_type = {"email": "email", "tel": "tel", "number": "number", "date": "date"}.get(t, "text")
            extra = ' autocomplete="email"' if t == "email" else ' autocomplete="tel"' if t == "tel" else ""
            ctl = f'<input id="{fid}" type="{html_type}" name="{f["name"]}"{extra}{req}>'
        out.append(f'<div class="tpm-field"{cond}>{label}{help_}{ctl}</div>')
    out.append('<div class="tpm-hp" aria-hidden="true"><label>Leave this empty '
               '<input name="website" tabindex="-1" autocomplete="off"></label></div>')
    if spec.get("agreement"):
        out.append(f'<p class="tpm-note">By pressing {_esc(spec["submit"])} you accept the {_esc(spec["agreement"])}.</p>')
    if spec.get("footnote"):
        out.append(f'<p class="tpm-note">{_esc(spec["footnote"])}</p>')
    out.append('<p class="tpm-note">Your details go only to ThePaymaster and are handled under our '
               '<a href="/privacy-policy/">privacy policy</a>.</p>')
    # Cloudflare Turnstile: checked by the platform before the submission is kept.
    size = ' data-size="flexible"' if spec.get("compact") else ""
    out.append(f'<div class="cf-turnstile" data-sitekey="{TURNSTILE_SITEKEY}" data-action="{slug}"{size} '
               f'style="margin:14px 0 6px"></div>{TURNSTILE_LOADER}')
    out.append(f'<button type="submit" class="tpm-submit">{_esc(spec["submit"])}</button></form>')
    if any(f.get("show_if") for f in spec["fields"]):
        out.append(CONDITIONS_JS)
    return "".join(out)


def own_forms(text: str) -> tuple[str, int]:
    if not any(k in text for k in ("hsforms", "sib-form", "wpforms-form", "suitedash.com/frm")):
        return text, 0
    specs = json.loads(FORMS_JSON.read_text("utf-8"))
    swapped = 0

    def brevo(m: re.Match) -> str:
        nonlocal swapped
        swapped += 1
        return render_form("newsletter", specs["newsletter"])

    def wp(m: re.Match) -> str:
        nonlocal swapped
        slug = WPFORMS_IDS.get(m.group("id"))
        if not slug:
            return m.group(0)
        swapped += 1
        return render_form(slug, specs[slug])

    text = BREVO_FORM.sub(brevo, text)
    text = BREVO_SCRIPT.sub("", text)
    text = WPFORMS.sub(wp, text)

    def sd(m: re.Match) -> str:
        nonlocal swapped
        swapped += 1
        slug = SUITEDASH_IDS.get(m.group("k"))
        if slug:
            return render_form(slug, specs[slug])
        # The start page: the platform's own start form is the front door.
        return ('<p><a class="tpm-submit" style="display:inline-block;text-decoration:none" '
                'href="/enquiry">Start a transaction</a></p>')

    text = SUITEDASH.sub(sd, text)

    def v2(m: re.Match) -> str:
        nonlocal swapped
        fid = re.search(r'formId:\s*"([^"]+)"', m.group("body"))
        slug = HUBSPOT_FORM_IDS.get(fid.group(1) if fid else "")
        if not slug:
            return m.group(0)
        swapped += 1
        return render_form(slug, specs[slug])

    def v4(m: re.Match) -> str:
        nonlocal swapped
        slug = HUBSPOT_FORM_IDS.get(m.group("id"))
        if not slug:
            return m.group(0)
        swapped += 1
        return render_form(slug, specs[slug])

    text = HS_V2.sub(v2, text)
    text = HS_V4.sub(v4, text)
    return text, swapped


def edits(text: str) -> str:
    text = START_BUTTON.sub(r"\1/enquiry\3", text)
    text = TWITTER_ITEM.sub("", text)
    text = CLOUDWAYS.sub("", text)
    text = SOFIE_ITEM.sub("", text)
    # One phone number, everywhere: the contact page's card listed two.
    text = re.sub(r"\+44 20 7088 8267<br>\s*\+44 20 7088 8663<br>", PHONE + "<br>", text)
    for oldnum in ("+44 20 7088 8267", "+44 20 7088 8663"):
        text = text.replace(oldnum, PHONE)
    text = text.replace("+442070888267", PHONE_TEL).replace("+442070888663", PHONE_TEL)
    # The old HubSpot chat box (with its tracking and cookie banner) — gone, 31 Oct 2026.
    text = re.sub(r"<script async defer id='hs-script-loader' src=\"https://js\.hs-scripts\.com/[^\"]*\"></script>", "", text)
    text = text.replace("<link rel='dns-prefetch' href='//js.hs-scripts.com' />", "")
    # Google reCAPTCHA and the Brevo newsletter's leftovers: the forms use Turnstile now.
    text = re.sub(r'<script[^>]*src="https://www\.google\.com/recaptcha/api\.js[^"]*"[^>]*></script>', "", text)
    text = re.sub(r'<script id="wpforms-recaptcha-js-after">.*?</script>', "", text, flags=re.S)
    text = text.replace('<link rel="stylesheet" href="https://sibforms.com/forms/end-form/build/sib-styles.css">', "")
    # Site Kit's "Sign in with Google" for WordPress logins: there is no WordPress to log into.
    text = text.replace('<script src="https://accounts.google.com/gsi/client"></script>', "")
    text = re.sub(r'<script data-siwg-config="[^"]*" src="/wp-content/plugins/google-site-kit/[^"]*"[^>]*></script>', "", text)
    # WhatsApp bottom right, where the chat box was.
    text = text.replace('class="joinchat joinchat--left"', 'class="joinchat joinchat--right"')
    # A stray "n" before a bullet in the Peaceful Enjoyment summary line.
    text = text.replace("interview n\u2022", "interview \u2022")
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


# ---------------------------------------------------------------------------
# Search: titles, descriptions, sharing tags, canonical addresses, noindex and
# structured data, from seo.json. Pages not listed keep what they had.
# ---------------------------------------------------------------------------
SEO = json.loads((HERE / "seo.json").read_text())


def _attr(s: str) -> str:
    return html.escape(s, quote=True)


def page_url(f: Path) -> str:
    rel = f.relative_to(DIST).as_posix()
    return "/" if rel == "index.html" else "/" + rel[: -len("index.html")]


def faq_jsonld(text: str) -> str | None:
    cards = re.findall(r'<span class="ekit-accordion-title">(.*?)</span>.*?<div class="elementskit-card-body[^"]*">(.*?)</div>\s*</div>\s*</div>', text, re.S)
    clean = lambda v: re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", v))).strip().replace(" ®", "®")
    items = [{"@type": "Question", "name": clean(q), "acceptedAnswer": {"@type": "Answer", "text": clean(a)}} for q, a in cards if clean(q) and clean(a)]
    if not items:
        return None
    return json.dumps({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": items}, ensure_ascii=False)


def org_jsonld() -> str:
    s = SEO["site"]
    return json.dumps({
        "@context": "https://schema.org", "@type": "FinancialService",
        "@id": s["url"] + "/#organization",
        "name": s["name"], "legalName": s["legalName"], "url": s["url"] + "/",
        "logo": s["logo"], "image": s["image"], "telephone": s["telephone"],
        "description": SEO["pages"]["/"]["description"],
        "address": {"@type": "PostalAddress", "streetAddress": s["street"], "addressLocality": s["city"],
                    "postalCode": s["postcode"], "addressCountry": s["country"]},
        "areaServed": "Worldwide", "priceRange": "1% of the distribution",
        "identifier": {"@type": "PropertyValue", "propertyID": "Companies House", "value": s["companyNumber"]},
    }, ensure_ascii=False)


def seo(f: Path, text: str) -> str:
    url = page_url(f)
    meta = SEO["pages"].get(url)
    if meta is None or "</head>" not in text:
        return text
    full = SEO["site"]["url"] + url
    head = []
    # Absolute canonical, replacing WordPress's relative one.
    text = re.sub(r'<link rel="canonical"[^>]*>\s*', "", text)
    head.append(f'<link rel="canonical" href="{full}">')
    if meta.get("noindex"):
        text = re.sub(r"<meta name='robots' content='[^']*' />", "", text)
        head.append('<meta name="robots" content="noindex, follow">')
    else:
        title = meta["title"]
        desc = meta["description"]
        text = re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", text, count=1, flags=re.S)
        text = re.sub(r'<meta name="description"[^>]*>\s*', "", text)
        head += [
            f'<meta name="description" content="{_attr(desc)}">',
            '<meta property="og:type" content="website">',
            f'<meta property="og:site_name" content="ThePaymaster®">',
            f'<meta property="og:title" content="{_attr(title)}">',
            f'<meta property="og:description" content="{_attr(desc)}">',
            f'<meta property="og:url" content="{full}">',
            f'<meta property="og:image" content="{SEO["site"]["image"]}">',
            '<meta property="og:locale" content="en_GB">',
            '<meta name="twitter:card" content="summary">',
            f'<meta name="twitter:title" content="{_attr(title)}">',
            f'<meta name="twitter:description" content="{_attr(desc)}">',
        ]
        if url == "/":
            head.append(f'<script type="application/ld+json">{org_jsonld()}</script>')
        if url == "/faqs/":
            faq = faq_jsonld(text)
            if faq:
                head.append(f'<script type="application/ld+json">{faq}</script>')
    # A decorative loading spinner needs an empty alt, so screen readers skip it.
    text = re.sub(r'(<img\b(?![^>]*\balt=)[^>]*spinner\.png[^>]*?)(\s*/?>)', r'\1 alt=""\2', text)
    return text.replace("</head>", "".join(head) + "</head>", 1)


def sitemap() -> int:
    """Every page that is meant to be found, from the build itself."""
    from datetime import date
    today = date.today().isoformat()
    urls = sorted(u for u, m in SEO["pages"].items() if not m.get("noindex"))
    urls += ["/enquiry", "/distribute"]
    body = "".join(f"  <url><loc>{SEO['site']['url']}{u}</loc><lastmod>{today}</lastmod></url>\n" for u in urls)
    (DIST / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                                      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                                      f"{body}</urlset>\n")
    return len(urls)


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SITE, DIST)

    stripped = 0
    forms_swapped = 0
    for f in DIST.rglob("*.html"):
        text = f.read_text("utf-8", "replace")
        new = DEAD_HEAD_EXTRA.sub("", DEAD_HEAD.sub("", text))
        new = edits(new)
        new, n = own_forms(new)
        forms_swapped += n
        new = seo(f, new)
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

    # Built from seo.json, never copied from the live site: copying it once
    # republished a Worker error page as the sitemap for weeks.
    pages = range(sitemap())

    files = sum(1 for f in DIST.rglob("*") if f.is_file())
    size = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"  dist        {files} files, {size/1024/1024:.1f} MB")
    print(f"  head links  stripped from {stripped} pages")
    print(f"  overlay     linked into {linked} pages")
    print(f"  own forms   {forms_swapped} HubSpot, Brevo and WordPress forms replaced")
    print(f"  sitemap     {len(pages)} pages")
    fns = len(list((DIST / "functions").rglob("*.js"))) if (DIST / "functions").is_dir() else 0
    print(f"  functions   {fns}")


if __name__ == "__main__":
    main()
