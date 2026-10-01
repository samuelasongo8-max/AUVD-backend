/**
 * /api/admin/setup-status — has the one admin account been created yet?
 *
 *   GET /api/admin/setup-status  ->  200 { ok: true, hasAdmin: true | false }
 *
 * WHY THIS IS PUBLIC
 * ------------------
 * The login form has to know which of the two forms to show — "create your
 * account" or "log in" — and the footer link is on every page, so the answer
 * is needed before anything is signed in.
 *
 * It is public because what it returns is not sensitive. It is a single
 * boolean saying whether setup has happened, which the person asking can
 * already establish for themselves: they either know they created the account,
 * or they can try to log in and see. Nothing about the account itself — no
 * email, no hash, no created date — is ever returned.
 *
 * The one thing worth being honest about: while `hasAdmin: false`, this
 * endpoint is an open door. The correct response is not to hide the boolean,
 * it is to create the account promptly. The register endpoint is designed so
 * that even if someone walks through that door first, the damage is bounded —
 * they get one admin account, and no second one is ever possible.
 *
 * NO CACHING
 * ----------
 * The answer is explicitly not cached. A cached `hasAdmin: false` would show
 * the register form to someone whose account already exists, and a cached
 * `true` would hide the setup form from the person who still needs it. It has
 * to be read live every time, which sendJson() already arranges.
 *
 * SIGNATURE
 * ---------
 * Vercel calls the default export as (req, res); the answer is written on res,
 * matching api/subscribe.js.
 *
 * ENVIRONMENT (Vercel -> Production)
 *   MONGODB_URI   the connection string, never prefixed with VITE_
 */
import { getDb, safeMessage } from "../../lib/db.js";
import { hasAdmin, allowsMultipleAdmins } from "../../lib/adminSetup.js";
import { sendJson } from "../../lib/requireAdmin.js";

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    if (!String(process.env.MONGODB_URI ?? "").trim()) {
      /* Reported plainly (the variable NAME only) so a misconfigured deploy is
         obvious, while the caller just gets a 500. */
      console.error("[admin/setup-status] MONGODB_URI is not set — set it in Vercel for Production, then redeploy");
      return sendJson(res, 500, { ok: false, error: "Server not configured" });
    }

    const db = await getDb();
    const adminExists = await hasAdmin(db);

    /* TEMPORARY (local testing): whether the registration form should be
       reachable. In the normal one-admin design this is simply `!adminExists`.
       With ALLOW_MULTIPLE_ADMINS=true it stays true even when an account already
       exists, because more accounts are allowed in that mode.

       This is CONVENIENCE ONLY, and the backend is still the authority: register
       itself re-checks the flag and refuses what this says it would refuse. The
       frontend must never be the thing enforcing the rule. */
    const allowRegistration = !adminExists || allowsMultipleAdmins();

    return sendJson(res, 200, { ok: true, hasAdmin: adminExists, allowRegistration });
  } catch (error) {
    console.error(`[admin/setup-status] failed: ${safeMessage(error)}`);
    return sendJson(res, 500, { ok: false, error: "Server error" });
  }
}