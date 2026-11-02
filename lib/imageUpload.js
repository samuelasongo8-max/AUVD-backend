/**
 * lib/imageUpload.js — the rules for an admin-uploaded image, in one place.
 *
 * The upload route stores new images using CloudinaryStorage in cloudinary.js.
 * uploadDirectory() remains only to serve older records that still reference
 * files from the former local uploads folder.
 *
 * SECURITY
 * --------
 * The type is decided by the file's ACTUAL CONTENT, never by the name or the
 * Content-Type the browser sent — those are chosen by whoever is uploading. A
 * script renamed to .jpg is rejected here. Everything is re-encoded to a plain
 * raster format, so nothing executable is ever written to disk, and the stored
 * filename is generated rather than taken from the client.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/* Keep the former upload directory available for legacy URLs. */
const projectRoot = path.join(here, "..");

/** Local path retained for serving legacy uploads only. */
const UPLOAD_SUBDIR = "uploads";

/**
 * The public URL prefix the files are served from. Vite serves everything in
 * public/ at the root, so a file at public/uploads/x.jpg is /uploads/x.jpg.
 */
export const UPLOAD_URL_PREFIX = `/${UPLOAD_SUBDIR}`;

/**
 * The largest image accepted, in bytes.
 *
 * The Cloudinary multer middleware and dashboard both enforce this limit.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Formats accepted from the administrator, keyed by the MIME type the browser
 * reports. This is only the FIRST gate — the bytes are decoded and re-encoded
 * below, so a file that lies about its type still cannot be stored as anything
 * other than a plain image.
 */
export const ACCEPTED_TYPES = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The `accept` attribute for the file input, so the OS picker filters for us. */
export const ACCEPT_ATTRIBUTE = "image/jpeg,image/png,image/webp";

/** The absolute directory used to serve legacy uploads. */
export function uploadDirectory() {
  return path.join(projectRoot, "public", UPLOAD_SUBDIR);
}

/**
 * Checks the size before anything is decoded, so an oversized upload costs
 * nothing beyond reading its length.
 *
 * @returns {string|null} an error message, or null when the size is fine.
 */
export function checkSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "That file is empty. Please choose an image from your device.";
  }

  if (bytes > MAX_IMAGE_BYTES) {
    const mb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
    return `That image is too large (max ${mb} MB). Please choose a smaller one.`;
  }

  return null;
}

/**
 * Decodes the upload, proves it really is a raster image, and re-encodes it.
 *
 * This is the real type check. `sharp` reads the bytes and reports what is
 * actually inside; if the buffer is not a JPEG, PNG or WEBP it throws, and a
 * renamed script or HTML file is refused. Re-encoding to a plain raster format
 * also strips any embedded metadata and guarantees nothing executable is stored.
 *
 * @returns {Promise<{ buffer: Buffer, extension: string, width: number|null, height: number|null }>}
 * @throws {Error} carrying a `userMessage` when the file is not acceptable.
 */
export async function normaliseImage(buffer) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    const error = new Error("Image processing is unavailable on this server.");
    error.userMessage = "Image processing is unavailable on this server.";
    throw error;
  }

  const metadata = await sharp(buffer).metadata().catch(() => null);

  if (!metadata?.format || !ACCEPTED_TYPES[`image/${metadata.format}`]) {
    const error = new Error("Unsupported image format.");
    error.userMessage =
      "That file is not a supported image. Please choose a JPG, PNG or WEBP file.";
    throw error;
  }

  /* `rotate()` with no argument applies the EXIF orientation, so a photo taken
     sideways in a phone camera is stored the right way up instead of needing
     the browser to honour the EXIF tag. */
  const format = metadata.format === "jpeg" ? "jpeg" : metadata.format;
  const pipeline = sharp(buffer).rotate();

  const output =
    format === "jpeg"
      ? await pipeline.jpeg({ quality: 82 }).toBuffer()
      : await pipeline.png({ compressionLevel: 9 }).toBuffer();

  return {
    buffer: output,
    extension: format === "jpeg" ? "jpg" : format,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
  };
}

/**
 * The public origin THIS server is reached on, e.g. "https://auvds-backend.onrender.com".
 *
 * Read from the request rather than an environment variable, so it is always
 * correct for whichever host Render is serving right now, with nothing to
 * configure and nothing to keep in sync.
 *
 * NOTE: SITE_URL is deliberately NOT used here. In this project SITE_URL is the
 * FRONTEND's address (it is used to build newsletter unsubscribe links), so
 * prefixing images with it would produce exactly the broken URL this change
 * exists to fix — the frontend's domain, which does not serve the files.
 *
 * @returns {string} origin with no trailing slash, or "" when it cannot be told.
 */
export function publicBaseUrl(req) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim();
  const proto =
    forwardedProto || (req?.socket?.encrypted ? "https" : "http");

  const host = String(req?.headers?.["x-forwarded-host"] ?? req?.headers?.host ?? "")
    .split(",")[0]
    .trim();

  return host ? `${proto}://${host}` : "";
}
