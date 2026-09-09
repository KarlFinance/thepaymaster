/**
 * The website's own furniture, for pages the platform serves.
 *
 * The enquiry form, the client area and the sender's screens are served by
 * this worker rather than by the captured site, so without this they arrive
 * with no logo, no menu, no favicon and no way back — which is exactly where
 * a careful person stops trusting a page that is about to ask them about
 * money. The menu and policy links below were read off the live site, not
 * invented, and should be re-read if the site's navigation changes.
 */

export const SITE = "https://thepaymaster.co.uk";

/**
 * The year, worked out per request.
 *
 * Not at module scope. A Worker evaluates its global scope during startup,
 * before any request exists, and at that point the clock reads zero — so a
 * year captured there renders as 1970 for the life of the deployment. It did,
 * on the live footer, until this was moved into a function.
 */
export const thisYear = (): number => new Date().getFullYear();

/** The site's own icons, so the tab matches every other page. */
export const FAVICON = `
<link rel="icon" href="${SITE}/wp-content/uploads/2025/08/cropped-fav-32x32.png" sizes="32x32">
<link rel="icon" href="${SITE}/wp-content/uploads/2025/08/cropped-fav-192x192.png" sizes="192x192">
<link rel="apple-touch-icon" href="${SITE}/wp-content/uploads/2025/08/cropped-fav-180x180.png">`;

const MENU: [string, string][] = [
  ["Home", "/"],
  ["How It Works", "/how-it-works/"],
  ["Why Choose Us?", "/why-choose-us/"],
  ["Crypto", "/crypto-transactions/"],
  ["FAQs", "/faqs/"],
  ["Contact Us", "/contact-us/"],
];

/**
 * The Quick Links column, as it stands on the website. Read off the live
 * footer rather than composed here, so the two agree.
 */
const QUICK: [string, string][] = [
  ["About Us", "/about-us/"],
  ["Anti Bribery & Corruption Policy", "/anti-bribery-corruption-policy/"],
  ["Anti-Money Laundering Statement", "/anti-money-laundering-statement/"],
  ["Complaints Policy", "/complaints-policy/"],
  ["Cookie Policy", "/cookie-policy/"],
  ["Customer Relations Charter", "/customer-relations-charter/"],
  ["Introducer Agreement", "/wp-content/uploads/2025/01/ThePaymaster-Introducer-Agreement.pdf"],
  ["Intellectual Property Statement", "/intellectual-property-statement/"],
  ["Modern Slavery & Human Trafficking Statement", "/modern-slavery-human-trafficking-statement/"],
  ["Peaceful Enjoyment", "/peaceful-enjoyment/"],
  ["Privacy Policy", "/privacy-policy/"],
  ["Regulatory Framework", "/regulatory-framework/"],
  ["Sustainability & Carbon Neutral Policy", "/sustainability-carbon-neutral-policy/"],
  ["Terms & Conditions", "/terms-conditions/"],
  ["Training & Development Policy", "/training-development-policy/"],
  ["Trust & Security Policy", "/trust-security-policy/"],
];

export const SITE_HEAD = `<header class="sitehead"><div class="in">
  <a href="${SITE}/" class="brand"><img
    src="${SITE}/wp-content/uploads/2025/05/Thepaymaster-logo-300x100-1-300x86.png"
    alt="ThePaymaster" width="150" height="43"></a>
  <nav class="sitenav">${MENU
    .map(([label, href]) => `<a href="${SITE}${href}">${label}</a>`).join("")}</nav>
</div></header>`;

/**
 * The website's footer, reproduced.
 *
 * One deliberate omission: the Brevo newsletter sign-up. It is a third-party
 * script, and a page in the middle of a transaction is the wrong place to load
 * one or to ask somebody to subscribe to anything. Everything else — the logo,
 * the line, all sixteen links, the contact block, the closing line — is what
 * the site carries.
 */
