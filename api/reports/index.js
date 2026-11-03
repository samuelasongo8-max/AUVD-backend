import { ObjectId } from "mongodb";
import {
  getDb,
  REPORTS_COLLECTION,
  safeMessage,
} from "../../lib/db.js";
import { cloudinaryConfigured } from "../../lib/cloudinary.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import {
  deleteReportAsset,
  parseReportMultipart,
  uploadReportAsset,
} from "../../lib/reportUploads.js";

export const config = {
  api: { bodyParser: false },
};

const CATEGORIES = new Set(["annual", "financial", "activity", "other"]);
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

    const adminEmail = requireAdmin(req, res);
    if (!adminEmail) return;

    let multipart;
    try {
      multipart = await parseReportMultipart(req, res);
    } catch (error) {
      if (error?.code === "LIMIT_FILE_SIZE") {
        return sendJson(res, 413, { ok: false, error: "Each report file must be 20 MB or smaller." });
      }
      if (error?.code === "LIMIT_UNEXPECTED_FILE") {
        return sendJson(res, 400, { ok: false, error: "Upload one report file and one optional image." });
      }
      if (error?.code === "UNSUPPORTED_REPORT_FILE") {
        return sendJson(res, 415, { ok: false, error: error.message });
      }
      return sendJson(res, 400, { ok: false, error: "The uploaded files could not be read." });
    }

    stage = "report validation";
    const validation = validateReport(multipart.body, multipart.reportFile);
    if (!validation.ok) {
      return sendJson(res, 400, { ok: false, error: validation.error });
    }
    if (!cloudinaryConfigured()) {
      return sendJson(res, 503, { ok: false, error: "Report storage is not configured." });
    }

    const uploadedAssets = [];
    let reportAsset;
    let imageAsset = null;
    try {
      stage = "Cloudinary report upload";
      reportAsset = await uploadReportAsset(multipart.reportFile, "file");
      uploadedAssets.push({ publicId: reportAsset.public_id, resourceType: "raw" });

      if (multipart.reportImage) {
        stage = "Cloudinary image upload";
        imageAsset = await uploadReportAsset(multipart.reportImage, "image");
        uploadedAssets.push({ publicId: imageAsset.public_id, resourceType: "image" });
      }
    } catch (error) {
      await cleanUpAssets(uploadedAssets);
      logFailure(stage, error);
      return sendJson(res, 502, { ok: false, error: "The report files could not be uploaded." });
    }

    try {
      stage = "MongoDB connection";
      const db = await getDb();
      const now = new Date();
      const document = {
        _id: new ObjectId(),
        ...validation.value,
        reportFileUrl: reportAsset.secure_url,
        reportFilePublicId: reportAsset.public_id,
        reportFileName: safeOriginalName(multipart.reportFile.originalname),
        reportFileType: multipart.reportFile.mimetype,
        reportImageUrl: imageAsset?.secure_url ?? "",
        reportImagePublicId: imageAsset?.public_id ?? "",
        createdAt: now,
        updatedAt: now,
      };

      stage = "MongoDB report insert";
      await db.collection(REPORTS_COLLECTION).insertOne(document);
      console.log(`[reports] created ${String(document._id)} by ${adminEmail}`);
      stage = "report response serialization";
      return sendJson(res, 201, { ok: true, report: toPublicReport(document) });
    } catch (error) {
      await cleanUpAssets(uploadedAssets);
      throw error;
    }
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

function validateReport(body, reportFile) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid report details." };
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const reportDate = typeof body.reportDate === "string" ? body.reportDate.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";

  if (!title || title.length > 160) {
    return { ok: false, error: "Enter a report title of 1 to 160 characters." };
  }
  if (!CATEGORIES.has(category)) {
    return { ok: false, error: "Choose a valid report category." };
  }
  if (!isValidDate(reportDate)) {
    return { ok: false, error: "Choose a valid report date." };
  }
  if (description.length > 5000) {
    return { ok: false, error: "The description must be 5,000 characters or fewer." };
  }
  if (!reportFile) {
    return { ok: false, error: "Please upload a PDF, DOC, or DOCX report file." };
  }

  return {
    ok: true,
    value: { title, category, reportDate, description },
  };
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toPublicReport(document) {
  if (
    !document ||
    typeof document.title !== "string" ||
    typeof document.category !== "string" ||
    typeof document.reportDate !== "string" ||
    typeof document.reportFileUrl !== "string" ||
    !document.reportFileUrl
  ) {
    return null;
  }

  return {
    id: String(document._id),
    title: document.title,
    category: document.category,
    reportDate: document.reportDate,
    description: typeof document.description === "string" ? document.description : "",
    imageUrl: typeof document.reportImageUrl === "string" ? document.reportImageUrl : "",
    fileUrl: document.reportFileUrl,
    fileName: typeof document.reportFileName === "string" ? document.reportFileName : "report",
    fileType: typeof document.reportFileType === "string" ? document.reportFileType : "",
    createdAt: document.createdAt instanceof Date ? document.createdAt.toISOString() : null,
  };
}

async function cleanUpAssets(assets) {
  await Promise.all(
    assets.map(async ({ publicId, resourceType }) => {
      try {
        await deleteReportAsset(publicId, resourceType);
      } catch {
        console.error("[reports] Cloudinary cleanup failed.");
      }
    })
  );
}
