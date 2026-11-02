import { sendJson } from "../../lib/requireAdmin.js";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { ok: false, error: "Method not allowed" });
  }

  return sendJson(res, 200, {
    CLOUDINARY_CLOUD_NAME: Boolean(process.env.CLOUDINARY_CLOUD_NAME?.trim()),
    CLOUDINARY_API_KEY: Boolean(process.env.CLOUDINARY_API_KEY?.trim()),
    CLOUDINARY_API_SECRET: Boolean(process.env.CLOUDINARY_API_SECRET?.trim()),
  });
}
