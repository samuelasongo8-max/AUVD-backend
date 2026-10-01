/**
 * /api/posts — the feed, read publicly and written only by the admin.
 *
 *   GET  /api/posts   public   every post, newest first
 *   POST /api/posts   admin    create one
 *
 * This is the data source behind /our-impact/post. The page used to import
 * src/data/moments.json directly; it now fetches from here, which is what
 * makes a change in the dashboard show up on the public feed.
 *
 * WHY GET IS OPEN AND POST IS NOT
 * -------------------------------
 * The feed is public by definition — it is the whole point of the page, and
 * the same content is in the page's HTML today. So GET needs no session.
 * Writing, on the other hand, changes what every visitor sees, so POST calls
 * requireAdmin() before it reads the body or touches the database at all.
 *
 * ORDERING
 * --------
 * Newest first by the post's own `date` (the day the Moment happened, not the
 * day it was typed in), which is the order a social feed is read in. `createdAt`
 * breaks ties so two posts sharing a date still come back in a stable order.
 *
 * SIGNATURE
 * ---------
 * Vercel calls the default export as (req, res) and the answer must be WRITTEN
 * on res, so every path ends in sendJson() — the same convention as
 * api/subscribe.js. The whole handler is wrapped in try/catch, and the catch
 * answers 500 with a generic message so no database or driver detail reaches
 * the client.
 *
 * ENVIRONMENT (Vercel -> Production)
 *   MONGODB_URI   the connection string, never prefixed with VITE_
 */
import { ObjectId } from "mongodb";
import { getDb, POSTS_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { validatePost, toPublicPost } from "../../lib/postValidation.js";

const log = (step, detail = "") => {
  console.log(`[posts] ${step}${detail ? ` — ${detail}` : ""}`);
};

const SERVER_ERROR = { ok: false, error: "Server error" };

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return await listPosts(res);
    }

    if (req.method === "POST") {
      /* requireAdmin answers 401 itself and returns null on any failure, so
         the write is impossible without a valid session. It runs before the
         body is read and before the database is contacted. */
      const email = requireAdmin(req, res);
      if (!email) return;

      return await createPost(req, res, email);
    }

    log("rejected", `method ${req.method}`);
    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, SERVER_ERROR);
  }
}

/** GET — public. Returns every post, newest first, in the feed's own shape. */
async function listPosts(res) {
  const db = await getDb();

  const documents = await db
    .collection(POSTS_COLLECTION)
    .find({}, { projection: { _id: 1, date: 1, topic: 1, image: 1, imageAlt: 1, caption: 1, paragraph: 1 } })
    .sort({ date: -1, createdAt: -1 })
    .toArray();

  /* toPublicPost returns null for a document that is missing fields (the
     database holds some that contain only an _id). Those are not published, and
     importantly they are not deleted either — the data is left exactly as it
     is, it is simply not handed to the feed. */
  const posts = documents.map(toPublicPost).filter(Boolean);
  log("listed", `${posts.length} post(s)`);

  /* Public content, so it may be cached briefly. `no-store` is still the safe
     default here: a post the admin just added should appear on the feed
     straight away rather than after a cache window. */
  res.setHeader("Cache-Control", "no-store");
  return sendJson(res, 200, { ok: true, posts });
}

/** POST — admin only. Validates, then inserts with createdAt/updatedAt. */
async function createPost(req, res, email) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  const { ok, value, errors } = validatePost(body);
  if (!ok) {
    log("rejected", `validation: ${errors.join(" ")}`);
    return sendJson(res, 400, { ok: false, error: errors[0], errors });
  }

  const db = await getDb();
  const now = new Date();

  /* The `_id` is generated here rather than left to the driver so the id in
     the 201 response is definitely the stored one. */
  const document = { _id: new ObjectId(), ...value, createdAt: now, updatedAt: now };

  await db.collection(POSTS_COLLECTION).insertOne(document);

  log("created", `${String(document._id)} by ${email}`);
  return sendJson(res, 201, { ok: true, post: toPublicPost(document) });
}