import { ObjectId } from "mongodb";
import { getDb, UPDATES_COLLECTION, safeMessage } from "../../lib/db.js";
import { requireAdmin, sendJson } from "../../lib/requireAdmin.js";
import { slugify, toPublicUpdate, validateUpdate } from "../../lib/updateValidation.js";

const log = (step, detail = "") => {
  console.log(`[updates] ${step}${detail ? ` — ${detail}` : ""}`);
};

const SERVER_ERROR = { ok: false, error: "Server error" };

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await listUpdates(res);

    if (req.method !== "POST") {
      log("rejected", `method ${req.method}`);
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    const email = requireAdmin(req, res);
    if (!email) return;

    return await createUpdate(req, res, email);
  } catch (error) {
    log("failed", safeMessage(error));
    return sendJson(res, 500, SERVER_ERROR);
  }
}

async function listUpdates(res) {
  const db = await getDb();
  const documents = await db
    .collection(UPDATES_COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  const updates = documents.map(toPublicUpdate).filter(Boolean);

  log("listed", `${updates.length} update(s)`);
  res.setHeader("Cache-Control", "no-store");
  return sendJson(res, 200, { ok: true, updates });
}

async function createUpdate(req, res, email) {
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { ok: false, error: "Invalid request body" });
    }
  }

  const validation = validateUpdate(body);
  if (!validation.ok) {
    log("rejected", `validation: ${validation.errors.join(" ")}`);
    return sendJson(res, 400, {
      ok: false,
      error: validation.errors[0],
      errors: validation.errors,
    });
  }

  const db = await getDb();
  const updates = db.collection(UPDATES_COLLECTION);
  const slugBase = slugify(validation.value.title) || "update";
  let slug = slugBase;
  let suffix = 0;
  while (await updates.findOne({ slug })) {
    suffix += 1;
    slug = `${slugBase.slice(0, 105)}-${Date.now()}${suffix > 1 ? `-${suffix}` : ""}`;
  }

  const now = new Date();
  const document = {
    _id: new ObjectId(),
    ...validation.value,
    slug,
    createdAt: now,
    updatedAt: now,
  };
  await updates.insertOne(document);

  log("created", `${String(document._id)} by ${email}`);
  return sendJson(res, 201, { ok: true, update: toPublicUpdate(document) });
}
