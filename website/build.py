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

    # The page list comes from WordPress. When the WordPress box does not
    # answer, keep the sitemap that is live now rather than failing the build.
    try:
        pages = page_list()
        urls = "".join(
            f"  <url><loc>{u}</loc><lastmod>{m}</lastmod></url>\n" for u, m in pages)
        (DIST / "sitemap.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            f"{urls}</urlset>\n")
    except Exception as err:
        live = subprocess.run(["curl", "-sS", "-m", "30", f"{DOMAIN}/sitemap.xml"],
                              capture_output=True, text=True, check=True).stdout
        (DIST / "sitemap.xml").write_text(live)
        pages = re.findall(r"<loc>", live)
        print(f"  sitemap     WordPress unreachable ({type(err).__name__}); kept the live sitemap")

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
