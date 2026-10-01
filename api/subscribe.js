/**
 * /api/subscribe — AUVD newsletter signups.
 *
 * WHAT THIS DOES, IN THE NORMAL CASE
 * ---------------------------------
 * There is NO confirmation email and NO double opt-in. A visitor who submits
 * the footer form is subscribed immediately, which is what they were asked
 * for when they pressed the button.
 *
 * Resend records "which topics did this person choose" with its native Topics
 * model, so there is nothing to invent here: a contact is opted IN to the
 * topics they ticked. Opting in is additive, so submitting the form a second
 * time with a different topic ADDS a subscription rather than replacing the
 * old one — that comes from Resend, not from a get-then-merge dance.
 *
 * AT MOST TWO RESEND CALLS
 * ------------------------
 *   1. GET  /contacts/{email}          — does this address exist, and have
 *                                         they unsubscribed?
 *   2. either
 *        POST  /contacts                — new: creates them already opted in
 *                                          to every chosen topic, in one go
 *        PATCH /contacts/{email}/topics — known: adds the chosen topics
 *
 * The topic ids are read from src/data/resend-config.json, which
 * scripts/setup-resend.mjs writes once, so nothing is ever looked up or
 * created inside a request.
 *
 * RESPECTING AN UNSUBSCRIBE
 * ------------------------
 * Resend sets `unsubscribed: true` on a contact when they click the
 * unsubscribe link in a broadcast. Step 1 reads that flag, and if it is set
 * we return the normal success answer and change NOTHING. Opting a person
 * back in without them asking would undo the one thing they explicitly asked
 * for, so it must not happen automatically.
 *
 * The visitor is told "{ ok: true }" either way, so the endpoint can never be
 * used to find out whether an address is on the list.
 *
 * SIGNATURE
 * ---------
 * Vercel calls the default export as (req, res) and the answer must be
 * WRITTEN on res. Returning an object instead sends nothing at all and leaves
 * the browser waiting forever, which is the "Sending..." that never finishes.
 * Every path below ends in sendJson().
 *
 * ENVIRONMENT (Vercel -> Production)
 *   RESEND_API_KEY  never prefixed with VITE_
 *   RESEND_FROM     verified sender, e.g. "AUVD News <news@yourdomain.org>"
 *   SITE_URL        public https URL, no trailing slash
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESEND_BASE = "https://api.resend.com";

const TOPICS = ["education", "music", "dance", "vocational"];

/* 6s per Resend call, and the whole request is held under 8s so the function
   always answers well inside Vercel's limit instead of being cut off with the
   connection still open. */
const CALL_TIMEOUT_MS = 6000;
const TOTAL_BUDGET_MS = 8000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const here = path.dirname(fileURLToPath(import.meta.url));
/* Two levels up: this file is now backends/api/, and src/data/ lives at the
   PROJECT root. A single ".." would resolve to backends/src/data/, which does not
   exist, and the newsletter topics would silently fail to load. */
const CONFIG_FILE = path.join(here, "..", "..", "src", "data", "resend-config.json");

let deadlineAt = 0;
const remainingMs = () => Math.max(0, deadlineAt - Date.now());

/* Never log the full address, only enough to tell two requests apart. */
const mask = (email) => {
  const [user = "", domain = ""] = String(email).split("@");
  return `${user.slice(0, 2)}***@${domain}`;
};

const log = (step, detail = "") => {
  console.log(`[subscribe] ${step}${detail ? ` — ${detail}` : ""}`);
};

class ResendError extends Error {
  constructor(message, { status = 0, code = "", timedOut = false } = {}) {
    super(message);
    this.name = "ResendError";
    this.status = status;
    this.code = code;
    this.timedOut = timedOut;
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
  } catch {
    /* A stubbed res in tests may not implement setHeader. */
  }
  res.status(status).json(body);
}

/** The one message the visitor ever sees for a failure. */
const SERVER_ERROR = { ok: false, code: "server" };

/**
 * One Resend call, bounded in time.
 *
 * An AbortController plus a normal setTimeout is used rather than
 * AbortSignal.timeout(): that helper's internal timer is NOT referenced, so on
 * Node it does not keep the event loop alive, and a request in flight can be
 * suspended or torn down with nothing sent. A normal setTimeout is referenced,
 * and clearTimeout in `finally` keeps it from holding the loop open later.
 */
