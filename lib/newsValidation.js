/**
 * lib/newsValidation.js — the ONE definition of a valid news item.
 *
 * WHY THIS EXISTS ALONGSIDE postValidation.js
 * -------------------------------------------
 * News and posts are different content with different fields, so they get their
 * own rules — but they are validated the same WAY, by one module, so the create
 * route, the update route and the admin form can never drift apart. It is
 * written to mirror lib/postValidation.js deliberately.
 *
 * THE EXISTING NEWS IS NOT TOUCHED
 * --------------------------------
 * The four news items already on the site live in src/data/news.json and are
 * never read, written or validated by this module. That file stays exactly as
 * it is — the admin's new items go to MongoDB and are MERGED with it at render
 * time. Nothing here can affect the existing items.
 *
 * THE FIELD SHAPES ARE THE EXISTING ONES
 * ---------------------------------------
 * src/data/news.json stores localised copy as { en, fr } objects and the body as
 * an ARRAY of paragraphs. News.jsx already renders that shape, and an admin can
 * only write one language here, so toPublicNews() wraps a plain string back into
 * that same shape. That is what lets a database item render through the existing
 * card components with no change to News.jsx's markup.
 */
import { TOPICS } from "./postValidation.js";

export { TOPICS };

/** The fields the admin must supply. `image` is optional: a news item can
 *  legally have no picture, and News.jsx already renders without one. */
const REQUIRED_FIELDS = ["title", "body", "date"];

/** Rejects 2026-02-31 and friends, which Date would silently roll over. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_TITLE = 200;
const MAX_BODY = 8000;
const MAX_FIELD_LENGTH = 5000;

const isValidDate = (value) => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
};

/**
 * Validates a submitted news item and returns a clean, trimmed copy.
 *
 * Only the known fields are read, so a client cannot smuggle `_id` or
 * `createdAt` into the document.
 *
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateNews(body) {
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

  const title = String(body.title ?? "").trim();
  if (title.length > MAX_TITLE) {
    errors.push(`"title" is too long (max ${MAX_TITLE} characters).`);
  } else if (title) {
    value.title = title;
  }

  const text = String(body.body ?? "").trim();
  if (text.length > MAX_BODY) {
    errors.push(`"body" is too long (max ${MAX_BODY} characters).`);
  } else if (text) {
    value.body = text;
  }

  if (value.date && !isValidDate(value.date)) {
    errors.push('"date" must be a real date in YYYY-MM-DD form, e.g. 2026-08-15.');
    delete value.date;
  }

  /* Optional: a news item may have no image at all. */
  const image = typeof body.image === "string" ? body.image.trim() : "";
  value.image = image || null;

  const imageAlt = typeof body.imageAlt === "string" ? body.imageAlt.trim() : "";
  value.imageAlt = imageAlt || null;

  const topic = String(body.topic ?? "").trim().toLowerCase();
  if (topic && !TOPICS.includes(topic)) {
    errors.push(`"topic" must be one of: ${TOPICS.join(", ")}.`);
  } else {
    value.topic = topic || "education";
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Shapes a stored document into the EXACT shape the existing News.jsx cards
 * already expect, so a database item renders through the untouched markup.
 *
 * The wrapping of `title`, `imageAlt` and `body` into { en } and [ ... ] is the
 * important part: src/data/news.json stores localised copy that way, and the
 * page's `localized()` / `paragraphsOf()` helpers read that shape. An admin
 * writes one language, so it is stored once and exposed as English, which the
 * existing helpers fall back to exactly as they already do for the JSON items.
 *
 * @returns {object|null} null when the document is unusable.
 */
export function toPublicNews(document) {
  if (!document) return null;

  const required = ["title", "body", "date"];
  if (required.some((field) => typeof document[field] !== "string" || !document[field].trim())) {
    return null;
  }

  const title = document.title.trim();
  const body = document.body.trim();

  return {
    id: String(document._id),
    /* `dbId` marks this as database-backed, so News.jsx can tell the two
       sources apart without guessing. */
    source: "db",
    topic: document.topic || "education",
    date: document.date,
    image: document.image || null,
    imageAlt: document.imageAlt ? { en: document.imageAlt } : null,
    title: { en: title },
    /* One paragraph per blank line, so the admin can type the same structure the
       JSON file uses rather than being limited to a single block. */
    body: { en: splitParagraphs(body) },
  };
}

/**
 * Splits a block of text into paragraphs on blank lines.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}