import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import express from "express";
import cors from "cors";

/* The one shared limit for an uploaded image, so the body parser and the route
   that validates the upload can never disagree about how big a file may be. */
import { MAX_IMAGE_BYTES, uploadDirectory } from "../lib/imageUpload.js";

loadEnv({ path: ".env", override: false });
loadEnv({ path: ".env.local", override: true });

const app = express();
/* The local API server's port. 5000 is the documented value; it is read from
   the environment so it can be changed without editing code. It MUST stay in
   step with the dev proxy in vite.config.js, which forwards /api here. */
const port = Number(process.env.PORT || 5000);

/* ---------------------------------------------------------------------------
   CORS — explicit allow-list. This REPLACES the single `app.use(cors())` that
   was here before; there is only ever one CORS middleware in this file.

   The admin session is an httpOnly cookie, so the frontend sends
   `credentials: "include"`. The cors library's default sends
   `Access-Control-Allow-Origin: *`, and a browser REJECTS that combination
   outright:

     "The value of the 'Access-Control-Allow-Origin' header in the response must
      not be the wildcard '*' when the request's credentials mode is 'include'."

   With "*" no admin request can ever carry the session cookie, so login fails on
   every browser. The requesting origin must therefore be echoed back by name.

   ALLOWED_ORIGINS is a comma-separated list, so new deployments can be added as
   an environment variable instead of a code change. "*" is stripped from it if
   present, since a wildcard cannot legally be combined with credentials.

   LOCAL DEVELOPMENT FALLBACK
   ---------------------------
   With ALLOWED_ORIGINS unset the list falls back to the Vite dev origins, named
   and never "*", so local work keeps working out of the box.

   Requests with NO Origin header (curl, health checks, server-to-server) are not
   browser requests, so CORS does not apply to them and they pass through.
--------------------------------------------------------------------------- */
/* 5173 and 5175 are both in use locally: 5173 is the configured Vite port, and
   5175 is where the dev server lands when 5173 is already taken. Both are named
   here so a request from either is allowed without any environment variable. */
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
];

const allowedOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => v !== "*")
    .map((v) => v.replace(/\/+$/, ""))
);

if (allowedOrigins.size === 0) {
  for (const origin of DEFAULT_DEV_ORIGINS) {
    allowedOrigins.add(origin);
  }
  console.log(
    `[cors] ALLOWED_ORIGINS is not set — allowing the local dev origins only: ${[...allowedOrigins].join(", ")}`
  );
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      const normalizedOrigin = origin.replace(/\/+$/, "");

      if (allowedOrigins.has(normalizedOrigin)) {
        return callback(null, true);
      }

      console.error(`[cors] refused origin: ${origin}`);
      return callback(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  })
);

/* Serve the uploaded images. The files live in public/uploads, and nothing else
   on this server would hand them out, so without this every uploaded image 404s
   even with a correct absolute URL. Mounted before the /api dispatcher, and
   read-only: it serves files, it never accepts an upload. */
app.use(
  "/uploads",
  express.static(uploadDirectory(), {
    index: false,
    /* An uploaded file never changes, so it can be cached hard. */
    maxAge: "30d",
  })
);

/* Raw bytes for the image upload route, mounted BEFORE express.json.
   The dashboard sends the chosen File as the request body with an image/*
   Content-Type, so the JSON parser below would ignore it and req.body would
   arrive undefined. express.raw collects it as a Buffer instead.
   Scoped to that one path, and matched on image/* only, so no other route can
   be turned into a body-reading endpoint by a content type. The limit matches
   MAX_IMAGE_BYTES so an oversized file is refused here rather than buffered. */
app.use(
  "/api/admin/upload",
  express.raw({ type: "image/*", limit: MAX_IMAGE_BYTES })
);

app.use(express.json({ limit: "1mb" }));

