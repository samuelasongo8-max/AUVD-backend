/**
 * /api/admin/upload — stores an image chosen by an admin in the dashboard.
 *
 *   POST /api/admin/upload      raw image bytes
 *     -> 200 { ok: true, url, width, height }
 *     -> 401 the caller has no valid admin session
 *     -> 413 the file is larger than the limit
 *     -> 415 the file is not a JPG / PNG / WEBP
 *
 * WHY RAW BYTES AND NOT multipart/form-data
 * -----------------------------------------
 * A multipart upload needs a parser, and the project has none. Adding one to
 * handle a single endpoint would be more code than the endpoint itself. The
 * browser can send a File as the request body directly, and Node hands it over
 * as a Buffer, so the whole feature needs no new dependency at all. The
 * filename travels in a header instead of the body.
 *
 * The trade-off is stated plainly: this endpoint accepts one image per request
 * and nothing else. It cannot carry extra form fields, because it is not a form.
 * The dashboard uploads the image first and then saves the post with the URL it
 * gets back, which is why the image survives a refresh — it is already on disk
 * and in the database before the post is ever written.
 *
 * AUTHENTICATION
 * --------------
 * requireAdmin() runs before a single byte is read or decoded, so an anonymous
 * request cannot upload anything at all, cannot make the server spend CPU
 * decoding a file, and cannot learn whether the endpoint exists beyond the 401.
 *
 * ENVIRONMENT
 *   JWT_SECRET   the same secret every other admin route uses
 */
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import {
  ACCEPTED_TYPES,
  MAX_IMAGE_BYTES,
  checkSize,
  normaliseImage,
  writeImage,
  publicBaseUrl,
} from "../../lib/imageUpload.js";

const log = (step, detail = "") => {
  console.log(`[admin/upload] ${step}${detail ? ` — ${detail}` : ""}`);
};

/** Never logs the name or the bytes of an upload. */
const mask = (email) => {
  const [user = "", domain = ""] = String(email).split("@");
  return `${user.slice(0, 2)}***@${domain}`;
};

/** Vercel calls this as (req, res). Every branch answers. */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    /* First, before the body is touched: no session, no upload. */
    const email = requireAdmin(req, res);
    if (!email) {
      log("refused", "no valid admin session");
      return;
    }

    /* server/index.js parses this route's body as a Buffer (express.raw). On
       Vercel a raw body arrives the same way. A string here means something
       upstream parsed it as text, which would corrupt the image. */
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      log("rejected", `${mask(email)} sent no image data`);
      return sendJson(res, 400, { ok: false, error: "No image data was received." });
    }

    const sizeError = checkSize(body.length);
    if (sizeError) {
      log("rejected", `${mask(email)} — ${sizeError}`);
      return sendJson(res, body.length > MAX_IMAGE_BYTES ? 413 : 400, { ok: false, error: sizeError });
    }

    /* The browser's Content-Type is only a hint; it is checked so an obviously
       wrong upload fails fast, and then ignored, because normaliseImage() is
       what actually decides the type from the bytes. */
    const declared = String(req.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (declared && !ACCEPTED_TYPES[declared]) {
      log("rejected", `${mask(email)} — unexpected content type`);
      return sendJson(res, 415, {
        ok: false,
        error: "That file is not a supported image. Please choose a JPG, PNG or WEBP file.",
      });
    }

    /* Decodes, verifies and re-encodes. Throws with a userMessage for anything
       that is not really an image. */
    const image = await normaliseImage(body);

    /* The origin this request arrived on, so the stored URL is absolute and works
       from the frontend's different domain. */
    const saved = await writeImage({ ...image, baseUrl: publicBaseUrl(req) });

    /* The stored URL and the dimensions only. No filename, no bytes, no token. */
    log("stored", `${mask(email)} — ${saved.bytes} bytes, ${image.width}x${image.height}`);
    return sendJson(res, 200, {
      ok: true,
      url: saved.url,
      width: image.width,
      height: image.height,
      bytes: saved.bytes,
    });
  } catch (error) {
    /* normaliseImage() attaches a message written for the administrator; any
       other failure is a server fault and gets the generic one. */
    if (error?.userMessage) {
      log("rejected", error.message);
      return sendJson(res, 415, { ok: false, error: error.userMessage });
    }

    log("failed", error?.message ?? error);
    return sendJson(res, 500, { ok: false, error: "The image could not be saved." });
  }
}