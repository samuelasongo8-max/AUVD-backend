/**
 * lib/db.js — the one place that talks to MongoDB.
 *
 * WHY THIS EXISTS AS A SEPARATE FILE
 * ----------------------------------
 * A Vercel serverless function is not a long-running server: every request can
 * land on a fresh, short-lived Node process that is thrown away afterwards. If
 * each function opened its own MongoClient per request, each cold start would
 * open a fresh set of database connections, and a busy site would exhaust the
 * connection limit on the cluster.
 *
 * So the client is cached on `globalThis`. `globalThis` survives between
 * invocations *within the same warm function instance*, which is exactly the
 * lifetime we can control. A cold start still creates one client, and a warm
 * instance reuses it. This is the standard pattern for the official MongoDB
 * Node driver on serverless platforms.
 *
 * SECURITY
 * --------
 * Nothing in this file ever logs the connection string, and `safeMessage()`
 * (used by every API route) strips anything URI-shaped out of an error before
 * it reaches a log, because MongoDB parse/selection errors can otherwise echo
 * the host, and a bad URI can carry the username and password.
 */

/* Collections. Two live in the app, and a third supports the login rate limit. */
export const ADMIN_COLLECTION = "admin";
export const POSTS_COLLECTION = "posts";
export const NEWS_COLLECTION = "news";
export const BLOGS_COLLECTION = "blogs";
export const LOGIN_ATTEMPTS_COLLECTION = "login_attempts";

/* The database this application owns. It is named here rather than being left
   to the connection string's path component, so every call targets the same
   database explicitly even if the URI is ever changed to omit it. */
export const DB_NAME = "kakuma-community-connect";

/* Keep the driver's own message free of the URI. A MongoParseError quotes the
   connection string back at you, credentials and all, so it is scrubbed before
   it is ever returned to a caller that might log it. */
export function safeMessage(error) {
  const raw = typeof error?.message === "string" ? error.message : String(error ?? "unknown error");

  /* A host is the one part of the URI that can also turn up in an error that
     does NOT quote the whole string — "querySrv ENOTFOUND _mongodb._tcp.<host>"
     names the cluster directly, with no scheme in front of it for the pattern
     below to catch. The host is pulled out of the configured URI (it is never
     printed) and redacted on its own, so a driver message that names only the
     host still cannot disclose it. */
  const host = configuredHost();

  return redactUri(raw, host).slice(0, 300);
}

/** Matches mongodb:// and mongodb+srv:// up to the first whitespace, so the
    userinfo (username:password) and host are removed together. */
function redactUri(text, host) {
  let out = text.replace(/mongodb(\+srv)?:\/\/\S+/gi, "[mongodb uri redacted]");

  if (host) {
    /* Both the bare host and the SRV form the driver embeds in DNS errors. */
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`_mongodb\\._tcp\\.${escaped}`, "gi"), "[mongodb host redacted]");
    out = out.replace(new RegExp(escaped, "gi"), "[mongodb host redacted]");
  }

  return out;
}

/**
 * The host portion of the configured connection string, or "" when there is
 * none. Parsed from the URI text and never returned, logged or included in any
 * error, so it can only ever be used to REMOVE the host from a message.
 *
 * @returns {string}
 */
function configuredHost() {
  const uri = String(process.env.MONGODB_URI ?? "").trim();
  if (!uri) return "";

  /* Strip the scheme, then drop the userinfo, then drop anything after the
     host:port. What remains is the host this deployment talks to. */
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//i, "");
  const afterUserinfo = afterScheme.includes("@") ? afterScheme.slice(afterScheme.lastIndexOf("@") + 1) : afterScheme;
  const host = afterUserinfo.split("/")[0].split("?")[0];

  /* Drop the :port, and unwrap a bracketed IPv6 literal. */
  return host.replace(/^\[/, "").replace(/\]$/, "").split(":")[0];
}

/**
 * Opens a brand-new client. Used by the one-time local scripts, which want to
 * connect, do a single thing, and then close cleanly.
 *
 * @returns {Promise<{ client: import("mongodb").MongoClient, db: import("mongodb").Db }>}
 */
export async function connectOnce() {
  const uri = process.env.MONGODB_URI;
  if (!uri || !uri.trim()) {
    throw new Error("MONGODB_URI is not set. Add it to .env.local (see .env.local.example).");
  }

  /* Imported lazily so a missing/broken env var produces our own clear message
     rather than a driver error while the module is still loading. */
  const { MongoClient } = await import("mongodb");

  const client = new MongoClient(uri, {
    /* Bounded so a request can never hang past Vercel's function limit. */
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    socketTimeoutMS: 10000,
  });

  await client.connect();
  return { client, db: client.db(DB_NAME) };
}

/**
 * The shared, cached database handle for serverless functions.
 *
 * The promise itself is cached (not the resolved value) so that two requests
 * landing at the same instant on a cold instance share ONE connect attempt
 * instead of racing to open two pools.
 *
 * @returns {Promise<import("mongodb").Db>}
 */
export function getDb() {
  if (!globalThis.__auvdMongoDbPromise) {
    globalThis.__auvdMongoDbPromise = (async () => {
      const uri = process.env.MONGODB_URI;
      if (!uri || !uri.trim()) {
        throw new Error("MONGODB_URI is not set. Add it in Vercel for Production, then redeploy.");
      }

      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        socketTimeoutMS: 10000,
      });
      await client.connect();
      return client.db(DB_NAME);
    })();

    /* A failed connect must not be cached forever: clear the slot so the next
       request can try again instead of replaying the same rejection. The
       `.catch` is attached to a SEPARATE branch, so the cached promise still
       rejects to the caller who is awaiting it. */
    globalThis.__auvdMongoDbPromise.catch(() => {
      globalThis.__auvdMongoDbPromise = null;
    });
  }

  return globalThis.__auvdMongoDbPromise;
}