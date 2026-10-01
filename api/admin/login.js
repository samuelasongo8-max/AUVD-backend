/**
 * /api/admin/login — the only way to obtain an admin session.
 *
 * There is no registration endpoint and there never will be: the single admin
 * account is created once, locally, by scripts/create-admin.mjs. This file is
 * therefore the entire authentication surface of the site.
 *
 * WHAT IT DOES
 * ------------
 *   1. Refuses the request outright if that email is inside its lockout window.
 *   2. Looks up THE one admin document.
 *   3. Compares the submitted password against the stored bcrypt hash.
 *   4. On success, signs a JWT and sets it as an httpOnly cookie.
 *
 * THE ONE ERROR THE CALLER EVER SEES
 * ----------------------------------
 * Every failure — unknown email, wrong password, or a lockout — returns the
 * same 401 `{ ok: false, error: "Invalid email or password" }`. A distinct
 * message per case would let anyone use this form to discover which email
 * addresses have an account, so the reason is kept server-side in the log
 * while the response stays uniform. The log records the CASE, never the
 * submitted password and never the stored hash.
 *
 * RATE LIMITING
 * -------------
 * Failed attempts are counted per email in the "login_attempts" collection.
 * After 5 failures that email is locked out for 15 minutes. A successful login
 * clears the counter, so a real admin who fumbles their password a couple of
 * times is not punished for long.
 *
 * Note this is per-EMAIL, not per-IP: it is aimed at stopping password guessing
 * against the one account that exists, which is what a lockout is for.
 *
 * SIGNATURE
 * ---------
 * Vercel calls the default export as (req, res) and the answer must be WRITTEN
 * on res, so every path below ends in sendJson() — the same convention as
 * api/subscribe.js.
 *
 * ENVIRONMENT (Vercel -> Production)
 *   MONGODB_URI      the connection string, never prefixed with VITE_
 *   JWT_SECRET       the signing secret
 *   JWT_EXPIRES_IN   optional, e.g. "7d"
 *
 * ADMIN_EMAIL / ADMIN_PASSWORD are deliberately NOT read here. They belong to
 * the local seed script only and must never exist in a deployed environment.
 */
import bcrypt from "bcryptjs";
import { getDb, ADMIN_COLLECTION, LOGIN_ATTEMPTS_COLLECTION, safeMessage } from "../../lib/db.js";
import { sendJson, signAdminToken, setAdminCookie, getExpiresIn } from "../../lib/requireAdmin.js";

/** Wrong attempts tolerated per email before the lockout starts. */
const MAX_FAILED_ATTEMPTS = 5;

/** How long an email stays locked out once the limit is reached. */
const LOCKOUT_MS = 15 * 60 * 1000;

/** The one and only message the caller ever receives. */
const INVALID = { ok: false, error: "Invalid email or password" };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * A real bcrypt hash (cost 12) of a random string nobody knows. It is compared
 * against when no admin document exists, purely to burn the same amount of CPU
 * a real comparison would, so response timing cannot be used to discover whether
 * an account exists. Nothing is ever signed in with it.
 */
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.4YhUXlqPu0mQpCw1bnPzKZBVh3F6EFaO";

const log = (step, detail = "") => {
  console.log(`[admin/login] ${step}${detail ? ` — ${detail}` : ""}`);
};

/** Never log the full address, only enough to tell two attempts apart. */
const mask = (email) => {
  const [user = "", domain = ""] = String(email).split("@");
  return `${user.slice(0, 2)}***@${domain}`;
};

function readBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === "object" ? body : null;
}

/** The attempt record's key is the email; nothing else about it is stored. */
const attemptKey = (email) => `login:${email}`;

/**
 * Reads the current lock state for an email.
 * @returns {Promise<{ count: number, lockedUntil: number }>}
 */
async function readAttempts(collection, email) {
  const record = await collection.findOne({ _id: attemptKey(email) });
  return {
    count: Number(record?.count) || 0,
    lockedUntil: Number(record?.lockedUntil) || 0,
  };
}

/** Records one failure and returns the new state. */
async function recordFailure(collection, email, previousCount) {
  const count = previousCount + 1;
  const lockedUntil = count >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0;

  await collection.updateOne(
    { _id: attemptKey(email) },
    { $set: { count, lockedUntil, updatedAt: new Date() } },
    { upsert: true }
  );

  return { count, lockedUntil };
}

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      log("rejected", `method ${req.method}`);
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    /* Config first: a missing variable is an instant, clear 500 instead of a
       chain of failing database calls. Only the variable NAMES are logged. */
    const missing = ["MONGODB_URI", "JWT_SECRET"].filter(
      (name) => !String(process.env[name] ?? "").trim()
    );
    if (missing.length) {
      log("config", `missing env var(s): ${missing.join(", ")} — set them in Vercel for Production, then redeploy`);
      return sendJson(res, 500, { ok: false, error: "Server not configured" });
    }

    const body = readBody(req);
    if (!body) {
      return sendJson(res, 400, { ok: false, error: "Invalid request body" });
    }

    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!email || !password || !EMAIL_PATTERN.test(email)) {
      log("rejected", "malformed email or password");
      return sendJson(res, 401, INVALID);
    }

    const db = await getDb();
    const attempts = db.collection(LOGIN_ATTEMPTS_COLLECTION);

    /* The lockout is checked before any credential work, so a locked email
       costs no bcrypt time and cannot be used to confirm the account exists.
       The response is the same generic 401. */
    const before = await readAttempts(attempts, email);
    if (before.lockedUntil > Date.now()) {
      log("locked", mask(email));
      return sendJson(res, 401, INVALID);
    }

    const admin = await db.collection(ADMIN_COLLECTION).findOne({ email });

    /* Compared against the stored hash — or against a dummy hash when there is
       no admin document at all, so both cases take the same time. */
    const matches = await bcrypt.compare(password, admin?.passwordHash ?? DUMMY_HASH);

    if (!admin || !matches) {
      const after = await recordFailure(attempts, email, before.count);
      log(
        after.lockedUntil ? "locked out" : "failed",
        `${mask(email)} (${after.count}/${MAX_FAILED_ATTEMPTS})`
      );
      return sendJson(res, 401, INVALID);
    }

    /* Success clears the counter, so a real admin who mistyped twice is not
       one slip away from a lockout. */
    await attempts.deleteOne({ _id: attemptKey(email) });

    const token = signAdminToken(admin.email);
    setAdminCookie(req, res, token);

    log("signed in", `${mask(admin.email)} expires in ${getExpiresIn()}`);
    /* The response carries the email and nothing else. The token went out
       through the Set-Cookie header and is deliberately absent here. */
    return sendJson(res, 200, { ok: true, email: admin.email });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, { ok: false, error: "Server error" });
  }
}
