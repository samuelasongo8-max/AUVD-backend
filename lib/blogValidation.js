/**
 * lib/blogValidation.js — the ONE definition of a valid blog article.
 *
 * WHY A SEPARATE MODULE, ALONGSIDE postValidation.js AND newsValidation.js
 * -----------------------------------------------------------------------
 * A blog is a third kind of content with its own fields, so it gets its own
 * rules — but it is validated the same WAY, by one module, so the create route,
 * the update route and the admin form can never drift apart. This is written to
 * mirror lib/newsValidation.js deliberately.
 *
 * BLOGS ARE COMPLETELY SEPARATE FROM POSTS AND NEWS
 * -------------------------------------------------
 * They live in their own "blogs" collection. Nothing here reads, writes or
 * validates the posts or news collections, so no blog can affect an existing
 * post, an existing news item or GET /api/posts.
 *
 * THE FIELD SHAPES ARE THE ADMIN'S OWN
 * ------------------------------------
 * Unlike news, nothing public renders a blog yet, so this deliberately does NOT
 * wrap the copy into the { en } / paragraph-array shapes. It is stored and
 * returned as plain strings, which is what the admin form actually typed.
 */

/** The fields the admin must supply. `image` is optional: a blog can legally
 *  have no picture. */
/** The fields the admin must supply that share the SHORT generic limit.
 *  `content` is deliberately NOT in this list: an article is allowed to be far
 *  longer than a title, so it is required and length-checked separately below. */
const REQUIRED_FIELDS = ["title", "date"];

/** Rejects 2026-02-31 and friends, which Date would silently roll over. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_TITLE = 200;
const MAX_IMAGE_ALT = 500;

/** Generous, because this is a full article rather than a caption: 20,000
 *  characters is comfortably longer than any blog post and still small enough
 *  to render comfortably in the dashboard list. */
const MAX_CONTENT = 20000;

const MAX_FIELD_LENGTH = 5000;

const isValidDate = (value) => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
};

/**
 * Validates a submitted blog and returns a clean, trimmed copy.
 *
 * Only the known fields are read, so a client cannot smuggle `_id` or
 * `createdAt` into the document.
 *
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateBlog(body) {
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

  /* The article itself. Checked separately from the loop above because it is
     allowed to be far longer than every other field. */
  const content = String(body.content ?? "").trim();
  if (!content) {
    errors.push('"content" is required and must be a non-empty string.');
  } else if (content.length > MAX_CONTENT) {
    errors.push(`"content" is too long (max ${MAX_CONTENT} characters).`);
  } else {
    value.content = content;
  }

  if (value.date && !isValidDate(value.date)) {
    errors.push('"date" must be a real date in YYYY-MM-DD form, e.g. 2026-08-15.');
    delete value.date;
  }

  /* Optional: a blog may have no image at all. */
  const image = typeof body.image === "string" ? body.image.trim() : "";
  value.image = image || null;

  const imageAlt = typeof body.imageAlt === "string" ? body.imageAlt.trim() : "";
  if (imageAlt.length > MAX_IMAGE_ALT) {
    errors.push(`"imageAlt" is too long (max ${MAX_IMAGE_ALT} characters).`);
    delete value.imageAlt;
  } else {
    value.imageAlt = imageAlt || null;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Shapes a stored document into the plain shape the admin dashboard reads:
 * an id plus the trimmed strings it typed.
 *
 * @returns {object|null} null when the document is unusable, so one bad record
 *   can never take the whole list down.
 */
export function toPublicBlog(document) {
  if (!document) return null;

  const required = ["title", "content", "date"];
  if (required.some((field) => typeof document[field] !== "string" || !document[field].trim())) {
    return null;
  }

  return {
    id: String(document._id),
    title: document.title.trim(),
    content: document.content.trim(),
    date: document.date,
    image: document.image || null,
    imageAlt: document.imageAlt || null,
  };
}
