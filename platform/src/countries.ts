/**
 * Countries, as a list rather than a text box.
 *
 * Free text gave us "Etherium" for a chain and would give us "UK", "U.K.",
 * "England" and "Britain" for a country. A dossier that has to say where
 * somebody lives, and a screening that has to know which jurisdiction it is
 * looking at, both need one spelling. ISO 3166-1 alpha-2 is stored; the name
 * is shown.
 */

import { esc } from "./views.ts";

export const COUNTRIES: [string, string][] = [
  ["GB", "United Kingdom"], ["US", "United States"], ["AE", "United Arab Emirates"],
  ["AF", "Afghanistan"], ["AL", "Albania"], ["DZ", "Algeria"], ["AD", "Andorra"],
  ["AO", "Angola"], ["AG", "Antigua and Barbuda"], ["AR", "Argentina"], ["AM", "Armenia"],
  ["AU", "Australia"], ["AT", "Austria"], ["AZ", "Azerbaijan"], ["BS", "Bahamas"],
  ["BH", "Bahrain"], ["BD", "Bangladesh"], ["BB", "Barbados"], ["BY", "Belarus"],
  ["BE", "Belgium"], ["BZ", "Belize"], ["BJ", "Benin"], ["BM", "Bermuda"], ["BT", "Bhutan"],
  ["BO", "Bolivia"], ["BA", "Bosnia and Herzegovina"], ["BW", "Botswana"], ["BR", "Brazil"],
  ["BN", "Brunei"], ["BG", "Bulgaria"], ["BF", "Burkina Faso"], ["BI", "Burundi"],
  ["KH", "Cambodia"], ["CM", "Cameroon"], ["CA", "Canada"], ["CV", "Cape Verde"],
  ["KY", "Cayman Islands"], ["CF", "Central African Republic"], ["TD", "Chad"], ["CL", "Chile"],
  ["CN", "China"], ["CO", "Colombia"], ["KM", "Comoros"], ["CG", "Congo"],
  ["CD", "Congo, Democratic Republic of the"], ["CR", "Costa Rica"], ["CI", "Côte d'Ivoire"],
  ["HR", "Croatia"], ["CU", "Cuba"], ["CY", "Cyprus"], ["CZ", "Czechia"], ["DK", "Denmark"],
  ["DJ", "Djibouti"], ["DM", "Dominica"], ["DO", "Dominican Republic"], ["EC", "Ecuador"],
  ["EG", "Egypt"], ["SV", "El Salvador"], ["GQ", "Equatorial Guinea"], ["ER", "Eritrea"],
  ["EE", "Estonia"], ["SZ", "Eswatini"], ["ET", "Ethiopia"], ["FJ", "Fiji"], ["FI", "Finland"],
  ["FR", "France"], ["GA", "Gabon"], ["GM", "Gambia"], ["GE", "Georgia"], ["DE", "Germany"],
  ["GH", "Ghana"], ["GI", "Gibraltar"], ["GR", "Greece"], ["GD", "Grenada"], ["GT", "Guatemala"],
  ["GG", "Guernsey"], ["GN", "Guinea"], ["GW", "Guinea-Bissau"], ["GY", "Guyana"], ["HT", "Haiti"],
  ["HN", "Honduras"], ["HK", "Hong Kong"], ["HU", "Hungary"], ["IS", "Iceland"], ["IN", "India"],
  ["ID", "Indonesia"], ["IR", "Iran"], ["IQ", "Iraq"], ["IE", "Ireland"], ["IM", "Isle of Man"],
  ["IL", "Israel"], ["IT", "Italy"], ["JM", "Jamaica"], ["JP", "Japan"], ["JE", "Jersey"],
  ["JO", "Jordan"], ["KZ", "Kazakhstan"], ["KE", "Kenya"], ["KI", "Kiribati"],
  ["KP", "Korea, North"], ["KR", "Korea, South"], ["XK", "Kosovo"], ["KW", "Kuwait"],
  ["KG", "Kyrgyzstan"], ["LA", "Laos"], ["LV", "Latvia"], ["LB", "Lebanon"], ["LS", "Lesotho"],
  ["LR", "Liberia"], ["LY", "Libya"], ["LI", "Liechtenstein"], ["LT", "Lithuania"],
  ["LU", "Luxembourg"], ["MO", "Macao"], ["MG", "Madagascar"], ["MW", "Malawi"], ["MY", "Malaysia"],
  ["MV", "Maldives"], ["ML", "Mali"], ["MT", "Malta"], ["MH", "Marshall Islands"],
  ["MR", "Mauritania"], ["MU", "Mauritius"], ["MX", "Mexico"], ["FM", "Micronesia"],
  ["MD", "Moldova"], ["MC", "Monaco"], ["MN", "Mongolia"], ["ME", "Montenegro"], ["MA", "Morocco"],
  ["MZ", "Mozambique"], ["MM", "Myanmar"], ["NA", "Namibia"], ["NR", "Nauru"], ["NP", "Nepal"],
  ["NL", "Netherlands"], ["NZ", "New Zealand"], ["NI", "Nicaragua"], ["NE", "Niger"],
  ["NG", "Nigeria"], ["MK", "North Macedonia"], ["NO", "Norway"], ["OM", "Oman"],
  ["PK", "Pakistan"], ["PW", "Palau"], ["PS", "Palestine"], ["PA", "Panama"],
  ["PG", "Papua New Guinea"], ["PY", "Paraguay"], ["PE", "Peru"], ["PH", "Philippines"],
  ["PL", "Poland"], ["PT", "Portugal"], ["PR", "Puerto Rico"], ["QA", "Qatar"], ["RO", "Romania"],
  ["RU", "Russia"], ["RW", "Rwanda"], ["KN", "Saint Kitts and Nevis"], ["LC", "Saint Lucia"],
  ["VC", "Saint Vincent and the Grenadines"], ["WS", "Samoa"], ["SM", "San Marino"],
  ["ST", "São Tomé and Príncipe"], ["SA", "Saudi Arabia"], ["SN", "Senegal"], ["RS", "Serbia"],
  ["SC", "Seychelles"], ["SL", "Sierra Leone"], ["SG", "Singapore"], ["SK", "Slovakia"],
  ["SI", "Slovenia"], ["SB", "Solomon Islands"], ["SO", "Somalia"], ["ZA", "South Africa"],
  ["SS", "South Sudan"], ["ES", "Spain"], ["LK", "Sri Lanka"], ["SD", "Sudan"], ["SR", "Suriname"],
  ["SE", "Sweden"], ["CH", "Switzerland"], ["SY", "Syria"], ["TW", "Taiwan"], ["TJ", "Tajikistan"],
  ["TZ", "Tanzania"], ["TH", "Thailand"], ["TL", "Timor-Leste"], ["TG", "Togo"], ["TO", "Tonga"],
  ["TT", "Trinidad and Tobago"], ["TN", "Tunisia"], ["TR", "Türkiye"], ["TM", "Turkmenistan"],
  ["TV", "Tuvalu"], ["UG", "Uganda"], ["UA", "Ukraine"], ["UY", "Uruguay"], ["UZ", "Uzbekistan"],
  ["VU", "Vanuatu"], ["VA", "Vatican City"], ["VE", "Venezuela"], ["VN", "Vietnam"],
  ["VG", "Virgin Islands, British"], ["YE", "Yemen"], ["ZM", "Zambia"], ["ZW", "Zimbabwe"],
];

