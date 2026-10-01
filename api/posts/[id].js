/**
 * /api/posts/[id] — edit or remove ONE post. Admin only.
 *
 *   PUT    /api/posts/<id>   update that post
 *   DELETE /api/posts/<id>   remove that post
 *
 * `[id]` is Vercel's dynamic-segment syntax: the segment becomes `req.query.id`.
 * It is the post's MongoDB `_id`, which is exactly the `id` the public feed
 * receives, so the dashboard can edit a post straight from the list it renders.
 *
 * BOTH METHODS ARE PROTECTED
 * --------------------------
 * requireAdmin() runs before the id is even looked at, so an unauthenticated
 * request cannot use the response to discover whether a given post exists —
 * a valid session is required first, always, before anything else happens.
 *
 * A PUT is a full replace, not a patch: the same seven fields are validated
 * and written exactly as they would be for a new post, so a post can never be
 * left half-updated with a missing caption. `createdAt` is deliberately NOT
 * touched — it records when the post first appeared and stays true — while
 * `updatedAt` moves to now.
 *
 * SIGNATURE
 * ---------
 * Vercel calls the default export as (req, res) and the answer must be WRITTEN
 * on res, so every path ends in sendJson() — the same convention as
 * api/subscribe.js. The whole handler is wrapped in try/catch, and the catch
 * answers 500 with a generic message so no driver detail reaches the client.
 *
 * ENVIRONMENT (Vercel -> Production)
 *   MONGODB_URI   the connection string, never prefixed with VITE_
 */
import { ObjectId } from "mongodb";
import { getDb, POSTS_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { validatePost, toPublicPost } from "../../lib/postValidation.js";

const log = (step, detail = "") => {
  console.log(`[posts/:id] ${step}${detail ? ` — ${detail}` : ""}`);
};

const SERVER_ERROR = { ok: false, error: "Server error" };

/**
 * Turns the raw URL segment into an ObjectId, or null when it is not one.
 *
 * A plain string that cannot be an ObjectId (a wrong id, or something injected
 * into the URL) is rejected here rather than being handed to the driver, so a
 * malformed id produces a clean 404 instead of a thrown cast error.
 */
function parseId(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^[a-fA-F0-9]{24}$/.test(value)) return null;
  return new ObjectId(value);
}

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "PUT" && req.method !== "DELETE") {
      log("rejected", `method ${req.method}`);
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    /* requireAdmin answers 401 itself and returns null on any failure. It runs
       first, before the id is parsed, so nothing about the post is learnable
       without a valid session. */
    const email = requireAdmin(req, res);
    if (!email) return;

    const id = parseId(req.query?.id);
    if (!id) {
      log("rejected", "malformed id");
      return sendJson(res, 404, { ok: false, error: "Post not found" });
    }

    const db = await getDb();
    const posts = db.collection(POSTS_COLLECTION);

    if (req.method === "DELETE") {
      const result = await posts.deleteOne({ _id: id });
      if (result.deletedCount === 0) {
        log("rejected", `${String(id)} not found`);
        return sendJson(res, 404, { ok: false, error: "Post not found" });
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

    const { ok, value, errors } = validatePost(body);
    if (!ok) {
      log("rejected", `validation: ${errors.join(" ")}`);
      return sendJson(res, 400, { ok: false, error: errors[0], errors });
    }

    /* `$set` for the seven fields plus updatedAt only: `createdAt` is never in
       the update, so a re-save cannot rewrite when the post first appeared. */
    const result = await posts.findOneAndUpdate(
      { _id: id },
      { $set: { ...value, updatedAt: new Date() } },
      /* `returnDocument: "after"` returns the saved document, so the response
         is the post as it now exists rather than what was submitted. */
      { returnDocument: "after" }
    );

    if (!result) {
      log("rejected", `${String(id)} not found`);
      return sendJson(res, 404, { ok: false, error: "Post not found" });
    }

    log("updated", `${String(id)} by ${email}`);
    /* A null here would mean the document that was just saved is unusable, which
       validation above makes impossible. Answered as 500 rather than returning a
       null post, so the client can never cache "saved" against an empty body. */
    const post = toPublicPost(result);
    if (!post) {
      log("failed after save", `${String(id)} did not produce a readable post`);
      return sendJson(res, 500, SERVER_ERROR);
    }

    return sendJson(res, 200, { ok: true, post });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, SERVER_ERROR);
  }
}