/**
 * /api/admin/me — "am I logged in?", asked by the dashboard on page load.
 *
 * GET /api/admin/me  ->  200 { ok: true, email }   session is valid
 *                    ->  401 { ok: false }          no, expired or tampered cookie
 *
 * The dashboard calls this on mount and renders NOTHING until it answers, so
 * there is no window in which admin-only content is briefly visible to someone
 * who is not logged in. A 401 is the normal answer for every visitor who has
 * simply never used the login form, so it is not treated as an error — it is
 * simply "not logged in", and the frontend redirects to the login form.
 *
 * Only the email is returned. The token itself is never echoed back, because
 * an endpoint that hands out its own token is one more place for it to leak.
 *
 * It touches no database: the JWT's signature and expiry are checked against
 * the secret, which is exactly what every protected write does in
 * lib/requireAdmin.js. So this is a cheap, self-contained check.
 *
 * SIGNATURE
 * ---------
 * Vercel calls the default export as (req, res); the answer is written on res,
 * matching api/subscribe.js.
 *
 * ENVIRONMENT (Vercel -> Production)
 *   JWT_SECRET   the same secret login.js signed with
 */
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    /* requireAdmin answers 401 itself when the cookie is missing, expired or
       invalid, and returns the email only when the session is genuinely good.
       Reusing it here means the dashboard and the write endpoints can never
       disagree about who is logged in. */
    const email = requireAdmin(req, res);
    if (!email) return;

    return sendJson(res, 200, { ok: true, email });
  } catch (error) {
    /* Nothing here is user-specific, so the message is generic. The detail
       goes to the log only. */
    console.error(`[admin/me] failed: ${error?.message ?? error}`);
    return sendJson(res, 500, { ok: false, error: "Server error" });
  }
}