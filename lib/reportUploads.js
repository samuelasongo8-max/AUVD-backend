import { randomUUID } from "node:crypto";
import multer from "multer";
import path from "node:path";
import { cloudinary } from "./cloudinary.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const REPORT_FILE_TYPES = new Map([
  [".pdf", new Set(["application/pdf"])],
  [".doc", new Set(["application/msword"])],
  [".docx", new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"])],
]);
const IMAGE_FILE_TYPES = new Map([
  [".jpg", new Set(["image/jpeg", "image/jpg"])],
  [".jpeg", new Set(["image/jpeg", "image/jpg"])],
  [".png", new Set(["image/png"])],
  [".webp", new Set(["image/webp"])],
  [".gif", new Set(["image/gif"])],
]);

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 2, fields: 4, parts: 6 },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowedTypes =
      file.fieldname === "reportFile"
        ? REPORT_FILE_TYPES.get(extension)
        : file.fieldname === "reportImage"
          ? IMAGE_FILE_TYPES.get(extension)
          : null;

    if (!allowedTypes || !allowedTypes.has(file.mimetype)) {
      const error = new Error(
        file.fieldname === "reportFile"
          ? "Choose a PDF, DOC, or DOCX report file."
          : "Choose a JPG, PNG, WEBP, or GIF report image."
      );
      error.code = "UNSUPPORTED_REPORT_FILE";
      callback(error);
      return;
    }

    callback(null, true);
  },
});

export function parseReportMultipart(req, res) {
  return new Promise((resolve, reject) => {
    parser.fields([
      { name: "reportFile", maxCount: 1 },
      { name: "reportImage", maxCount: 1 },
    ])(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        body: req.body ?? {},
        reportFile: req.files?.reportFile?.[0] ?? null,
        reportImage: req.files?.reportImage?.[0] ?? null,
      });
    });
  });
}

function safeOriginalName(value) {
  return String(value ?? "").split(/[\\/]/).at(-1) || "report";
}

function safeRawPublicId(originalName) {
  const fileName = safeOriginalName(originalName);
  const extension = path.extname(fileName).toLowerCase();
  const baseName = path
    .basename(fileName, path.extname(fileName))
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "report";

  return `${randomUUID()}-${baseName}${extension}`;
}

export function uploadReportAsset(file, kind) {
  const isImage = kind === "image";
  const options = {
    folder: isImage ? "samuel-asongo/reports/images" : "samuel-asongo/reports/files",
    public_id: isImage ? randomUUID() : safeRawPublicId(file.originalname),
    resource_type: isImage ? "image" : "raw",
    overwrite: false,
  };

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      if (!result?.secure_url || !result.public_id) {
        reject(new Error("Cloudinary returned an incomplete report upload."));
        return;
      }
      resolve(result);
    });

    stream.end(file.buffer);
  });
}

export async function deleteReportAsset(publicId, resourceType) {
  if (!publicId) return;
  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true,
  });
  if (result.result !== "ok" && result.result !== "not found") {
    throw new Error(`Cloudinary destroy returned "${result.result}".`);
  }
}
