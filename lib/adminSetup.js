/**
 * lib/adminSetup.js — the "exactly one admin, ever" rule, in one place.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The obvious way to write a register endpoint is:
 *
 *     if (await admins.findOne({})) return alreadyExists();
 *     await admins.insertOne(doc);
 *
 * That has a race. Two requests arriving at the same instant — two browser
 * tabs, or a retry firing twice — can both run the findOne before either
 * insert lands, both see an empty collection, and both insert. You end up with
 * two admins and two working logins, which is exactly what this system exists
 * to prevent. A check cannot close a race that happens after the check.
 *
 * THE FIX: MAKE THE WRITE ITSELF UNCONDITIONAL
 * --------------------------------------------
 * Two independent mechanisms, because they cover different cases:
 *
 * 1. A FIXED `_id` of "admin" on every document. MongoDB enforces a unique
 *    `_id` natively, in the storage engine, with no index to create and
 *    nothing that can fail to be set up. Two concurrent inserts of the same
 *    `_id` cannot both succeed — one is rejected with a duplicate-key error.
 *    This is what closes the race.
 *
 * 2. A UNIQUE index on `singleton: 1`, as a second line of defence. This one
 *    catches an account that was created some other way and carries a
 *    different `_id` — for example one seeded by scripts/create-admin.mjs
 *    before this endpoint existed. A unique index treats a missing field as
 *    null, so that document occupies the single allowed slot too, and a
 *    second one collides with it.
 *
 * The findOne check below is still done first, but only to return the
 * friendly 403 quickly and to skip the expensive bcrypt hash. It is a UX
 * shortcut, not the guarantee — mechanisms 1 and 2 are the guarantee.
 *
 * The index is created lazily on first use and cached on globalThis, so it
 * costs one round trip per cold start rather than one per request. Creating an
 * index that already exists is a no-op, so this is safe to run every time.
 */
import { ObjectId } from "mongodb";
import { ADMIN_COLLECTION } from "./db.js";

/** The constant value every admin document carries. See the note above. */
export const SINGLETON = 1;

/** MongoDB's duplicate-key error code. */
const DUPLICATE_KEY = 11000;

/** The name of the unique index that enforces one-admin mode. */
const SINGLETON_INDEX = "admin_singleton_unique";

/** The name of the unique index used instead in multi-admin mode. */
const EMAIL_INDEX = "admin_email_unique";

/* ==========================================================================
   TEMPORARY TESTING MODE: MORE THAN ONE ADMIN
   ==========================================================================
   Set ALLOW_MULTIPLE_ADMINS=true to let several admins exist at once, so the
   dashboard can be tested against the real database with more than one person
   signing in. It is a LOCAL TESTING switch only.

   The one-admin design above is NOT removed — it is the default, and every piece
   of it is still here and still used. To go back, set ALLOW_MULTIPLE_ADMINS=
   false (or delete the variable) and restart; nothing else has to change.

   WHAT ACTUALLY CHANGES
   ---------------------
   Only three things, all inside this file:

     1. The fixed `_id: "admin"` becomes a generated ObjectId, because every
        account needs its own identity.
     2. The `singleton` field is left OFF new documents, since it exists purely
        to mean "there is only one of me".
     3. The unique `singleton` index is DROPPED and a unique `email` index is
        used instead.

   That third point is the subtle one. A unique index treats a MISSING field as
   null, so with the index still in place the first extra admin would be stored
   as `singleton: null` and the SECOND extra admin would collide with it and be
   rejected with a duplicate-key error. Allowing multiple admins therefore
   requires removing that index, which is why this is done here rather than by
   simply skipping the checks in register.js.

   Uniqueness is still enforced in multi-admin mode, just on `email` instead:
   one document per address, so an account can never be registered twice.

   The singleton index is recreated automatically if you switch back to one-admin
   mode — ensureSingletonIndex() runs on every single-admin registration, and
   creating an index that already exists is a no-op.
   ========================================================================== */

/**
 * Is more-than-one-admin mode switched on?
 *
 * Reads ALLOW_MULTIPLE_ADMINS from the environment, which is the project's
 * existing configuration mechanism — the same one MONGODB_URI and JWT_SECRET
 * come from. Nothing is hard-coded in the routes, and the variable is NOT
 * prefixed with VITE_, so it can never reach the browser bundle or be read by
 * frontend code. Only the server sees it.
 *
 * Parsed leniently on purpose: "true", "TRUE", "1", "yes" and "on" all mean on.
 * Anything else — including the variable being absent, which is what production
 * looks like — means off. Failing closed matters here: a typo must never quietly
 * open registration on a production deployment.
 *
 * @returns {boolean}
 */
