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

/**
 * Removes markup that is not on a small allow list, so a blog's `content` can
 * hold the formatting the rich-text editor produces and nothing else.
 *
 * The allow list is deliberately small: only the tags the editor toolbar can
 * emit survive, event-handler attributes (onclick, onerror, onload, …) are
 * always dropped, `href` is kept only for http, https and mailto, and `style` is
 * reduced to a colour so it cannot smuggle in `url()` or `position:fixed`.
 *
 * It runs on the way IN, so dangerous markup never reaches the database; the
 * frontend sanitizes again on the way OUT before rendering. Plain-text articles
 * pass through completely unchanged.
 *
 * @param {string} html
 * @returns {string} safe HTML, or "" when the input was not a string.
 */
export function sanitizeRichHtml(html) {
  if (typeof html !== "string" || !html) return "";

  const ALLOWED_TAGS = new Set([
    "p", "br", "b", "strong", "i", "em", "u", "s",
    "ul", "ol", "li",
    "a", "span", "div",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "code",
  ]);

  /* Removed together with their contents, so no code or style survives as text. */
  const DROP_WITH_CONTENT = new Set([
    "script", "style", "iframe", "object", "embed", "noscript",
    "template", "form", "input", "button", "textarea", "select", "option",
  ]);

  const SAFE_URL = /^(https?:\/\/|mailto:)/i;

  /* `&` is escaped only when it is not already the start of an entity, so
     markup the editor already escaped (`&amp;`) is not double-escaped. */
  const escapeText = (text) =>
    text
      .replace(/&(?![a-zA-Z#0-9]+;)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const sanitizeAttributes = (tagName, attributeText) => {
    const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let out = "";
    let match;

    while ((match = pattern.exec(attributeText)) !== null) {
      const name = match[1].toLowerCase();
      const value = match[3] ?? match[4] ?? match[5] ?? "";

      if (name.startsWith("on")) continue;

      if (name === "href" && tagName === "a") {
        const trimmed = value.trim();
        if (!SAFE_URL.test(trimmed)) continue;
        out += ` href="${escapeText(trimmed)}" target="_blank" rel="noopener noreferrer nofollow"`;
        continue;
      }

      /* Only the colour properties the editor can set. */
      if (name === "style") {
        const safe = [];
        for (const property of value.split(";")) {
          const parts = property.split(":");
          if (parts.length < 2) continue;
          const cssName = parts[0].trim().toLowerCase();
          const cssValue = parts.slice(1).join(":").trim();
          if (cssName !== "color" && cssName !== "background-color") continue;
          if (!/^[#a-z0-9(),.\s%-]+$/i.test(cssValue)) continue;
          safe.push(`${cssName}:${cssValue}`);
        }
        if (safe.length) out += ` style="${escapeText(safe.join(";"))}"`;
        continue;
      }

      /* Quill marks font and size choices with class names such as
         ql-size-large or ql-font-monospace. */
      if (name === "class" && /(^|\s)ql-[a-z0-9-]+(\s|$)/i.test(value)) {
        out += ` class="${escapeText(value)}"`;
      }
    }

    return out;
  };

  let output = html;
  for (const tag of DROP_WITH_CONTENT) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    output = output.replace(paired, "").replace(selfClosing, "");
  }

  let result = "";
  let cursor = 0;
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let match;

  while ((match = tagPattern.exec(output)) !== null) {
    result += escapeText(output.slice(cursor, match.index));

    const closing = match[1] === "/";
    const tagName = match[2].toLowerCase();

    if (ALLOWED_TAGS.has(tagName)) {
      result += closing
        ? `</${tagName}>`
        : `<${tagName}${sanitizeAttributes(tagName, match[3] ?? "")}>`;
    }

    cursor = tagPattern.lastIndex;
  }

  result += escapeText(output.slice(cursor));

  return result.trim();
}

/**
 * True when the value carries ANY markup, not just the editor's own tags.
 *
 * A payload such as a bare `<script>alert(1)</script>` contains none of the
 * editor's tag names, and treating that as plain text would let it skip
 * sanitization and be stored verbatim. Any `<` followed by a letter or a slash
 * counts as markup, so the sanitizer always runs before anything is stored.
 */
const isRichText = (value) => typeof value === "string" && /<[a-zA-Z/!]/.test(value);

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
     allowed to be far longer than every other field. A rich-text article is
     sanitized here, on the way in, so dangerous markup is never stored; a
     plain-text article is passed through untouched. */
  const rawContent = String(body.content ?? "").trim();
  const content = isRichText(rawContent) ? sanitizeRichHtml(rawContent) : rawContent;

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

  /* The SECOND image, shown inside the article body rather than as the hero.
     Optional in exactly the same way as `image`, and kept deliberately
     separate from it so the hero picture is never replaced by this one. */
  const contentImage = typeof body.contentImage === "string" ? body.contentImage.trim() : "";
  value.contentImage = contentImage || null;

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
    /* Absent on every blog saved before this field existed: toPublicBlog
       normalises that to null so the public page can test it safely. */
    contentImage: document.contentImage || null,
  };
}
