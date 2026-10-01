/**
 * lib/imageUpload.js — the rules for an admin-uploaded image, in one place.
 *
 * THERE WAS NO EXISTING UPLOAD SYSTEM
 * ----------------------------------
 * The project had no upload endpoint, no multipart parsing and no image storage.
 * What it did have is a convention worth following rather than replacing:
 * `public/moments/*.jpg` and the rest of `public/`, referenced from a post as a
 * plain path such as "/moments/education-study-group.jpg". So an uploaded image
 * is written into `public/` and stored as that same kind of path — which is why
 * an uploaded post image needs no change at all in the public feed: it already
 * renders whatever path the post carries.
 *
 * KNOWN LIMITATION — READ THIS BEFORE DEPLOYING
 * ---------------------------------------------
 * Writing into `public/` works on this machine and survives a server restart,
 * because it is an ordinary directory on disk. It does NOT work on Vercel, where
 * the deployed filesystem is read-only apart from /tmp. The day this site goes
 * live, uploaded images need real object storage (Cloudinary, S3, Vercel Blob)
 * and this module is the single place to change: swap writeImage() for a call to
 * that service and everything else keeps working.
 *
 * SECURITY
 * --------
 * The type is decided by the file's ACTUAL CONTENT, never by the name or the
 * Content-Type the browser sent — those are chosen by whoever is uploading. A
 * script renamed to .jpg is rejected here. Everything is re-encoded to a plain
 * raster format, so nothing executable is ever written to disk, and the stored
 * filename is generated rather than taken from the client.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));

/* This module lives in backends/lib/, but public/ is at the PROJECT root — two
   levels up. Before the backend was consolidated into backends/ this was a
   single "..", which would now have resolved to backends/public and silently
   written every uploaded image into a folder nothing serves. */
const projectRoot = path.join(here, "..", "..");

/** Where uploaded images are written, relative to public/. */
const UPLOAD_SUBDIR = "uploads";

/**
 * The public URL prefix the files are served from. Vite serves everything in
 * public/ at the root, so a file at public/uploads/x.jpg is /uploads/x.jpg.
 */
export const UPLOAD_URL_PREFIX = `/${UPLOAD_SUBDIR}`;

/**
 * The largest image accepted, in bytes.
 *
 * Enforced here on the raw upload AND in the form, because a limit checked only
 * in the browser is not a limit at all. 8 MB is comfortably above a modern phone
 * photo and low enough that the write stays quick.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

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

/** The absolute directory uploads are written to, created on first use. */
export function uploadDirectory() {
  return path.join(projectRoot, "public", UPLOAD_SUBDIR);
}

/**
 * A generated filename. The administrator's own filename is NEVER used for the
 * stored file: it can contain path separators, unicode that some filesystems
 * mangle, or an executable extension. The original name is shown in the form
 * instead, where it is harmless.
 */
function storedName(extension) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `post-${stamp}-${randomBytes(8).toString("hex")}.${extension}`;
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
 * Writes a validated image into public/uploads and returns the URL to store on
 * the post.
 *
 * @returns {Promise<{ url: string, bytes: number }>}
 */
export async function writeImage({ buffer, extension }) {
  const directory = uploadDirectory();
  await fs.mkdir(directory, { recursive: true });

  const filename = storedName(extension);
  await fs.writeFile(path.join(directory, filename), buffer);

  return {
    url: `${UPLOAD_URL_PREFIX}/${filename}`,
    bytes: buffer.length,
  };
}

/**
 * Removes a previously uploaded file.
 *
 * Only ever called for a file this module wrote: the caller must pass a URL
 * under /uploads/ exactly as writeImage() produced it. Anything else — an
 * existing hand-placed image like /moments/dance-class.jpg, or a path trying to
 * climb out of the directory — returns false and nothing is touched. Deleting a
 * post therefore never removes a file the project shipped with.
 *
 * @returns {Promise<boolean>} true when a file was removed.
 */
export async function deleteUploadedImage(url) {
  const prefix = `${UPLOAD_URL_PREFIX}/`;
  if (typeof url !== "string" || !url.startsWith(prefix)) return false;

  /* Resolve and confirm the result is still inside the upload directory. This
     is what stops "../../.env" or an absolute path from being honoured. */
  const directory = uploadDirectory();
  const target = path.resolve(directory, url.slice(prefix.length));
  if (target !== directory && !target.startsWith(directory + path.sep)) return false;

  try {
    await fs.unlink(target);
    return true;
  } catch {
    /* Already gone, or never ours. Not an error worth surfacing. */
    return false;
  }
}
