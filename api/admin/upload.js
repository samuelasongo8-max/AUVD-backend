import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import {
  cloudinaryConfigured,
  uploadSingleImage,
} from "../../lib/cloudinary.js";

const log = (step, detail = "") => {
  console.log(`[admin/upload] ${step}${detail ? ` — ${detail}` : ""}`);
};

const mask = (email) => {
  const [user = "", domain = ""] = String(email).split("@");
  return `${user.slice(0, 2)}***@${domain}`;
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    const email = requireAdmin(req, res);
    if (!email) return;

    if (!cloudinaryConfigured()) {
      log("failed", "Cloudinary credentials are missing");
      return sendJson(res, 503, { ok: false, error: "Image storage is not configured." });
    }

    let file;
    try {
      file = await uploadSingleImage(req, res);
    } catch (error) {
      if (error?.code === "LIMIT_FILE_SIZE") {
        return sendJson(res, 413, { ok: false, error: "The image must be 10 MB or smaller." });
      }
      if (error?.code === "LIMIT_UNEXPECTED_FILE") {
        return sendJson(res, 400, { ok: false, error: "Send one image in the image field." });
      }
      if (error?.code === "UNSUPPORTED_IMAGE") {
        return sendJson(res, 415, { ok: false, error: error.message });
      }
      log("failed", error?.message ?? error);
      return sendJson(res, 502, { ok: false, error: "The image could not be uploaded to Cloudinary." });
    }

    if (!file || !file.path || !file.filename || !file.size) {
      log("rejected", `${mask(email)} sent no image`);
      return sendJson(res, 400, { ok: false, error: "Please choose an image to upload." });
    }

    log("stored", `${mask(email)} — Cloudinary public_id: ${file.filename}`);
    return sendJson(res, 200, {
      ok: true,
      url: file.path,
      public_id: file.filename,
      width: file.width ?? null,
      height: file.height ?? null,
      bytes: file.size ?? null,
    });
  } catch (error) {
    log("failed", error?.message ?? error);
    return sendJson(res, 500, { ok: false, error: "The image could not be saved." });
  }
}
