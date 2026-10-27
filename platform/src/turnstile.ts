/**
 * Cloudflare Turnstile: is the person submitting this form a person?
 *
 * Every public form carries the widget; its token is checked here, against
 * Cloudflare, before anything is saved or anyone is emailed. The check fails
 * closed: no secret configured, no token, Cloudflare unreachable, the wrong
 * form, or the wrong website — all refused.
 *
 * Locally, .dev.vars holds Cloudflare's published test keys, which always pass
 * and report the hostname example.com with no action; the rehearsal scripts
 * submit the dummy token those keys accept. The production secret never
 * returns a testing-key result, so the relaxed action check below cannot
 * apply there.
 */

import { type Env } from "./db.ts";

/** The production widget, "ThePaymaster forms". Public by design: it is in every page. */
export const SITEKEY = "0x4AAAAAAFn2yf5ILAKBjqKm";
export const SCRIPT = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;

export function sitekey(env: Env): string {
  return env.TURNSTILE_SITEKEY || SITEKEY;
}

/** The widget, for a form whose submission is checked with this action. */
export function widget(env: Env, action: string): string {
  return `<div class="cf-turnstile" data-sitekey="${sitekey(env)}" data-action="${action}" style="margin:18px 0 4px"></div>`;
}

export const HUMAN_CHECK_FAILED =
  "We could not confirm this came from a person. Please tick the check above the button and send it again.";

export async function human(env: Env, request: Request, form: FormData, action: string): Promise<boolean> {
  const token = form.get("cf-turnstile-response");
  const secret = env.TURNSTILE_SECRET;
  const hostnames = new Set(String(env.TURNSTILE_HOSTNAMES ?? "").split(",").map((h) => h.trim()).filter(Boolean));
  if (!secret || hostnames.size === 0) return false;
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;

  let result: any;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret, response: token,
        remoteip: request.headers.get("CF-Connecting-IP") ?? "",
      }),
    });
    if (!r.ok) return false;
    result = await r.json();
  } catch {
    return false;
  }
  if (result?.success !== true) return false;
  if (!hostnames.has(String(result.hostname ?? ""))) return false;
  const testing = result.metadata?.result_with_testing_key === true;
  if (result.action !== action && !(testing && !result.action)) return false;
  return true;
}