const BY_CODE = new Map(COUNTRIES);

/** The name for a stored code. An old free-text value is shown as it was. */
export function countryName(codeOrText: string | null | undefined): string {
  if (!codeOrText) return "";
  return BY_CODE.get(codeOrText.toUpperCase()) ?? codeOrText;
}

/**
 * A select, with the three we see most at the top and the rest alphabetical.
 *
 * `selected` may be a code or, from before this existed, a typed name; a typed
 * name that matches a country is selected, anything else is kept as an extra
 * option so nothing already on the record is lost by opening the form.
 */
export function countrySelect(opts: {
  name: string; id?: string; selected?: string | null; required?: boolean;
  blank?: string;
}): string {
  const sel = (opts.selected ?? "").trim();
  const byName = COUNTRIES.find(([, n]) => n.toLowerCase() === sel.toLowerCase());
  const code = BY_CODE.has(sel.toUpperCase()) ? sel.toUpperCase() : byName?.[0] ?? "";
  const legacy = sel && !code
    ? `<option value="${esc(sel)}" selected>${esc(sel)} (as typed)</option>` : "";
  const top = COUNTRIES.slice(0, 3);
  const rest = COUNTRIES.slice(3).sort((a, b) => a[1].localeCompare(b[1]));
  const option = ([c, n]: [string, string]) =>
    `<option value="${c}"${c === code ? " selected" : ""}>${esc(n)}</option>`;
  return `<select name="${esc(opts.name)}"${opts.id ? ` id="${esc(opts.id)}"` : ""}${
    opts.required ? " required" : ""} autocomplete="country">
    <option value="">${esc(opts.blank ?? "Choose a country")}</option>
    ${legacy}
    ${top.map(option).join("")}
    <option disabled>──────────</option>
    ${rest.map(option).join("")}
  </select>`;
}
