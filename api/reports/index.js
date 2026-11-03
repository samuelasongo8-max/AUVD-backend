import { ObjectId } from "mongodb";
import {
  getDb,
  REPORTS_COLLECTION,
  safeMessage,
} from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { toPublicReport, validateReport } from "../../lib/reportValidation.js";

const SERVER_ERROR = { ok: false, error: "Server error" };

function logFailure(stage, error) {
  const errorName = typeof error?.name === "string" ? error.name : "Error";
  const message = safeMessage(error);
  const stackFrames = typeof error?.stack === "string"
    ? error.stack
      .split("\n")
      .slice(1, 6)
      .map((frame) => safeMessage(frame.trim()))
      .join(" | ")
    : "";

  console.error(
    `[reports] ${stage} failed (${errorName}): ${message}${stackFrames ? ` | ${stackFrames}` : ""}`
  );
}

export default async function handler(req, res) {
  let stage = "request";

  try {
    if (req.method === "GET") {
      return await listReports(res);
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    console.log("[reports] POST started");
    const adminEmail = requireAdmin(req, res);
    if (!adminEmail) return;
    console.log("[reports] auth accepted");

    stage = "report validation";
    const validation = validateReport(req.body);
    if (!validation.ok) {
      console.warn(`[reports] validation rejected: ${validation.error}`);
      return sendJson(res, 400, { ok: false, error: validation.error });
    }
    stage = "MongoDB connection";
    const db = await getDb();
    const now = new Date();
    const document = {
      _id: new ObjectId(),
      ...validation.value,
      createdAt: now,
      updatedAt: now,
    };

    stage = "MongoDB report insert";
    const result = await db.collection(REPORTS_COLLECTION).insertOne(document);
    console.log(`[reports] report saved: ${String(result.insertedId)}`);
    return sendJson(res, 201, {
      ok: true,
      id: String(result.insertedId),
    });
  } catch (error) {
    logFailure(stage, error);
    return sendJson(res, 500, SERVER_ERROR);
  }
}

async function listReports(res) {
  const db = await getDb();
  const documents = await db
    .collection(REPORTS_COLLECTION)
    .find(
      {},
      {
        projection: {
          _id: 1,
          title: 1,
          category: 1,
          reportDate: 1,
          description: 1,
          reportImageUrl: 1,
          reportFileUrl: 1,
          reportFileName: 1,
          reportFileType: 1,
          createdAt: 1,
        },
      }
    )
    .sort({ reportDate: -1, createdAt: -1 })
    .toArray();

  const reports = documents.map(toPublicReport).filter(Boolean);
  res.setHeader("Cache-Control", "no-store");
  return sendJson(res, 200, { ok: true, reports });
}
