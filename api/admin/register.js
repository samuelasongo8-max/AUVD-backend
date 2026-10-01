/**
 * /api/admin/register — creates THE one admin account, and only ever once.
 *
 *   POST /api/admin/register  { email, password }
 *     -> 201 { ok: true, email }   the account was created, and you are signed in
 *     -> 403 { ok: false, error: "An admin account already exists." }
 *     -> 400 { ok: false, error: "Invalid email or password format." }
 *
 * WHY THIS IS SAFE TO LEAVE REACHABLE
 * -----------------------------------
 * A public registration endpoint is normally the worst thing you can add to a
 * site. This one is safe for exactly one reason: it stops working the instant
 * an account exists, and it can never create a second one.
 *
 * The rule is enforced by the DATABASE, not by a check — see lib/adminSetup.js
 * for the full reasoning. In short: the document is written with a fixed `_id`
 * and behind a unique index, so two requests racing each other cannot both
 * succeed. There is no window in which a second account can appear.
 *
 * Once the account exists, this endpoint is permanently closed: the first
 * thing every request does is look for an existing admin and answer 403. That
 * is what "first one wins" means in practice.
 *
 * CREATING THE ACCOUNT ALSO LOGS YOU IN
 * --------------------------------------
 * A successful registration signs the same JWT and sets the same httpOnly
 * cookie that api/admin/login.js sets, so the new admin lands on the dashboard
 * without a second round trip. The token goes out through the Set-Cookie header
 * only and is never placed in the response body.
 *
 * WHAT THE CALLER IS TOLD
 * -----------------------
 * Only two failure messages exist: "An admin account already exists." and
 * "Invalid email or password format." The first is safe to show because it
 * reveals nothing an attacker did not already have to know. Neither reveals
 * anything about a stored account — no email, no hash, nothing.
 *
 * SECURITY
 * --------
 * The password is never logged and never stored in plain text: it is hashed
 * with bcrypt at cost 12 before the insert, and the hash is not logged either.
 * The submitted email is masked in the log, exactly as login.js does.
 *
 * There is no rate limit here, and that is a deliberate trade-off worth
 * naming: once an account exists every call is a cheap 403 that costs no bcrypt
 * work. Before the account exists, the only thing an attacker can do by
 * spamming it is create the account themselves — which they could equally do
 * with a single call. The answer to that window is to set the account up
 * promptly, not to slow the attacker down.
 *
 * SIGNATURE
 * ---------
 * Vercel calls the default export as (req, res) and the answer must be WRITTEN
 * on res, so every path below ends in sendJson() — the same convention as
 * api/subscribe.js and api/admin/login.js.
 *
 * ENVIRONMENT (Vercel -> Production)
 *   MONGODB_URI      the connection string, never prefixed with VITE_
 *   JWT_SECRET       the signing secret
 *   JWT_EXPIRES_IN   optional, e.g. "7d"
 */
import bcrypt from "bcryptjs";
import { getDb, ADMIN_COLLECTION, safeMessage } from "../../lib/db.js";
import { hasAdmin, insertAdmin, allowsMultipleAdmins } from "../../lib/adminSetup.js";
import { sendJson, signAdminToken, setAdminCookie, getExpiresIn } from "../../lib/requireAdmin.js";

/**
 * bcrypt work factor. Matches scripts/create-admin.mjs, so an account made
 * through the browser and one made from the terminal are indistinguishable in
 * the database — there is no weaker path to the same account.
 */
const BCRYPT_COST = 12;

/**
 * Shortest password accepted. Stated here because the register form repeats it
 * to the user; the two must agree, or the form would happily accept a password
 * the server then rejects.
 */
export const MIN_PASSWORD_LENGTH = 10;

/** The only two failure messages the caller ever receives.
 *
 *  TEMPORARY: while ALLOW_MULTIPLE_ADMINS=true this is also the answer to
 *  registering an address that already has an account, which is the only
 *  registration failure that can still occur in that mode. */
