/**
 * /api/blogs/[id] — edit or remove ONE blog article. Admin only.
 *
 *   PUT    /api/blogs/<id>    update that article
 *   DELETE /api/blogs/<id>    remove that article
 *
 * `[id]` is Vercel's dynamic-segment syntax: the segment becomes req.query.id.
 *
 * SCOPE — DELIBITELY LIMITED
 * ---------------------------
 * This route can only ever touch the "blogs" collection, which holds nothing but
 * articles created through the dashboard. It never loads, writes or deletes a
 * post or a news item, so there is no code path by which an existing post could
 * be modified or removed through the blog page.
 *
 * The auth gate, validation and response shape mirror api/news/[id].js so the
 * dashboard behaves the same way for all three content types.
 */
import { ObjectId } from "mongodb";
import { getDb, BLOGS_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { validateBlog, toPublicBlog } from "../../lib/blogValidation.js";
import { deleteCloudinaryImage, extractCloudinaryPublicId } from "../../lib/cloudinary.js";

const log = (step, detail = "") => {
  console.log(`[blogs/:id] ${step}${detail ? ` — ${detail}` : ""}`);
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
       the id is parsed, so nothing about any article is learnable without a
       session. */
    const email = requireAdmin(req, res);
    if (!email) return;

    const id = parseId(req.query?.id);
    if (!id) {
      log("rejected", "malformed id");
      return sendJson(res, 404, { ok: false, error: "Blog not found" });
    }

    const db = await getDb();
    const blogs = db.collection(BLOGS_COLLECTION);

    if (req.method === "DELETE") {
      const current = await blogs.findOne({ _id: id });
      if (!current) {
        return sendJson(res, 404, { ok: false, error: "Blog not found" });
      }
      const publicIds = [
        current.imagePublicId || extractCloudinaryPublicId(current.image),
        current.contentImagePublicId || extractCloudinaryPublicId(current.contentImage),
      ].filter(Boolean);
      try {
        for (const publicId of new Set(publicIds)) await deleteCloudinaryImage(publicId);
      } catch (error) {
        log("image cleanup failed", error?.message ?? error);
        return sendJson(res, 502, {
          ok: false,
          error: "The blog could not be deleted because a Cloudinary image could not be removed.",
        });
      }
      const result = await blogs.deleteOne({ _id: id });
      if (result.deletedCount === 0) {
        log("rejected", `${String(id)} not found`);
        return sendJson(res, 404, { ok: false, error: "Blog not found" });
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

    const { ok, value, errors } = validateBlog(body);
    if (!ok) {
      log("rejected", `validation: ${errors.join(" ")}`);
      return sendJson(res, 400, { ok: false, error: errors[0], errors });
    }

    const current = await blogs.findOne({ _id: id });
    if (!current) {
      return sendJson(res, 404, { ok: false, error: "Blog not found" });
    }

    /* `$set` never includes createdAt, so a re-save cannot rewrite when the
       article first appeared. */
    const result = await blogs.findOneAndUpdate(
      { _id: id },
      { $set: { ...value, updatedAt: new Date() } },
      { returnDocument: "after" },
    );

    if (!result) {
      log("rejected", `${String(id)} not found`);
      return sendJson(res, 404, { ok: false, error: "Blog not found" });
    }

    const item = toPublicBlog(result);
    if (!item) {
      log("failed after save", `${String(id)} did not produce a readable article`);
      return sendJson(res, 500, SERVER_ERROR);
    }

    log("updated", `${String(id)} by ${email}`);
    const oldPublicIds = [
      current.imagePublicId || extractCloudinaryPublicId(current.image),
      current.contentImagePublicId || extractCloudinaryPublicId(current.contentImage),
    ];
    const newPublicIds = [
      value.imagePublicId || extractCloudinaryPublicId(value.image),
      value.contentImagePublicId || extractCloudinaryPublicId(value.contentImage),
    ];
    try {
      for (const publicId of new Set(oldPublicIds.filter((id) => id && !newPublicIds.includes(id)))) {
        await deleteCloudinaryImage(publicId);
      }
    } catch (error) {
      log("image cleanup failed", error?.message ?? error);
      return sendJson(res, 502, {
        ok: false,
        saved: true,
        error: "Blog updated, but a previous Cloudinary image could not be removed.",
      });
    }
    return sendJson(res, 200, { ok: true, blog: item });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, SERVER_ERROR);
  }
}
