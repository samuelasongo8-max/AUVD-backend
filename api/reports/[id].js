import { ObjectId } from "mongodb";
import { getDb, REPORTS_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { toPublicReport, validateReport } from "../../lib/reportValidation.js";

const SERVER_ERROR = { ok: false, error: "Server error" };

function parseId(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^[a-fA-F0-9]{24}$/.test(raw)) return null;
  return new ObjectId(raw);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "PUT" && req.method !== "DELETE") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    const email = requireAdmin(req, res);
    if (!email) return;

    const id = parseId(req.query?.id);
    if (!id) {
      return sendJson(res, 404, { ok: false, error: "Report not found" });
    }

    const db = await getDb();
    const reports = db.collection(REPORTS_COLLECTION);
    if (req.method === "DELETE") {
      const result = await reports.deleteOne({ _id: id });
      if (result.deletedCount === 0) {
        return sendJson(res, 404, { ok: false, error: "Report not found" });
      }

      console.log(`[reports/:id] deleted ${String(id)} by ${email}`);
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

    const validation = validateReport(body);
    if (!validation.ok) {
      return sendJson(res, 400, { ok: false, error: validation.error });
    }

    const result = await reports.findOneAndUpdate(
      { _id: id },
      { $set: { ...validation.value, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) {
      return sendJson(res, 404, { ok: false, error: "Report not found" });
    }

    const report = toPublicReport(result);
    if (!report) {
      return sendJson(res, 500, SERVER_ERROR);
    }

    console.log(`[reports/:id] updated ${String(id)} by ${email}`);
    return sendJson(res, 200, { ok: true, report });
  } catch (error) {
    console.error(`[reports/:id] update failed: ${safeMessage(error)}`);
    return sendJson(res, 500, SERVER_ERROR);
  }
}