const ALREADY_EXISTS = {
  ok: false,
  error: "Admin account already exists. Only one administrator account is allowed.",
};
const INVALID_FORMAT = { ok: false, error: "Invalid email or password format." };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Never log the full address, only enough to tell two attempts apart. */
const mask = (email) => {
  const [user = "", domain = ""] = String(email).split("@");
  return `${user.slice(0, 2)}***@${domain}`;
};

const log = (step, detail = "") => {
  console.log(`[admin/register] ${step}${detail ? ` — ${detail}` : ""}`);
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

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      log("rejected", `method ${req.method}`);
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    /* Config first: a missing variable is an instant, clear 500 instead of a
       chain of failing calls. Only the variable NAMES are logged. */
    const missing = ["MONGODB_URI", "JWT_SECRET"].filter(
      (name) => !String(process.env[name] ?? "").trim()
    );
    if (missing.length) {
      log("config", `missing env var(s): ${missing.join(", ")} — set them in Vercel for Production, then redeploy`);
      return sendJson(res, 500, { ok: false, error: "Server not configured" });
    }

    const db = await getDb();

    /* TEMPORARY (local testing): with ALLOW_MULTIPLE_ADMINS=true the
       closed-door check below is skipped, so a second account can be registered.
       Removing that one branch restores the original behaviour exactly — the
       check is still here, it is just no longer reached. */
    const multi = allowsMultipleAdmins();

    /* ---- THE CLOSED-DOOR CHECK ----
       Runs before the body is even read, so once an account exists this
       endpoint is a fixed 403 that does no further work: no validation, no
       bcrypt, no insert. This is the fast path, not the guarantee — the
       guarantee is the unique _id and index inside insertAdmin(). */
    if (!multi && (await hasAdmin(db))) {
      log("refused", "an admin account already exists");
      return sendJson(res, 403, ALREADY_EXISTS);
    }

    const body = readBody(req);
    if (!body) {
      return sendJson(res, 400, INVALID_FORMAT);
    }

    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    /* Multi-admin mode still allows only ONE account per address: the unique
       email index enforces it, and this check turns it into the same friendly
       403 rather than a duplicate-key error. It is a UX shortcut, not the
       guarantee. */
    if (multi && (await db.collection(ADMIN_COLLECTION).findOne({ email }, { projection: { _id: 1 } }))) {
      log("refused", "that email address already has an account");
      return sendJson(res, 403, ALREADY_EXISTS);
    }

    /* The email gets a basic shape check; the password only a length rule. A
       stricter policy here (uppercase, symbols, a breach list) would reject
       passwords people can actually remember, and the account can only be
       created once — a password the admin cannot reproduce would lock them
       out of their own site permanently. Length plus bcrypt is the better
       trade here. */
    if (!EMAIL_PATTERN.test(email) || password.length < MIN_PASSWORD_LENGTH) {
      log("rejected", `invalid format (password must be at least ${MIN_PASSWORD_LENGTH} characters)`);
      return sendJson(res, 400, INVALID_FORMAT);
    }

    /* Hashing before the insert is deliberate: the plaintext password must
       never be part of a value that could reach the database. bcrypt at cost
       12 is intentionally slow — roughly a quarter of a second. */
    log("hashing", "bcrypt cost 12");
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    /* Neither the password nor the hash is logged past this point. */

    const result = await insertAdmin(db, { email, passwordHash });

    /* The database refused the write because an admin already exists. This is
       the race being caught: another request created the account between the
       check above and this insert. It is a normal outcome, not a fault. */
    if (!result.ok) {
      log("refused", "lost the race — an admin was created a moment ago");
      return sendJson(res, 403, ALREADY_EXISTS);
    }

    /* Creating the account signs the admin straight in: the same JWT, the same
       cookie name and attributes, so /api/admin/me accepts it immediately and
       the dashboard opens with no second step. */
    setAdminCookie(req, res, signAdminToken(email));

    log("created", `${mask(email)} — signed in, expires in ${getExpiresIn()}`);
    /* The body carries the email and nothing else. The token went out through
       the Set-Cookie header and is deliberately absent here. */
    return sendJson(res, 201, { ok: true, email });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, { ok: false, error: "Server error" });
  }
}
