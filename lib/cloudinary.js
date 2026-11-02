import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import path from "node:path";
import process from "node:process";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];
const ALLOWED_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "samuel-asongo",
    allowed_formats: ALLOWED_FORMATS,
    transformation: [
      { width: 1200, crop: "limit" },
      { quality: "auto" },
      { fetch_format: "auto" },
    ],
  },
});

const uploader = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname).slice(1).toLowerCase();
    if (!ALLOWED_TYPES.has(file.mimetype) || !ALLOWED_FORMATS.includes(extension)) {
      const error = new Error("Please choose a JPG, JPEG, PNG, or WEBP image.");
      error.code = "UNSUPPORTED_IMAGE";
      callback(error);
      return;
    }
    callback(null, true);
  },
});

export const cloudinaryConfigured = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME?.trim() &&
      process.env.CLOUDINARY_API_KEY?.trim() &&
      process.env.CLOUDINARY_API_SECRET?.trim()
  );

export function uploadSingleImage(req, res) {
  return new Promise((resolve, reject) => {
    uploader.single("image")(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(req.file ?? null);
    });
  });
}

export function extractCloudinaryPublicId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "res.cloudinary.com") return "";
    const segments = parsed.pathname.split("/").filter(Boolean);
    const uploadIndex = segments.indexOf("upload");
    if (uploadIndex < 0) return "";
    const assetSegments = segments.slice(uploadIndex + 1);
    const versionIndex = assetSegments.findIndex((segment) => /^v\d+$/.test(segment));
    if (versionIndex >= 0) assetSegments.splice(0, versionIndex + 1);
    if (assetSegments.length === 0) return "";
    assetSegments[assetSegments.length - 1] = assetSegments.at(-1).replace(/\.[^.]+$/, "");
    return assetSegments.join("/");
  } catch {
    return "";
  }
}

export async function deleteCloudinaryImage(publicId) {
  if (!publicId) return false;
  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: "image",
    invalidate: true,
  });
  if (result.result !== "ok" && result.result !== "not found") {
    throw new Error(`Cloudinary destroy returned "${result.result}".`);
  }
  return result.result === "ok";
}
