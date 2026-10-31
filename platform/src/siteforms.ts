/**
 * The website's own forms.
 *
 * Five forms on thepaymaster.co.uk used to be HubSpot embeds. They are now
 * plain HTML forms, built into the static pages from site-forms.json (the
 * same file this module reads), posting here. A submission is kept as a
 * record — visible on the Website forms page in the admin — and staff are
 * emailed (STAFF_NOTIFY). Then the visitor is sent to the same thank-you page
 * HubSpot sent them to.
 *
 * No script is needed on the page, so nothing breaks if JavaScript is off,
 * and nothing about the visitor goes to a third party.
 */

import { type Env, type Actor, id, insert, update, log } from "./db.ts";
import { human, HUMAN_CHECK_FAILED } from "./turnstile.ts";
import { visitorId } from "./traffic.ts";
import { send, staffEmails } from "./email.ts";
import { esc } from "./views.ts";
import spec from "./site-forms.json" with { type: "json" };

export interface FieldSpec {
  name: string; label: string; type: string; required: boolean; options?: string[]; help?: string; html?: string;
  /** Shown only when another field has one of these values, or a number at least this. */
  show_if?: { field: string; in?: string[]; min?: number };
}
export interface FormSpec { title: string; page: string; submit: string; thanks: string; intro?: string; agreement?: string; fields: FieldSpec[] }

/** Is this field shown, given the answers? Hidden fields are never required and never kept. */
export function shown(fld: FieldSpec, values: Record<string, string | string[]>): boolean {
  if (!fld.show_if) return true;
  const v = values[fld.show_if.field];
  const one = Array.isArray(v) ? v[0] : v;
  if (fld.show_if.in) return fld.show_if.in.includes(String(one ?? ""));
  if (fld.show_if.min !== undefined) return Number(one) >= fld.show_if.min;
  return true;
}
export const FORMS = spec as unknown as Record<string, FormSpec>;

