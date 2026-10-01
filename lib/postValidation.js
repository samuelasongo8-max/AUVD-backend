/**
 * lib/postValidation.js — the ONE definition of a valid post.
 *
 * Both the create route (api/posts/index.js) and the update route
 * (api/posts/[id].js) validate with these same functions, so a post created
 * through the dashboard and one updated through it can never drift apart, and
 * a new endpoint gets the rules for free by importing from here.
 *
 * The rules deliberately mirror scripts/validate-moments.mjs, which validates
 * the same fields in the static moments.json file. Keeping them aligned means
 * the old file and the new database accept exactly the same content.
 */

/** The four topics, matching the filter chips on the public feed. */
export const TOPICS = ["education", "music", "dance", "vocational"];

/** The fields a visitor can see on the feed. Each must be a non-empty string. */
const REQUIRED_FIELDS = ["image", "imageAlt", "caption", "paragraph"];

/** Rejects 2026-02-31 and friends, which Date would silently roll over. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_FIELD_LENGTH = 5000;

const isValidDate = (value) => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
};

/**
 * Validates a submitted post and returns a clean, trimmed copy.
 *
 * Only the seven known fields are read, so a client cannot smuggle extra keys
 * (`_id`, `createdAt`, …) into the database document.
 *
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validatePost(body) {
  const errors = [];

  if (!body || typeof body !== "object") {
    return { ok: false, errors: ["A JSON body is required."] };
  }

  const value = {};

  for (const field of REQUIRED_FIELDS) {
    const raw = body[field];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      errors.push(`"${field}" is required and must be a non-empty string.`);
    } else if (raw.length > MAX_FIELD_LENGTH) {
      errors.push(`"${field}" is too long (max ${MAX_FIELD_LENGTH} characters).`);
    } else {
      value[field] = raw.trim();
    }
  }

  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!isValidDate(date)) {
    errors.push('"date" must be a real date in YYYY-MM-DD form, e.g. 2026-08-15.');
  } else {
    value.date = date;
  }

  const topic = typeof body.topic === "string" ? body.topic.trim().toLowerCase() : "";
  if (!TOPICS.includes(topic)) {
    errors.push(`"topic" must be one of: ${TOPICS.join(", ")}.`);
  } else {
    value.topic = topic;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Shapes a MongoDB document into the exact object the public feed expects.
 *
 * The feed was written against src/data/moments.json, whose entries carry
 * `id`; MongoDB's own identifier is `_id`. It is renamed to `id` here so
 * Post.jsx keeps rendering `entry.id` exactly as before, and `_id` plus the
 * internal `legacyId` are left out of the public shape.
 *
 * A document missing any of the seven fields returns null and is dropped by the
 * caller. This is NOT defensive padding: the database currently holds a number
 * of documents that contain nothing but an `_id`, and returning those shaped but
 * empty would make the feed sort on `undefined` and throw while rendering —
 * taking every real post down with it. The data is left alone; it is simply not
 * published.
 *
 * @returns {object|null} null when the document is unusable.
 */
export function toPublicPost(document) {
  if (!document) return null;

  /* Every field the feed renders. Checked here, once, so no route has to
     remember and no screen has to defend against a half-built entry. */
  const fields = ["date", "topic", "image", "imageAlt", "caption", "paragraph"];
  if (fields.some((field) => typeof document[field] !== "string" || !document[field].trim())) {
    return null;
  }

  return {
    id: String(document._id),
    date: document.date,
    topic: document.topic,
    image: document.image,
    imageAlt: document.imageAlt,
    caption: document.caption,
    paragraph: document.paragraph,
  };
}