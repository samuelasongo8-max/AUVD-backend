import { ObjectId } from "mongodb";
import { getDb, UPDATES_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { toPublicUpdate, validateUpdate } from "../../lib/updateValidation.js";

const log = (step, detail = "") => {
  console.log(`[updates/:slug] ${step}${detail ? ` — ${detail}` : ""}`);
};

const SERVER_ERROR = { ok: false, error: "Server error" };

function getRouteValue(req) {
  const value = req.query?.slug ?? req.query?.id;
  return Array.isArray(value) ? value[0] : value;
}

function parseId(value) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{24}$/.test(value)) return null;
  return new ObjectId(value);
}

export default async function handler(req, res) {
  try {
    const routeValue = getRouteValue(req);

    if (req.method === "GET") {
      if (typeof routeValue !== "string" || !routeValue.trim()) {
        return sendJson(res, 404, { ok: false, error: "Update not found" });
      }

      const db = await getDb();
      const document = await db.collection(UPDATES_COLLECTION).findOne({ slug: routeValue });
      const update = toPublicUpdate(document);
      if (!update) return sendJson(res, 404, { ok: false, error: "Update not found" });

      res.setHeader("Cache-Control", "no-store");
      return sendJson(res, 200, { ok: true, update });
    }

    if (req.method !== "PUT" && req.method !== "DELETE") {
      log("rejected", `method ${req.method}`);
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    const email = requireAdmin(req, res);
    if (!email) return;

    const id = parseId(routeValue);
    if (!id) {
      return sendJson(res, 404, { ok: false, error: "Update not found" });
    }

    const db = await getDb();
    const updates = db.collection(UPDATES_COLLECTION);

    if (req.method === "DELETE") {
      const result = await updates.deleteOne({ _id: id });
      if (result.deletedCount === 0) {
        return sendJson(res, 404, { ok: false, error: "Update not found" });
      }

      log("deleted", `${String(id)} by ${email}`);
      return sendJson(res, 200, { ok: true, id: String(id) });
    }

    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { ok: false, error: "Invalid request body" });
      }
    }

    const validation = validateUpdate(body);
    if (!validation.ok) {
      log("rejected", `validation: ${validation.errors.join(" ")}`);
      return sendJson(res, 400, {
        ok: false,
        error: validation.errors[0],
        errors: validation.errors,
      });
    }

    const result = await updates.findOneAndUpdate(
      { _id: id },
      { $set: { ...validation.value, updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    if (!result) return sendJson(res, 404, { ok: false, error: "Update not found" });

    const update = toPublicUpdate(result);
    if (!update) return sendJson(res, 500, SERVER_ERROR);

    log("updated", `${String(id)} by ${email}`);
    return sendJson(res, 200, { ok: true, update });
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, SERVER_ERROR);
  }
}
