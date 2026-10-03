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

/**
 * The plain-text limit, 5000 characters, unchanged.
 *
 * `paragraph` is now written by the dashboard's rich-text editor, so its stored
 * value also carries the markup those words are wrapped in. Measuring the limit
 * against that markup would reject ordinary copy for no good reason — a 2000
 * character post in five paragraphs can easily exceed 5000 characters once the
 * tags are counted. The plain-text limit is therefore kept exactly as it was and
 * a separate, larger limit applies to the HTML, so the cap on how much a
 * visitor's browser is asked to render is still enforced, just at a size that
 * does not punish formatting.
 */
const MAX_FIELD_LENGTH = 5000;

/** 25,000 characters of HTML — room for roughly 20,000 characters of copy plus
 *  the tags around it. Generous for a social-feed paragraph, still bounded. */
const MAX_HTML_LENGTH = 25000;

/**
 * Removes markup that is not on a small allow list, so a `paragraph` can hold
 * the formatting the editor produces and nothing else.
 *
 * The allow list is deliberately small: only the tags the editor toolbar can
 * emit survive, event-handler attributes (onclick, onerror, onload, …) are
 * always dropped, `href` is kept only for http, https and mailto, and `style` is
 * reduced to a colour so it cannot smuggle in `url()` or `position:fixed`.
 *
 * It runs on the way IN, so dangerous markup never reaches the database; the
 * frontend sanitizes again on the way OUT before rendering.
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

    /* `paragraph` comes from the rich-text editor, so it is sanitized on the
       way in and measured against the larger HTML limit. Every other field is
       plain text and keeps the original 5000-character rule exactly as before. */
    const isParagraph = field === "paragraph";
    const cleaned = isParagraph && typeof raw === "string" && isRichText(raw)
      ? sanitizeRichHtml(raw)
      : raw;
    const limit = isParagraph && isRichText(raw) ? MAX_HTML_LENGTH : MAX_FIELD_LENGTH;

    if (typeof cleaned !== "string" || cleaned.trim().length === 0) {
      errors.push(`"${field}" is required and must be a non-empty string.`);
    } else if (cleaned.length > limit) {
      errors.push(`"${field}" is too long (max ${limit} characters).`);
    } else {
      value[field] = cleaned.trim();
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