export function siteFoot(): string {
  return `<footer class="sitefoot"><div class="in">
    <div class="grid">
      <div class="left">
        <a href="${SITE}/"><img class="mark"
          src="${SITE}/wp-content/uploads/2024/05/b-logo.png"
          alt="ThePaymaster — from Karl Finance" width="250" height="72"></a>
      </div>
      <div class="right">
        <p class="line">Trust in every transaction.<br>Confidence in every step.</p>
        <div class="cols">
          <div class="quick">
            <strong>Quick Links</strong>
            <ul>${QUICK
              .map(([label, href]) => `<li><a href="${SITE}${href}">${label}</a></li>`).join("")}</ul>
          </div>
          <div>
            <strong>Socials</strong>
            <ul><li><a href="https://www.linkedin.com/company/thepaymaster-limited/"
              >Linkedin</a></li></ul>
          </div>
          <div>
            <strong>Say Hello</strong>
            <p><a href="mailto:info@thepaymaster.co.uk">info@thepaymaster.co.uk</a></p>
            <p><a href="tel:+442070888267">+44 20 7088 8267</a></p>
            <p>ThePaymaster Ltd&reg;</p>
          </div>
        </div>
      </div>
    </div>
    <div class="rule">&copy; ThePaymaster Ltd &reg; ${thisYear()} All Rights Reserved</div>
  </div></footer>`;
}

export const CHROME_CSS = `
.sitehead{border-bottom:1px solid var(--rule,#DBDFEA);background:#fff}
.sitehead .in{max-width:1140px;margin:0 auto;padding:14px 20px;display:flex;
  align-items:center;gap:26px;flex-wrap:wrap}
.sitehead img{height:40px;width:auto;display:block}
.sitenav{display:flex;gap:20px;flex-wrap:wrap;margin-left:auto}
.sitenav a{color:var(--ink,#0C1524);text-decoration:none;font-weight:600;font-size:15px}
.sitenav a:hover{color:var(--accent,#FF8159)}

/* Measured off the live footer: capped at 1600px and centred, 40px radius.
   Left column carries the logo, right column the line over the link columns —
   the same geometry as the site, where the left also holds the newsletter. */
.sitefoot{background:#0C1524;color:#C9D1DD;border-radius:40px;
  max-width:1600px;margin:0 auto 20px;font-size:15px}
.sitefoot .in{padding:60px 60px 26px}
.sitefoot .grid{display:grid;grid-template-columns:0.95fr 1.6fr;gap:48px;
  align-items:start}
.sitefoot .mark{width:250px;height:auto;display:block}
.sitefoot .line{margin:0 0 46px;color:#fff;font-weight:800;letter-spacing:-.02em;
  font-size:clamp(26px,2.4vw,42px);line-height:1.16}
.sitefoot .cols{display:grid;grid-template-columns:1.25fr .75fr 1fr;gap:30px}
.sitefoot strong{color:#fff;display:block;margin-bottom:16px;font-size:19px;
  font-weight:800;letter-spacing:-.01em}
.sitefoot ul{list-style:disc;margin:0;padding-left:18px}
.sitefoot li{margin-bottom:9px;line-height:1.45}
.sitefoot p{margin:0 0 14px}
.sitefoot a{color:#C9D1DD;text-decoration:none}
.sitefoot a:hover{color:var(--accent,#FF8159)}
.sitefoot .rule{margin-top:46px;padding-top:20px;border-top:1px solid #23324A;
  text-align:center;font-size:14px;color:#93A0B4}
@media(max-width:1100px){
  .sitefoot{margin:0 14px 16px;border-radius:28px}
  .sitefoot .in{padding:40px 30px 22px}
  .sitefoot .grid{grid-template-columns:1fr;gap:28px}
  .sitefoot .line{margin-bottom:32px}
  .sitefoot .cols{grid-template-columns:1fr 1fr}
  .sitenav{gap:14px}.sitenav a{font-size:14px}}
@media(max-width:560px){.sitefoot .cols{grid-template-columns:1fr}}
`;