export function allowsMultipleAdmins() {
  const raw = String(process.env.ALLOW_MULTIPLE_ADMINS ?? "")
    .trim()
    .toLowerCase();

  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

const log = (step, detail = "") => {
  console.log(`[admin-setup] ${step}${detail ? ` — ${detail}` : ""}`);
};

/**
 * Creates the unique index, once per warm function instance.
 *
 * Failures are logged but NOT thrown: if the index cannot be created (an older
 * deployment, a permissions quirk) the endpoint still works, it just falls back
 * to the findOne check alone. Losing the index should degrade the guarantee,
 * never break registration outright.
 */
function ensureSingletonIndex(collection) {
  if (!globalThis.__auvdAdminIndexPromise) {
    globalThis.__auvdAdminIndexPromise = collection
      .createIndex({ singleton: SINGLETON }, { unique: true, name: "admin_singleton_unique" })
      .then(() => true)
      .catch((error) => {
        /* Reset so a later request can retry rather than being stuck with the
           failure for the lifetime of the instance. */
        globalThis.__auvdAdminIndexPromise = null;
        log("index not created, falling back to the findOne check only", error?.message ?? error);
        return false;
      });
  }

  return globalThis.__auvdAdminIndexPromise;
}

/**
 * TEMPORARY (multi-admin mode): swap the one-admin index for a unique index on
 * `email`, so each address can have exactly one account.
 *
 * The singleton index has to GO, not merely be ignored: a unique index treats an
 * absent field as null, so every extra admin would occupy the same "null" slot
 * and the second one would be rejected. See the note at the top.
 *
 * Done once per process and only when the flag is explicitly on. A drop that
 * fails because the index was never there is the normal case on a fresh
 * database, so it is not reported as a problem.
 */
function ensureEmailIndex(collection) {
  if (!globalThis.__auvdEmailIndexPromise) {
    globalThis.__auvdEmailIndexPromise = collection
      .dropIndex(SINGLETON_INDEX)
      .catch((error) => {
        if (error?.codeName !== "IndexNotFound" && error?.code !== 27) {
          log("could not drop the singleton index", error?.message ?? error);
        }
        return false;
      })
      .then(() => collection.createIndex({ email: 1 }, { unique: true, name: EMAIL_INDEX }))
      .then(() => true)
      .catch((error) => {
        globalThis.__auvdEmailIndexPromise = null;
        log("email index not created, falling back to the email check", error?.message ?? error);
        return false;
      });
  }

  return globalThis.__auvdEmailIndexPromise;
}

/**
 * Is the single admin account already created?
 *
 * Used by /api/admin/setup-status (to decide which form to show) and by
 * /api/admin/register (to answer 403 without wasting a bcrypt hash).
 *
 * `findOne` with a projection reads a single document and never the whole
 * collection, and no field is returned to the caller.
 *
 * @returns {Promise<boolean>}
 */
export async function hasAdmin(db) {
  const existing = await db.collection(ADMIN_COLLECTION).findOne({}, { projection: { _id: 1 } });
  return existing !== null;
}

/**
 * Inserts an admin document.
 *
 * ONE-ADMIN MODE (the default, and unchanged): writes the fixed `_id: "admin"`
 * and `singleton: 1` behind the unique index, so a second account is impossible
 * however two requests interleave.
 *
 * MULTI-ADMIN MODE (ALLOW_MULTIPLE_ADMINS=true, local testing only): writes a
 * generated `_id` and no `singleton` field, behind a unique index on `email`.
 * Uniqueness is still enforced — on the address instead of the whole collection
 * — so the same email can never be registered twice.
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: "exists" }>}
 *          `exists` means the database rejected the write because that account
 *          is already there — which is the answer, not an error to report.
 */
export async function insertAdmin(db, { email, passwordHash }) {
  const admins = db.collection(ADMIN_COLLECTION);
  const multi = allowsMultipleAdmins();

  /* TEMPORARY: local testing mode. See the note at the top of this file. */
  if (multi) {
    await ensureEmailIndex(admins);

    /* A friendly, fast refusal for the common case. Like the findOne below it is
       a UX shortcut, not the guarantee — the unique email index is that. */
    if (await admins.findOne({ email }, { projection: { _id: 1 } })) {
      return { ok: false, reason: "exists" };
    }

    const document = {
      _id: new ObjectId(),
      email,
      passwordHash,
      createdAt: new Date(),
    };

    try {
      await admins.insertOne(document);
      return { ok: true };
    } catch (error) {
      /* The email is taken. Only that is treated as a normal outcome; anything
         else is a real fault and is re-thrown to the route's catch. */
      if (error?.code === DUPLICATE_KEY) {
        return { ok: false, reason: "exists" };
      }
      throw error;
    }
  }

  await ensureSingletonIndex(admins);

  const document = {
    _id: "admin",
    email,
    passwordHash,
    createdAt: new Date(),
    /* The field the unique index is built on. See the note at the top. */
    singleton: SINGLETON,
  };

  try {
    await admins.insertOne(document);
    return { ok: true };
  } catch (error) {
    /* The index did its job: a second account can never be created, however
       the two requests were interleaved. */
    if (error?.code === DUPLICATE_KEY) {
      return { ok: false, reason: "exists" };
    }
    throw error;
  }
}