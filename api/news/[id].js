/**
 * /api/news/[id] — edit or remove ONE admin-created news item. Admin only.
 *
 *   PUT    /api/news/<id>    update that item
 *   DELETE /api/news/<id>    remove that item
 *
 * `[id]` is Vercel's dynamic-segment syntax: the segment becomes req.query.id.
 *
 * SCOPE — DELIBERATELY LIMITED
 * ---------------------------
 * This route can only ever touch the "news" collection, which holds nothing but
 * items created through the dashboard. The site's existing news lives in
 * src/data/news.json and is never loaded, written or deleted from here, so there
 * is no code path by which a file-backed news item could be modified or removed.
 *
 * The auth gate, validation and response shape mirror api/posts/[id].js so the
 * dashboard behaves the same way for both content types.
 */
import { ObjectId } from "mongodb";
import { getDb, NEWS_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { validateNews, toPublicNews } from "../../lib/newsValidation.js";

const log = (step, detail = "") => {
  console.log(`[news/:id] ${step}${detail ? ` — ${detail}` : ""}`);
};

const SERVER_ERROR = { ok: false, error: "Server error" };

/** A well-formed ObjectId, or null. Never throws on malformed input. */
function parseId(value) {
  const raw = String(value ?? "");
  if (!/^[0-9a-fA-F]{24}$/.test(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "PUT" && req.method !== "DELETE") {
      log("rejected", `method ${req.method}`);
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    /* requireAdmin answers 401 itself and returns null on failure. It runs before
       the id is parsed, so nothing about any item is learnable without a
       session. */
    const email = requireAdmin(req, res);
    if (!email) return;

    const id = parseId(req.query?.id);
    if (!id) {
      log("rejected", "malformed id");
      return sendJson(res, 404, { ok: false, error: "News item not found" });
    }

    const db = await getDb();
    const news = db.collection(NEWS_COLLECTION);

    if (req.method === "DELETE") {
      const result = await news.deleteOne({ _id: id });
      if (result.deletedCount === 0) {
        log("rejected", `${String(id)} not found`);
        return sendJson(res, 404, { ok: false, error: "News item not found" });
      }
      log("deleted", `${String(id)} by ${email}`);
      return sendJson(res, 200, { ok: true, id: String(id) });
    }

    /* PUT from here on. */
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

    /* `$set` never includes createdAt, so a re-save cannot rewrite when the
       item first appeared. */
    const result = await news.findOneAndUpdate(
      { _id: id },
      { $set: { ...value, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) {
      log("rejected", `${String(id)} not found`);
      return sendJson(res, 404, { ok: false, error: "News item not found" });
    }

    const item = toPublicNews(result);
    if (!item) {
      log("failed after save", `${String(id)} did not produce a readable item`);
      return sendJson(res, 500, SERVER_ERROR);
    }

    log("updated", `${String(id)} by ${email}`);
    return sendJson(res, 200, { ok: true, news: item });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, SERVER_ERROR);
  }
}