const SITE = "https://thepaymaster.co.uk";
const ADMIN = "https://admin.thepaymaster.co.uk";
const MAX_FILES = 12;
const MAX_BYTES = 15 * 1024 * 1024;
const FILE_OK = /\.(pdf|jpe?g|png|heic|webp|docx?|xlsx?|txt|csv)$/i;
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ThePaymaster</title>
<meta name="robots" content="noindex"><style>
body{margin:0;font:17px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;background:#F5F7FA;color:#4A5567}
main{max-width:620px;margin:60px auto;padding:32px;background:#fff;border:1px solid #DBDFEA;border-radius:8px}
h1{color:#0C1524;font-size:24px;margin:0 0 12px} a{color:#0C1524} li{margin:4px 0}
</style></head><body><main>${body}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** POST /site-form/<slug> on the client host. */
export async function submitSiteForm(request: Request, env: Env, slug: string, later: (p: Promise<unknown>) => void): Promise<Response> {
  const form = FORMS[slug];
  if (!form) return page("Not found", "<h1>That form does not exist</h1>", 404);
  if (request.method !== "POST") return Response.redirect(SITE + form.page, 303);

  let f: FormData;
  try { f = await request.formData(); }
  catch { return page("Something went wrong", `<h1>We could not read that</h1><p><a href="${SITE + form.page}">Go back and try again</a>.</p>`, 400); }

  // A bot fills every field it can see. This one is hidden from people.
  if (String(f.get("website") ?? "").trim()) return Response.redirect(SITE + form.thanks, 303);

  // And a person proves they are one, with Cloudflare Turnstile, before anything is kept.
  if (!(await human(env, request, f, slug))) {
    return page("Please try again", `<h1>Please try again</h1><p>${HUMAN_CHECK_FAILED}</p>
      <p><a href="javascript:history.back()">Go back to the form</a> — what you typed should still be there.</p>`, 400);
  }

  const values: Record<string, string | string[]> = {};
  const missing: string[] = [];
  for (const fld of form.fields) {
    if (fld.type === "file" || fld.type === "note") continue;
    if (fld.type === "checkboxes") {
      values[fld.name] = f.getAll(fld.name).map((v) => String(v).trim()).filter((v) => (fld.options ?? []).includes(v));
      continue;
    }
    const v = String(f.get(fld.name) ?? "").trim().slice(0, fld.type === "textarea" ? 5000 : 500);
    values[fld.name] = fld.options && v && !fld.options.includes(v) ? "" : v;
  }
  // Hidden sections are dropped, and only what is shown can be required.
  for (const fld of form.fields) {
    if (fld.type === "note") continue;
    if (!shown(fld, values)) { delete values[fld.name]; continue; }
    if (fld.type === "file") {
      const has = f.getAll(fld.name).some((x) => x instanceof File && x.size > 0);
      if (fld.required && !has) missing.push(fld.label);
      continue;
    }
    const v = values[fld.name];
    if (fld.required && (Array.isArray(v) ? !v.length : !v)) missing.push(fld.label || fld.name);
  }
  const email = String(values.email ?? "");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) missing.push("A valid email address");
  if (missing.length) {
    return page("Please complete the form", `<h1>A few things are missing</h1>
      <ul>${missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
      <p><a href="javascript:history.back()">Go back to the form</a> — what you typed should still be there.</p>`, 400);
  }

  const rowId = id("sf");
  const files: { key: string; filename: string; bytes: number; type: string; field: string }[] = [];
  for (const fld of form.fields.filter((x) => x.type === "file" && shown(x, values))) {
    for (const file of f.getAll(fld.name).filter((x): x is File => x instanceof File && x.size > 0)) {
      if (files.length >= MAX_FILES || file.size > MAX_BYTES || !FILE_OK.test(file.name) || !env.DOCS) continue;
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
      const key = `site-forms/${rowId}/${files.length + 1}-${safe}`;
      await env.DOCS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
      files.push({ key, filename: file.name.slice(0, 120), bytes: file.size, type: file.type || "", field: fld.label });
    }
  }

  const name = [values.firstname ?? values.sender_first, values.lastname ?? values.sender_last].filter(Boolean).join(" ")
    || String(values.company_name ?? values.company ?? "") || null;
  const phone = String(values.phone ?? values.mobilephone ?? "") || null;
  const actor: Actor = { kind: "system", id: null, ip: request.headers.get("CF-Connecting-IP") ?? undefined };
  // The same visitor id the site's traffic log uses, so this can be traced to the visit behind it.
  const visitor = await visitorId(env, request);
  const extra = form.agreement ? { agreed_to: form.agreement, agreed_at: stamp() } : {};
  await insert(env.DB, actor, "site_form.received", "site_forms", rowId, {
    form: slug, name, email: email || null, phone,
    fields_json: JSON.stringify({ ...values, ...extra }), files_json: files.length ? JSON.stringify(files) : null,
    ip: actor.ip ?? null, agent: (request.headers.get("User-Agent") ?? "").slice(0, 200) || null,
    referer: (request.headers.get("Referer") ?? "").slice(0, 300) || null,
    visitor,
  }, { note: `${form.title} from ${name ?? email ?? "someone"}` });

  // Every submission is also an enquiry, so everything lands in one queue.
  const enquiryId = id("enq");
  const detail = [`Website form: ${form.title} (${SITE}${form.page})`, "",
    ...form.fields.filter((x) => x.type !== "file" && x.type !== "note" && values[x.name] !== undefined).map((x) => {
      const v = values[x.name]; const text = Array.isArray(v) ? v.join(", ") : v;
      return text ? `${x.label}: ${text}` : null;
    }).filter(Boolean),
    files.length ? `Files: ${files.map((x) => x.filename).join(", ")}` : "",
    `Full record and files: ${ADMIN}/forms/${rowId}`].filter((x) => x !== null).join("\n").slice(0, 8000);
  await insert(env.DB, actor, "enquiry.received", "enquiries", enquiryId, {
    name: (name ?? email ?? "Website visitor").slice(0, 200), email: email || "unknown@website.form", phone,
    whatsapp_ok: 0, detail, source: `Website form: ${form.title}`, status: "new", site_form_id: rowId, visitor,
  }, { note: `from the ${form.title} form` });
  await env.DB.prepare("UPDATE site_forms SET enquiry_id = ? WHERE id = ?").bind(enquiryId, rowId).run();

  later(notify(env, actor, rowId, slug, form, values, files, name, email, phone, extra));
  return Response.redirect(SITE + form.thanks, 303);
}

async function notify(env: Env, actor: Actor, rowId: string, slug: string, form: FormSpec, values: Record<string, string | string[]>,
    files: { filename: string; bytes: number }[], name: string | null, email: string, phone: string | null, extra: Record<string, string>): Promise<void> {
  try {
    const to = await staffEmails(env);
    if (!to.length) return;
    const lines = form.fields.filter((f) => f.type !== "file" && f.type !== "note" && values[f.name] !== undefined).map((f) => {
      const v = values[f.name]; const text = Array.isArray(v) ? v.join(", ") : v;
      return text ? `${f.label}\n  ${String(text).replace(/\n/g, "\n  ")}` : null;
    }).filter(Boolean);
    await send(env, actor, {
      to,
      subject: `Website form — ${form.title} — ${name ?? email}`,
      text: [
        `${form.title} form submitted on thepaymaster.co.uk${form.page}`,
        ``,
        ...lines.flatMap((l) => [l as string, ""]),
        files.length ? `Files: ${files.map((x) => `${x.filename} (${Math.round(x.bytes / 1024)}KB)`).join(", ")}\n` : "",
        `It is also in the enquiry queue: ${ADMIN}/enquiries`,
        extra.agreed_to ? `Agreed to: ${extra.agreed_to}, at ${extra.agreed_at} UTC\n` : "",
        `Reply: ${email}${phone ? ` · ${phone}` : ""}`,
        `Record: ${ADMIN}/forms/${rowId}`,
      ].join("\n"),
      replyTo: email || undefined,
      about: { kind: "site_forms", id: rowId },
    });
  } catch (err) { console.error("site form notify failed", (err as Error).message); }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const STATUS = ["new", "contacted", "closed", "spam"] as const;

export async function formsInbox(env: Env, show: string): Promise<string> {
  const filter = STATUS.includes(show as any) ? show : "open";
  const where = filter === "open" ? "status IN ('new','contacted')" : "status = ?";
  const stmt = env.DB.prepare(`SELECT id, form, name, email, phone, status, created_at FROM site_forms WHERE ${where} ORDER BY created_at DESC LIMIT 200`);
  const { results } = await (filter === "open" ? stmt : stmt.bind(filter)).all<any>();
  const counts = await env.DB.prepare("SELECT status, count(*) AS n FROM site_forms GROUP BY status").all<any>();
  const n = (s: string) => (counts.results ?? []).find((r: any) => r.status === s)?.n ?? 0;
  const tab = (key: string, label: string) => `<a href="/forms?show=${key}" style="margin-right:14px${filter === key ? ";font-weight:700" : ""}">${label}</a>`;
  return `<h1>Website forms</h1>
    <p class="muted">Every submission from the forms on thepaymaster.co.uk. You are emailed each one; this is the record.</p>
    <p>${tab("open", `Open (${n("new") + n("contacted")})`)}${tab("new", `New (${n("new")})`)}${tab("contacted", `Contacted (${n("contacted")})`)}${tab("closed", `Closed (${n("closed")})`)}${tab("spam", `Spam (${n("spam")})`)}</p>
    ${(results ?? []).length ? `<table><tr><th>When</th><th>Form</th><th>Who</th><th>Status</th></tr>
      ${(results ?? []).map((r: any) => `<tr><td class="muted">${esc(String(r.created_at).slice(0, 16))}</td>
        <td>${esc(FORMS[r.form]?.title ?? r.form)}</td>
        <td><a href="/forms/${esc(r.id)}">${esc(r.name ?? r.email ?? "—")}</a><div class="muted log">${esc(r.email ?? "")}${r.phone ? ` · ${esc(r.phone)}` : ""}</div></td>
        <td><span class="tag">${esc(r.status)}</span></td></tr>`).join("")}</table>`
      : `<p class="muted">Nothing here.</p>`}`;
}

export async function formDetail(env: Env, rowId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT * FROM site_forms WHERE id = ?").bind(rowId).first<any>();
  if (!r) return null;
  const form = FORMS[r.form];
  const values = JSON.parse(r.fields_json || "{}");
  const files = r.files_json ? JSON.parse(r.files_json) : [];
  const rows = (form?.fields ?? []).filter((f) => f.type !== "file" && f.type !== "note" && values[f.name] !== undefined).map((f) => {
    const v = values[f.name]; const text = Array.isArray(v) ? v.join(", ") : v;
    return `<tr><th style="width:40%">${esc(f.label)}</th><td style="white-space:pre-wrap">${text ? esc(String(text)) : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
  return `<p><a href="/forms">← Website forms</a></p>
    <h1>${esc(r.name ?? r.email ?? "Submission")}</h1>
    <p class="muted">${esc(form?.title ?? r.form)} form · ${esc(String(r.created_at).slice(0, 16))} UTC · <span class="tag">${esc(r.status)}</span></p>
    <div class="panel"><table>
      <tr><th style="width:40%">Email</th><td>${r.email ? `<a href="mailto:${esc(r.email)}?subject=${encodeURIComponent(`Your enquiry to ThePaymaster`)}">${esc(r.email)}</a>` : "—"}</td></tr>
      <tr><th>Phone / WhatsApp</th><td>${r.phone ? `<a href="tel:${esc(String(r.phone).replace(/\s+/g, ""))}">${esc(r.phone)}</a> · <a href="https://wa.me/${esc(String(r.phone).replace(/[^0-9]/g, ""))}" target="_blank" rel="noopener">WhatsApp</a>` : "—"}</td></tr>
      ${rows}
      ${values.agreed_to ? `<tr><th>Agreed to</th><td>${esc(values.agreed_to)} — ${esc(values.agreed_at)} UTC, from ${esc(r.ip ?? "unknown")}</td></tr>` : ""}
      ${files.length ? `<tr><th>Files</th><td>${files.map((x: any, i: number) => `<a href="/forms/${esc(r.id)}/file/${i}">${esc(x.filename)}</a> <span class="muted">(${Math.round(x.bytes / 1024)}KB${x.field ? ` — ${esc(x.field)}` : ""})</span>`).join("<br>")}</td></tr>` : ""}
      ${r.enquiry_id ? `<tr><th>Enquiry</th><td><a href="/e/${esc(r.enquiry_id)}">Open it in the enquiry queue</a> — convert it to a transaction from there</td></tr>` : ""}
    </table></div>
    <form method="post" action="/forms/${esc(r.id)}/status" class="row" style="gap:8px">
      ${STATUS.filter((s) => s !== r.status).map((s) => `<button class="${s === "contacted" ? "go" : "plain"}" name="to" value="${s}">Mark ${s}</button>`).join("")}
    </form>
    <p class="muted" style="font-size:13px">From ${esc(r.ip ?? "—")} · ${esc(r.agent ?? "")}${r.referer ? ` · ${esc(r.referer)}` : ""}</p>`;
}

export async function setFormStatus(env: Env, actor: Actor, rowId: string, to: string): Promise<void> {
  if (!STATUS.includes(to as any)) return;
  const r = await env.DB.prepare("SELECT status FROM site_forms WHERE id = ?").bind(rowId).first<any>();
  if (!r || r.status === to) return;
  await update(env.DB, actor, "site_form.status", "site_forms", rowId, { status: to, status_at: stamp(), status_by: actor.id }, { status: r.status });
}

export async function formFile(env: Env, actor: Actor, rowId: string, n: number): Promise<Response> {
  const r = await env.DB.prepare("SELECT files_json FROM site_forms WHERE id = ?").bind(rowId).first<any>();
  const files = r?.files_json ? JSON.parse(r.files_json) : [];
  const x = files[n];
  if (!x || !env.DOCS) return new Response("Not found", { status: 404 });
  const obj = await env.DOCS.get(x.key);
  if (!obj) return new Response("Not found", { status: 404 });
  await log(env.DB, actor, "site_form.file_downloaded", "site_forms", rowId, { note: x.filename });
  return new Response(obj.body, { headers: { "content-type": x.type || "application/octet-stream",
    "content-disposition": `attachment; filename="${String(x.filename).replace(/"/g, "")}"`, "cache-control": "no-store" } });
}
