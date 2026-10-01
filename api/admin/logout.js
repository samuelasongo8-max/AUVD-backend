/**
 * /api/admin/logout — ends the admin session.
 *
 * The session is a stateless JWT in an httpOnly cookie, so "logging out" cannot
 * mean revoking a token server-side: there is no session store to delete from.
 * Instead the cookie is expired in the browser (Max-Age=0), which is the only
 * thing that actually ends it — the browser stops sending it, so the admin is
 * instantly unauthenticated.
 *
 * The route is deliberately forgiving. It does NOT require a valid session,
 * because "log me out" must always succeed: an expired or already-missing
 * cookie is exactly the state a user might be trying to escape, and replying
 * 401 there would leave the button looking broken. There is also nothing
 * sensitive to protect — the endpoint only ever deletes a cookie.
 *
 * It reads no database and needs no environment variables, so it keeps working
 * even if the database is briefly unreachable.
 *
 * SIGNATURE
 * ---------
 * Vercel calls the default export as (req, res); the answer is written on res,
 * matching api/subscribe.js.
 */
import { sendJson, clearAdminCookie } from "../../lib/requireAdmin.js";

const log = (step) => {
  console.log(`[admin/logout] ${step}`);
};

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      log(`rejected — method ${req.method}`);
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    clearAdminCookie(req, res);
    log("session cookie cleared");
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    /* The cookie is already cleared by this point in every realistic failure,
       so the browser is logged out even if the response is not delivered. */
    console.error(`[admin/logout] failed after clearing the cookie: ${error?.message ?? error}`);
    return sendJson(res, 500, { ok: false, error: "Server error" });
  }
}