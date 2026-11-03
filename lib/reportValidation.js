const CATEGORIES = new Set(["annual", "financial", "activity", "other"]);

export function validateReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid report details." };
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const reportDate = typeof body.reportDate === "string" ? body.reportDate.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const fileUrl = typeof body.fileUrl === "string" ? body.fileUrl.trim() : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";

  if (!title || title.length > 160) {
    return { ok: false, error: "Enter a report title of 1 to 160 characters." };
  }

  const normalizedCategory = category || "other";
  if (!CATEGORIES.has(normalizedCategory)) {
    return { ok: false, error: "Choose a valid report category." };
  }
  if (!isValidDate(reportDate)) {
    return { ok: false, error: "Choose a valid report date." };
  }
  if (description.length > 5000) {
    return { ok: false, error: "The description must be 5,000 characters or fewer." };
  }
  if (!isValidHttpUrl(fileUrl)) {
    return { ok: false, error: "Enter a valid HTTP or HTTPS report file link." };
  }
  if (fileUrl.length > 2048 || imageUrl.length > 2048) {
    return { ok: false, error: "Report links must be 2,048 characters or fewer." };
  }
  if (imageUrl && !isValidHttpUrl(imageUrl)) {
    return { ok: false, error: "Enter a valid HTTP or HTTPS cover image link." };
  }
  if (fileName.length > 255) {
    return { ok: false, error: "The report file name must be 255 characters or fewer." };
  }

  return {
    ok: true,
    value: {
      title,
      category: normalizedCategory,
      reportDate,
      description,
      reportFileUrl: fileUrl,
      reportFileName: fileName || title,
      reportFileType: "",
      reportImageUrl: imageUrl,
    },
  };
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function toPublicReport(document) {
  if (
    !document ||
    typeof document.title !== "string" ||
    typeof document.category !== "string" ||
    typeof document.reportDate !== "string" ||
    typeof document.reportFileUrl !== "string" ||
    !document.reportFileUrl
  ) {
    return null;
  }

  return {
    id: String(document._id),
    title: document.title,
    category: document.category,
    reportDate: document.reportDate,
    description: typeof document.description === "string" ? document.description : "",
    imageUrl: typeof document.reportImageUrl === "string" ? document.reportImageUrl : "",
    fileUrl: document.reportFileUrl,
    fileName: typeof document.reportFileName === "string" ? document.reportFileName : "report",
    fileType: typeof document.reportFileType === "string" ? document.reportFileType : "",
    createdAt: document.createdAt instanceof Date ? document.createdAt.toISOString() : null,
  };
}
