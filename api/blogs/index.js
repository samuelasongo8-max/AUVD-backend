/**
 * /api/blogs — Blog Management. A SEPARATE resource from posts and news.
 *
 *   GET  /api/blogs    reads the blog articles
 *   POST /api/blogs    admin only — create one
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * Blogs live in their own "blogs" collection and are NOT published anywhere
 * yet. This route is the admin dashboard's half only: the public Blog.jsx page
 * is deliberately left empty and reads nothing. Nothing here touches the posts
 * or news collections, so GET /api/posts and every existing post are unaffected.
 *
 * Mirrors api/news/index.js deliberately — same auth gate, same validation
 * module shape, same public-read / admin-write split — so there is only one
 * pattern to learn.
 *
 * ENVIRONMENT (Vercel -> Production)
 *   MONGODB_URI   the connection string, never prefixed with VITE_
 */
import { ObjectId } from "mongodb";
import { getDb, BLOGS_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { validateBlog, toPublicBlog } from "../../lib/blogValidation.js";

const log = (step, detail = "") => {
  console.log(`[blogs] ${step}${detail ? ` — ${detail}` : ""}`);
};

const SERVER_ERROR = { ok: false, error: "Server error" };

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return await listBlogs(res);
    }

    if (req.method === "POST") {
      /* Same gate as posts and news: no session, no write. */
      const email = requireAdmin(req, res);
      if (!email) return;
      return await createBlog(req, res, email);
    }

    log("rejected", `method ${req.method}`);
    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, SERVER_ERROR);
  }
}

/** GET — the dashboard's list. Newest `date` first. */
async function listBlogs(res) {
  const db = await getDb();

  const documents = await db
    .collection(BLOGS_COLLECTION)
    .find(
      {},
      { projection: { _id: 1, title: 1, content: 1, date: 1, image: 1, imageAlt: 1, createdAt: 1 } },
    )
    .sort({ date: -1, createdAt: -1 })
    .toArray();

  /* toPublicBlog() returns null for an unusable document; those are skipped so
     one bad record can never hide the rest. */
  const blogs = documents.map(toPublicBlog).filter(Boolean);

  log("listed", `${blogs.length} blog(s)`);

  /* An admin may have just saved one: no-store so it is not held back. */
  res.setHeader("Cache-Control", "no-store");
  return sendJson(res, 200, { ok: true, blogs });
}

/** POST — admin only. Validates, then inserts. */
async function createBlog(req, res, email) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  const { ok, value, errors } = validateBlog(body);
  if (!ok) {
    log("rejected", `validation: ${errors.join(" ")}`);
    return sendJson(res, 400, { ok: false, error: errors[0], errors });
  }

  const db = await getDb();
  const now = new Date();

  /* The `_id` is generated here so the id in the 201 response is the stored one. */
  const document = { _id: new ObjectId(), ...value, createdAt: now, updatedAt: now };

  await db.collection(BLOGS_COLLECTION).insertOne(document);

  /* Only the date is logged: the title is the author's own words. */
  log("created", `${String(document._id)} dated ${document.date} by ${email}`);
  return sendJson(res, 201, { ok: true, blog: toPublicBlog(document) });
}