/* ==========================================================================
   THE VERCEL FUNCTIONS, RUN LOCALLY
   ==========================================================================
   Everything under /api/ is a Vercel serverless function. In production Vercel
   builds and runs them itself. Locally nothing was executing them: this file
   only defined /api/health and /api/contact, so vite's proxy forwarded
   /api/admin/setup-status to a route that did not exist and the browser got a
   404 (or an opaque ECONNREFUSED 500 when this server was not running at all).

   The mount below imports those SAME files and calls their default export with
   the same (req, res) contract Vercel uses. It is not a re-implementation and
   not a mock: the real handler runs, against the real MongoDB, with the real
   env vars. If a route behaves differently here than on Vercel, that is a bug
   in the route, which is exactly what you want to find out locally.

   The only adaptations are the ones the Vercel runtime provides for free:
     - req.query, built from the path (Vercel does this for [id] segments)
     - res.status().json(), which Vercel's Node helpers add to the response
   ========================================================================== */

const apiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "api");

/**
 * The names of any dynamic segments in a directory: entries wrapped in square
 * brackets, e.g. "[id]". Sorted for a stable resolution order, and any error
 * reading the directory yields nothing rather than throwing, because a missing
 * directory simply means there is no dynamic route here.
 *
 * @returns {string[]}
 */
function bracketedNames(directory) {
  try {
    const found = new Set();

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      /* A dynamic route is a DIRECTORY named "[id]" or a FILE named "[id].js",
         so the ".js" is stripped before testing for the closing bracket —
         otherwise a file would never match and /api/posts/<id> would fall
         through to api/posts/index.js. */
      const name = entry.name.replace(/\.js$/, "");
      if (name.startsWith("[") && name.endsWith("]")) found.add(name);
    }

    /* Sorted so resolution order does not depend on the filesystem. */
    return [...found].sort();
  } catch {
    return [];
  }
}

/**
 * Finds the handler file for a request path, or null if no route matches.
 *
 * A Vercel function file can be named in four shapes, all of which are tried:
 *
 *   api/<path>.js          ->  /api/admin/setup-status
 *   api/<path>/index.js    ->  /api/posts
 *   api/<path>/[<param>].js->  /api/posts/<id>
 *   api/<path>/[<param>]/   ->  (directory form, plus index.js)
 *
 * The dynamic segment is DISCOVERED by looking for a name in brackets rather
 * than by inserting the value from the URL: the folder is literally called
 * "[id]", so the incoming value ("a1b2c3...") is the thing being matched, not
 * the name being looked up.
 */
async function loadHandler(urlPath) {
  const segments = urlPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const apiRoot = path.resolve(apiDir);

  /* Every possible match is collected first, then the MOST SPECIFIC one wins.
     Order matters: for /api/posts/<id> both api/posts/[id].js and
     api/posts/index.js exist, and the dynamic route must be chosen. Picking in
     a single shallow pass would reach api/posts/index.js first and answer every
     id-scoped request with the wrong handler. The ranking is:

       1. an exact file match       api/admin/setup-status.js
       2. a dynamic segment match   api/posts/[id].js
       3. a directory index         api/posts/index.js
  */
  const exact = [];
  const dynamic = [];
  const indexes = [];

  for (let depth = 1; depth <= segments.length; depth += 1) {
    const consumed = segments.slice(0, depth);

    exact.push(path.join(apiRoot, ...consumed) + ".js");
    indexes.push(path.join(apiRoot, ...consumed, "index.js"));

    /* The bracketed name is discovered by listing the directory, because the
       folder is called "[id]" whatever value the URL carries. */
    const parent = path.join(apiRoot, ...consumed.slice(0, -1));
    for (const name of bracketedNames(parent)) {
      dynamic.push(path.join(parent, `${name}.js`));
      dynamic.push(path.join(parent, name, "index.js"));
    }
  }

  /* Deepest first within each tier, so a longer literal beats a shorter one. */
  const ordered = [...exact.reverse(), ...dynamic.reverse(), ...indexes.reverse()];

  for (const candidate of ordered) {
    /* Every candidate is confined to api/ before it is touched, so a ".."
       segment in the URL cannot make this import an arbitrary file. */
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(apiRoot)) continue;
    if (!fs.existsSync(resolved)) continue;

    const module = await import(`file://${resolved.replace(/\\/g, "/")}`);
    if (typeof module.default === "function") return module.default;
  }

  /* Nothing matched this path. The caller answers 404. */
  return null;
}