async function resend(pathname, { method = "GET", body } = {}) {
  const budget = Math.min(CALL_TIMEOUT_MS, remainingMs());
  if (budget <= 0) {
    throw new ResendError(`out of time budget for ${method} ${pathname}`, { timedOut: true });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);

  let response;
  try {
    response = await fetch(`${RESEND_BASE}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new ResendError(`${method} ${pathname} ${timedOut ? "timed out" : "network error"}: ${error?.message ?? error}`, { timedOut });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    /* Resend's HTTP status and its own message, never the API key. */
    throw new ResendError(
      `${method} ${pathname} -> HTTP ${response.status}${payload?.message ? ` ${payload.message}` : ""}`,
      { status: response.status, code: payload?.name ?? "" }
    );
  }

  return payload;
}

/** Topic ids from the committed JSON file. Never calls Resend. */
function readTopicIds() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const topics = raw?.topics ?? {};
  return new Map(TOPICS.map((topic) => [topic, String(topics[topic] ?? "").trim()]));
}

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  deadlineAt = Date.now() + TOTAL_BUDGET_MS;

  try {
    if (req.method !== "POST") {
      log("rejected", `method ${req.method}`);
      return sendJson(res, 405, { ok: false, code: "method" });
    }

    /* Config first: a missing variable is an instant, clear 500 instead of a
       chain of failing Resend calls. Only the NAMES are logged. */
    const missing = ["RESEND_API_KEY", "RESEND_FROM", "SITE_URL"].filter(
      (name) => !String(process.env[name] ?? "").trim()
    );
    if (missing.length) {
      log("config", `missing env var(s): ${missing.join(", ")} — set them in Vercel for Production, then redeploy`);
      return sendJson(res, 500, { ok: false, code: "config" });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { ok: false, code: "body" });
      }
    }
    if (!body || typeof body !== "object") {
      return sendJson(res, 400, { ok: false, code: "body" });
    }

    /* Honeypot. The form sends the neutral "hp_field"; the old "website" key
       is still honoured so a cached page cannot make a visitor look like a bot. */
    const honeypot = String(body.hp_field ?? "").trim() || String(body.website ?? "").trim();
    if (honeypot) {
      log("honeypot", "ignored");
      return sendJson(res, 200, { ok: true });
    }

    /* Filled in faster than a person could read it: a bot. */
    const elapsed = Number(body.t);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 3000) {
      log("too fast", `${elapsed}ms`);
      return sendJson(res, 200, { ok: true });
    }

    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
      log("rejected", "invalid email");
      return sendJson(res, 400, { ok: false, code: "email" });
    }

    const topics = Array.isArray(body.topics) ? body.topics : [];
    const chosen = [...new Set(topics.filter((topic) => TOPICS.includes(topic)))];
    if (chosen.length === 0) {
      log("rejected", "no topics");
      return sendJson(res, 400, { ok: false, code: "topics" });
    }

    const lang = body.lang === "fr" ? "fr" : "en";

    /* Ids come from the file, never from an API call. */
    let topicIds;
    try {
      topicIds = readTopicIds();
    } catch (error) {
      log("config", `cannot read src/data/resend-config.json: ${error?.message ?? error}`);
      return sendJson(res, 500, { ok: false, code: "config" });
    }

    const chosenIds = chosen.map((topic) => topicIds.get(topic));
    if (chosenIds.some((id) => !id)) {
      log("config", "a topic id is missing from src/data/resend-config.json — run: node --env-file=.env.local scripts/setup-resend.mjs");
      return sendJson(res, 500, { ok: false, code: "config" });
    }

    const siteUrl = String(process.env.SITE_URL).replace(/\/+$/, "");
    log("start", `${mask(email)} ${chosen.join("+")}/${lang} site=${siteUrl}`);

    /* Resend's shape for a topic subscription. "opt_in" ADDS the topic and
       leaves every other topic exactly as it was, which is what makes a second
       submission with a different topic add to the first one. */
    const optIns = chosenIds.map((id) => ({ id, subscription: "opt_in" }));

    /* CALL 1 of at most 2 — does this address already exist? */
    let existing = null;
    try {
      existing = await resend(`/contacts/${encodeURIComponent(email)}`);
    } catch (error) {
      /* 404 is the normal answer for somebody who has never signed up. */
      if (error.status !== 404) throw error;
      log("lookup", "new address");
    }

    if (existing) {
      /* Previously unsubscribed. Honoured by doing nothing: a PATCH here would
         opt them straight back in and undo the one thing they asked for. */
      if (existing.unsubscribed === true) {
        log("unsubscribed", "left unsubscribed");
        return sendJson(res, 200, { ok: true });
      }
      log("lookup", "known contact");

      /* CALL 2 — add the newly chosen topics, keeping the old ones. */
      await resend(`/contacts/${encodeURIComponent(email)}/topics`, {
        method: "PATCH",
        body: optIns,
      });
      log("added topics", chosen.join("+"));
      return sendJson(res, 200, { ok: true });
    }

    /* CALL 2 — brand new contact, created already opted in. */
    await resend("/contacts", {
      method: "POST",
      body: { email, topics: optIns },
    });
    log("subscribed", `${chosen.length} topic(s), no confirmation email`);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError" || error?.timedOut;
    log("failed", `${error?.message ?? error}`);
    return sendJson(res, timedOut ? 504 : 500, SERVER_ERROR);
  }
}

