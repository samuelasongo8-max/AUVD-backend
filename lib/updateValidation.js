const CATEGORIES = new Set(["Community", "Stories", "News", "Events", "Programs"]);

export function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

export function validateUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["A JSON body is required."] };
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.body === "string" ? body.body.trim() : "";
  const suppliedExcerpt = typeof body.excerpt === "string" ? body.excerpt.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  const author = typeof body.author === "string" ? body.author.trim() : "";
  const errors = [];

  if (!title) errors.push("Title is required.");
  else if (title.length > 200) errors.push("Title must be 200 characters or fewer.");
  if (!content) errors.push("Body content is required.");
  else if (content.length > 50000) errors.push("Body content must be 50,000 characters or fewer.");

  const normalizedCategory = category || "Community";
  if (!CATEGORIES.has(normalizedCategory)) {
    errors.push("Choose a valid community update category.");
  }

  if (suppliedExcerpt.length > 500) {
    errors.push("The excerpt must be 500 characters or fewer.");
  }

  if (imageUrl.length > 2048 || (imageUrl && !isHttpUrl(imageUrl))) {
    errors.push("Enter a valid HTTP or HTTPS image link of 2,048 characters or fewer.");
  }

  if (author.length > 120) {
    errors.push("Author must be 120 characters or fewer.");
  }

  if (errors.length) return { ok: false, errors };

  const excerpt = suppliedExcerpt || (
    content.length > 160 ? `${content.slice(0, 160).trimEnd()}...` : content
  );

  return {
    ok: true,
    value: {
      title,
      body: content,
      excerpt,
      category: normalizedCategory,
      imageUrl,
      author: author || "Admin",
    },
  };
}

export function toPublicUpdate(document) {
  if (
    !document ||
    typeof document.title !== "string" ||
    typeof document.slug !== "string" ||
    typeof document.body !== "string"
  ) {
    return null;
  }

  const createdAt = toIsoString(document.createdAt);
  return {
    id: String(document._id),
    title: document.title,
    slug: document.slug,
    body: document.body,
    excerpt: typeof document.excerpt === "string" ? document.excerpt : "",
    category: typeof document.category === "string" ? document.category : "Community",
    imageUrl: typeof document.imageUrl === "string" ? document.imageUrl : "",
    author: typeof document.author === "string" ? document.author : "Admin",
    date: createdAt ? createdAt.slice(0, 10) : "",
    createdAt,
    updatedAt: toIsoString(document.updatedAt),
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function toIsoString(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}
