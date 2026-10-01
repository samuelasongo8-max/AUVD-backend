/**
 * /api/posts/featured — the newest posts that are at least two weeks old.
 *
 *   GET /api/posts/featured  ->  200 { ok: true, posts: [...] }   at most 4
 *
 * WHAT THIS IS FOR
 * ----------------
 * The "Latest Updates" strip under the Community Music Grant section on the home
 * page. It shows the four most recent posts that have reached the two-week mark,
 * choosing them entirely on its own: the admin publishes a post and does nothing
 * else. Two weeks after a post's own date it becomes eligible, and from then on
 * it competes for one of the four slots. Older eligible posts drop off the bottom
 * as newer ones become eligible.
 *
 * WHY TWO WEEKS
 * -------------
 * The point of the strip is settled, older work rather than whatever was typed an
 * hour ago, so a post is left alone for a fortnight before it is considered. The
 * same window means the four cards do not reshuffle every time something is
 * published.
 *
 * WHY THE FILTERING HAPPENS HERE AND NOT IN THE BROWSER
 * -----------------------------------------------------
 * The feed at /api/posts is public and unbounded, and the home page has no
 * business downloading every post on the site to show four cards. The date
 * arithmetic, the eligibility cut-off and the limit all happen here, against the
 * index, so the response is at most four documents.
 *
 * THE DATE FIELD
 * --------------
 * `date` — the post's own publication date, stored as "YYYY-MM-DD" by the admin
 * in the dashboard. That is deliberately NOT `createdAt`: a post about something
 * that happened in June is usually typed up weeks later, and eligibility is meant
 * to follow when the post is about, not when it was typed. `createdAt` only breaks
 * ties between posts sharing a date, so the order is stable rather than arbitrary.
 *
 * Because `date` is a fixed-width "YYYY-MM-DD" string, comparing it as a string is
 * the same as comparing it as a date, and MongoDB can use an index for it. A
 * malformed date simply fails to match the cut-off and is skipped, exactly as an
 * incomplete document is.
 *
 * CACHING
 * -------
 * `no-store`, because eligibility is decided by TODAY. A cached response would
 * keep showing yesterday's four posts after midnight, and would hold a newly
 * eligible post back for as long as the cache lived.
 */
import { getDb, POSTS_COLLECTION, safeMessage } from "../../lib/db.js";
import { sendJson } from "../../lib/requireAdmin.js";
import { toPublicPost } from "../../lib/postValidation.js";

/** How many posts the strip ever shows. */
const LIMIT = 4;

/** How old a post must be, in days, before it can be featured. */
const MIN_AGE_DAYS = 14;

/**
 * The most recent date a post may carry and still be eligible: two weeks ago.
 *
 * Computed from the current date on every request, which is what makes the
 * selection automatic. No date is stored, no post id is stored, and nothing has to
 * be redeployed when the answer changes — the next request simply computes a later
 * cut-off.
 *
 * UTC on purpose, and the same zone the comparison happens in, so a reader in
 * Nairobi and the server never disagree about whether a post has aged past the
 * mark. The boundary is midnight, which is the only sensible reading of "two weeks
 * old" anyway.
 *
 * @returns {string} "YYYY-MM-DD"
 */
function eligibilityCutoff() {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - MIN_AGE_DAYS);
  return cutoff.toISOString().slice(0, 10);
}

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    if (!String(process.env.MONGODB_URI ?? "").trim()) {
      console.error("[posts/featured] MONGODB_URI is not set — set it in Vercel for Production, then redeploy");
      return sendJson(res, 500, { ok: false, error: "Server not configured" });
    }

    const db = await getDb();
    const cutoff = eligibilityCutoff();

    /* Required fields are matched in the query as well as checked afterwards. The
       database holds some documents containing nothing but an _id, and excluding
       them here means they are never even read — let alone shipped. toPublicPost()
       still runs on the results, so the same validity rule the rest of the site
       uses is the one that decides what is published. */
    const documents = await db
      .collection(POSTS_COLLECTION)
      .find(
        {
          date: { $lte: cutoff },
          topic: { $exists: true },
          image: { $exists: true },
          imageAlt: { $exists: true },
          caption: { $exists: true },
          paragraph: { $exists: true },
        },
        {
          projection: {
            _id: 1,
            date: 1,
            topic: 1,
            image: 1,
            imageAlt: 1,
            caption: 1,
            paragraph: 1,
            createdAt: 1,
          },
        }
      )
      /* Newest publication date first; createdAt only separates two posts that share
         a date, so the same four come back in the same order every time rather than
         shuffling between requests. */
      .sort({ date: -1, createdAt: -1 })
      /* The limit is applied by the DATABASE, so twenty eligible posts cost the same
         four documents as four do. */
      .limit(LIMIT)
      .toArray();

    /* One unusable document must never cost the section a card, so the exact same
       serializer the public feed uses filters the result. */
    const posts = documents.map(toPublicPost).filter(Boolean);

    console.log(`[posts/featured] ${posts.length} post(s) eligible on or before ${cutoff}`);

    /* Never cached: the answer depends on today's date. */
    res.setHeader("Cache-Control", "no-store");
    return sendJson(res, 200, { ok: true, posts });
  } catch (error) {
    /* safeMessage() keeps the connection string out of the log. */
    console.error(`[posts/featured] failed: ${safeMessage(error)}`);
    return sendJson(res, 500, { ok: false, error: "Server error" });
  }
}