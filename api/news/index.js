/**
 * /api/news — news created from the Admin Dashboard.
 *
 *   GET  /api/news    public   the admin-created items, newest first
 *   POST /api/news    admin    create one
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * The four news items already on the site live in src/data/news.json and are
 * NOT stored here. They are not read, not written and not migrated: this
 * collection only ever holds items an admin created from the dashboard, and
 * News.jsx merges the two sources at render time. Deleting everything from this
 * collection would leave the existing news exactly where it is.
 *
 * Mirrors api/posts/index.js deliberately — same auth gate, same validation
 * module shape, same public-read / admin-write split — so the two content types
 * behave identically and there is only one pattern to learn.
 *
 * ORDERING
 * --------
 * Newest `date` first. That is the whole reason an admin-created item appears
 * at the TOP of its topic: News.jsx merges these with the file-backed items and
 * sorts the combined list by the same key, so a newer date wins its place
 * regardless of which source it came from.
 *
 * ENVIRONMENT (Vercel -> Production)
 *   MONGODB_URI   the connection string, never prefixed with VITE_
 */
import { ObjectId } from "mongodb";
import { getDb, NEWS_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { validateNews, toPublicNews } from "../../lib/newsValidation.js";

const log = (step, detail = "") => {
  console.log(`[news] ${step}${detail ? ` — ${detail}` : ""}`);
};

const SERVER_ERROR = { ok: false, error: "Server error" };

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return await listNews(res);
    }

    if (req.method === "POST") {
      /* Same gate as the posts feed: no session, no write. */
      const email = requireAdmin(req, res);
      if (!email) return;
      return await createNews(req, res, email);
    }

    log("rejected", `method ${req.method}`);
    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, SERVER_ERROR);
  }
}

/** GET — public. Returns admin-created news, newest date first. */
async function listNews(res) {
  const db = await getDb();

  const documents = await db
    .collection(NEWS_COLLECTION)
    .find({}, { projection: { _id: 1, topic: 1, date: 1, image: 1, imageAlt: 1, title: 1, body: 1, createdAt: 1 } })
    .sort({ date: -1, createdAt: -1 })
    .toArray();

  /* toPublicNews() returns null for an unusable document; those are skipped so
     one bad record can never hide the rest. */
  const news = documents.map(toPublicNews).filter(Boolean);

  log("listed", `${news.length} admin-created item(s)`);

  /* Public content, but an admin may have just published: no-store so a new item
     is not held back. */
  res.setHeader("Cache-Control", "no-store");
  return sendJson(res, 200, { ok: true, news });
}

/** POST — admin only. Validates, then inserts. */
async function createNews(req, res, email) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  const { ok, value, errors } = validateNews(body);
  if (!ok) {
    log("rejected", `validation: ${errors.join(" ")}`);
    return sendJson(res, 400, { ok: false, error: errors[0], errors });
  }

  const db = await getDb();
  const now = new Date();

  /* The `_id` is generated here so the id in the 201 response is the stored one. */
  const document = { _id: new ObjectId(), ...value, createdAt: now, updatedAt: now };

  await db.collection(NEWS_COLLECTION).insertOne(document);

  /* Only the date is logged: the title is the author's own words and there is no
     need to copy it into a log file. */
  log("created", `${String(document._id)} dated ${document.date} by ${email}`);
  return sendJson(res, 201, { ok: true, news: toPublicNews(document) });
}