/* Every /api/* path that no route below claims is served by the real function
   file. See the note at the top of this file for why. The registration itself
   is at the very bottom, after the local-only routes, so those keep priority. */
const serveVercelFunctions = async (req, res) => {
  /* req.url, not req.originalUrl: the /api mount prefix is already stripped
     from req.url, which is exactly the part api/ already accounts for. Using
     originalUrl here would look for api/api/... and match nothing. */
  const urlPath = req.url.split("?")[0];

  /* Vercel parses a JSON body for us and exposes it as req.body. */
  let body = req.body;
  if (typeof body === "string" && body.length) {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }

  /* Vercel exposes a dynamic segment as req.query.<paramName>, so /api/posts/<id>
     reaches api/posts/[id].js with req.query.id set to the value from the URL.
     The last path segment is that value whenever the resolved file is a
     dynamic one; for every other route there is no parameter to supply. */
  const query = { ...req.query };
  const segments = urlPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (segments.length && segments.at(-1) !== "index") query.id = segments.at(-1);

  let handler = null;
  try {
    handler = await loadHandler(urlPath);
  } catch (error) {
    /* Never surface the stack: it can contain absolute paths and env values. */
    console.error("[dev-api] could not load a handler for", urlPath, "-", error?.code ?? "load failed");
    return res.status(500).json({ ok: false, error: "Server error" });
  }

  if (!handler) {
    return res.status(404).json({ ok: false, error: "Not found" });
  }

  /* Vercel's Node helpers give the raw response these two methods. */
  if (typeof res.status !== "function") {
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
  }
  if (typeof res.json !== "function") {
    res.json = (payload) => {
      if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
      return res;
    };
  }

  try {
    /* `headers` IS passed on explicitly, and that is the whole point of this
       line. It is not redundant with the spread below.

       In Node (and therefore Express) `req.headers` is an ACCESSOR defined on
       the request prototype, not an own enumerable property of the instance.
       `{ ...req }` therefore copies only the own properties — method, url,
       socket, and so on — and silently DROPS `headers`. The auth gate in
       lib/requireAdmin.js reads the session cookie from `req.headers.cookie`,
       so without this the cookie never reaches the handler and EVERY protected
       endpoint answers 401: login appears to succeed, sets its cookie, and the
       dashboard's /api/admin/me is then told there is no session.

       Naming it in the literal is the smallest fix that makes the local request
       match what Vercel hands the same function, where req.headers is a real
       property and always present. */
    await handler({ ...req, headers: req.headers, body, query }, res);
  } catch (error) {
    /* The handlers already catch and log their own failures; this is the
       backstop for anything thrown outside their own try/catch. */
    console.error("[dev-api] unhandled error in", req.method, urlPath, "-", error?.name ?? "unknown");
    if (!res.headersSent) res.status(500).json({ ok: false, error: "Server error" });
  }
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const getEmailJsConfig = () => ({
  serviceId: process.env.VITE_EMAILJS_SERVICE_ID,
  templateId: process.env.VITE_EMAILJS_TEMPLATE_ID,
  publicKey: process.env.VITE_EMAILJS_PUBLIC_KEY,
  privateKey: process.env.EMAILJS_PRIVATE_KEY,
  recipientEmail: process.env.VITE_CONTACT_RECIPIENT_EMAIL,
});

const validateContactPayload = (payload) => {
  const errors = {};

  if (!payload.fullName?.trim()) {
    errors.fullName = "Full name is required.";
  }

  if (!payload.email?.trim()) {
    errors.email = "Email address is required.";
  } else if (!emailPattern.test(payload.email.trim())) {
    errors.email = "Enter a valid email address.";
  }

  if (!payload.subject?.trim()) {
    errors.subject = "Subject is required.";
  }

  if (!payload.message?.trim()) {
    errors.message = "Message is required.";
  } else if (payload.message.trim().length < 20) {
    errors.message = "Message should be at least 20 characters.";
  }

  return errors;
};

/* NOTE: there is deliberately no local /api/health route here.

   An earlier version of this file defined one, and because it was registered
   before the /api mount it SHADOWED the real function in api/health.js — the
   browser got a hard-coded { ok: true } that had nothing to do with the
   deployment's actual configuration. The /api mount below serves the real
   api/health.js instead, so what you see locally is what Vercel runs. */

app.post("/api/contact", async (request, response) => {
  const validationErrors = validateContactPayload(request.body || {});

  if (Object.keys(validationErrors).length > 0) {
    response.status(400).json({
      message: "Please complete the form correctly before sending.",
      errors: validationErrors,
    });
    return;
  }

  const emailJsConfig = getEmailJsConfig();
  if (
    !emailJsConfig.serviceId ||
    !emailJsConfig.templateId ||
    !emailJsConfig.publicKey ||
    !emailJsConfig.privateKey
  ) {
    response.status(500).json({
      message: "Email service is not fully configured yet. Add the EmailJS server key to your backend environment.",
    });
    return;
  }

  const trimmedFullName = request.body.fullName.trim();
  const trimmedEmail = request.body.email.trim();
  const trimmedSubject = request.body.subject.trim();
  const trimmedMessage = request.body.message.trim();
  const formattedMessage = [
    `Full Name: ${trimmedFullName}`,
    `Email Address: ${trimmedEmail}`,
    `Subject: ${trimmedSubject}`,
    "",
    "Message:",
    trimmedMessage,
  ].join("\n");

  const recipientList = (emailJsConfig.recipientEmail || "samuelasongoinfoo@gmail.com")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  try {
    await Promise.all(
      recipientList.map(async (recipientEmail) => {
        const emailJsResponse = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            service_id: emailJsConfig.serviceId,
            template_id: emailJsConfig.templateId,
            user_id: emailJsConfig.publicKey,
            accessToken: emailJsConfig.privateKey,
            template_params: {
              from_name: trimmedFullName,
              from_email: trimmedEmail,
              subject: trimmedSubject,
              message: trimmedMessage,
              reply_to: trimmedEmail,
              to_email: recipientEmail,
              cc_email: "",
              recipient_list: recipientEmail,
              name: trimmedFullName,
              email: trimmedEmail,
              user_name: trimmedFullName,
              user_email: trimmedEmail,
              title: trimmedSubject,
              contact_subject: trimmedSubject,
              contact_message: trimmedMessage,
              email_body: formattedMessage,
              formatted_message: formattedMessage,
            },
          }),
        });

        if (!emailJsResponse.ok) {
          const errorText = (await emailJsResponse.text()).trim();
          throw new Error(errorText || "EmailJS request failed.");
        }
      })
    );

    response.status(200).json({
      message: "Message sent successfully. We will get back to you soon.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown email delivery error.";

    response.status(502).json({
      message: `Your message could not be sent right now. Please check your EmailJS template fields and try again. (${errorMessage})`,
    });
  }
});

/* Registered last so the local-only routes above keep priority; anything still
   unmatched under /api is handed to the real Vercel function file. */
app.use("/api", serveVercelFunctions);

app.listen(port, () => {
  console.log(`AUVD contact server listening on http://localhost:${port}`);
  console.log(`Vercel functions under /api served locally (same files Vercel runs)`);
});