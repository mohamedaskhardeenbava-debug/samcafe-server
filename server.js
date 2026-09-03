//Testing Branch MongoDB - v2
require("dotenv").config();
const dns = require("dns");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const {
  router: authRouter,
  todoRouter,
  requireAuth: requireAdminAuth,
  requireRole: requireAdminRole,
  requireMinRank: requireAdminMinRank,
  requireCanManageStaff: requireAdminCanManageStaff,
  Admin,
  ensureAdminsHaveStaffRecords,
} = require("./auth");
const venuesModule = require("./venues");
const permissionsModule = require("./permissions");
const rolesModule = require("./roles");
const workPlanModule = require("./workPlan");
const auditLogModule = require("./auditLog");
const documentsModule = require("./documents");
const paymentsModule = require("./payments");
const bankAccountModule = require("./bankAccount");
const chatModule = require("./chat");
const { logAudit } = auditLogModule;
const { hasPermission } = permissionsModule;

dns.setServers(["8.8.8.8", "1.1.1.1"]);

/* ─────────────────────────────────────────
   APP + SOCKET SETUP
───────────────────────────────────────── */
const app = express();

// Render (and most PaaS hosts) terminate TLS at a reverse proxy in front
// of this app, so Express sees plain HTTP internally. Without trusting
// that proxy, Express can't correctly determine the request was actually
// HTTPS, which breaks `secure: true` cookies (they get silently dropped
// instead of set) — the exact cause of every route 401ing in production
// while working fine on localhost. Must be set before any cookies are
// issued.
app.set("trust proxy", 1);

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
  // Allow the default polling->websocket upgrade path instead of forcing
  // websocket-only. A pure-WS connection has no fallback, so any brief
  // network blip (flaky cafe wifi/router) kills it outright instead of
  // degrading gracefully — that was causing the frequent connect/
  // disconnect cycles for the printer bridge seen in the logs.
});

// CORS must reflect the actual request origin (not "*") and set
// Allow-Credentials so the browser will send/accept the httpOnly session
// cookie across the Vercel (frontend) <-> Render (backend) origin split.
// ALLOWED_ORIGINS in .env: comma-separated list, e.g.
//   ALLOWED_ORIGINS=https://samcafe-admin.vercel.app,https://samcafe.vercel.app,http://localhost:3000
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Cashfree webhook signature verification needs the exact raw request
// bytes it signed — must be parsed as a raw Buffer BEFORE the global
// express.json() below (which would otherwise consume/parse the body
// first and make HMAC verification impossible). Every other route keeps
// the normal JSON parsing.
app.use("/payments/webhook", express.raw({ type: "*/*", limit: "1mb" }));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ─────────────────────────────────────────
   MONGOOSE — GENERIC SCHEMA
───────────────────────────────────────── */
const anySchema = new mongoose.Schema(
  {},
  { strict: false, timestamps: false, versionKey: false, id: false }
);

const modelCache = {};
function getModel(collectionName) {
  if (modelCache[collectionName]) return modelCache[collectionName];
  const model = mongoose.model(collectionName, anySchema, collectionName);
  modelCache[collectionName] = model;
  // Every collection is queried by venueId on nearly every request (venue
  // scoping) and by the app-level `id` field on every single-doc lookup —
  // without these, Mongo falls back to a full collection scan on each call.
  // createIndex() is a no-op if the index already exists, so this is safe
  // to run on every boot; it runs in the background and doesn't block
  // reads/writes against the collection while building.
  model.collection.createIndex({ venueId: 1 }).catch(() => { });
  model.collection.createIndex({ id: 1 }).catch(() => { });
  if (collectionName === "orders") {
    // Orders is the largest collection by far and is always read as one
    // big list per venue, most-recent-first — a compound index lets Mongo
    // satisfy that access pattern directly instead of scanning + sorting
    // in memory.
    model.collection.createIndex({ venueId: 1, createdAt: -1 }).catch(() => { });
  }
  return model;
}

/* ─────────────────────────────────────────
   CUSTOMER SESSIONS (user panel)

   Mirrors the admin-panel session pattern in auth.js (httpOnly cookie +
   server-side session doc, TTL-cleaned) but as its own collection/cookie
   so a customer session and a staff session can coexist in the same
   browser without clashing. Previously the user panel only stored a raw
   userId in localStorage with no server-side session at all — anyone
   could set that value to any user's id and "become" them, and a reload
   only worked as long as GET /users/:id happened to succeed.
───────────────────────────────────────── */
const customerSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);
customerSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const CustomerSession = mongoose.model("CustomerSession", customerSessionSchema, "customerSessions");

const CUSTOMER_SESSION_COOKIE = "samcafe_uid";
const CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — customers expect to stay logged in

function customerCookieOpts() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: CUSTOMER_SESSION_TTL_MS,
    path: "/",
  };
}

async function createCustomerSession(userId, req, res) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  await CustomerSession.create({
    sessionId,
    userId,
    userAgent: req.headers["user-agent"] || "",
    ip: req.ip,
    expiresAt: new Date(Date.now() + CUSTOMER_SESSION_TTL_MS),
  });
  res.cookie(CUSTOMER_SESSION_COOKIE, sessionId, customerCookieOpts());
  return sessionId;
}

/**
 * requireCustomerAuth — validates the samcafe_uid cookie against
 * customerSessions, attaches req.customerUserId. Used by /auth/me and
 * /auth/logout; the rest of the /users/* CRUD routes stay open for now
 * (unchanged from prior behavior) so this is additive, not a breaking
 * lockdown of existing user-panel calls.
 */
async function requireCustomerAuth(req, res, next) {
  try {
    const sessionId = req.cookies ? req.cookies[CUSTOMER_SESSION_COOKIE] : null;
    if (!sessionId) return res.status(401).json({ error: "Not logged in" });

    const session = await CustomerSession.findOne({ sessionId }).lean();
    if (!session || session.expiresAt < new Date()) {
      res.clearCookie(CUSTOMER_SESSION_COOKIE, customerCookieOpts());
      return res.status(401).json({ error: "Session expired" });
    }

    // Sliding expiry, same pattern as admin sessions.
    CustomerSession.updateOne(
      { sessionId },
      { $set: { lastActive: new Date(), expiresAt: new Date(Date.now() + CUSTOMER_SESSION_TTL_MS) } }
    ).catch(() => { });

    req.customerSessionId = sessionId;
    req.customerUserId = session.userId;
    next();
  } catch (err) {
    console.error("requireCustomerAuth error:", err.message);
    res.status(500).json({ error: "Auth check failed" });
  }
}

/* ─────────────────────────────────────────
   COLLECTION REGISTRY

   ARRAY collections   → normal REST CRUD
                          GET /col           list all
                          GET /col/:id       single doc by app "id" field
                          POST /col          create
                          PUT /col/:id       full replace
                          PATCH /col/:id     partial update
                          DELETE /col/:id    remove

   SINGLETON collections → one document per collection, stored with id="singleton"
                          GET /col           returns the object directly (or {})
                          PUT /col           full replace
                          PATCH /col         partial merge

   Source of truth: your MongoDB Atlas collections
───────────────────────────────────────── */
const ARRAY_COLLECTIONS = [
  "users",
  "categories",
  "ingredients",
  "favourites",
  "orders",
  "staff",
  "careers",
  "holidays",
  "recipes",
  "offers",
  "reservations",
  "celebrations",
  "preBookings",
  "cateringOrders",
  "events",
  "eventBookings",
  "tables",
  "serviceActivity",
  "serviceSchedules",
  "kitchenActivity",
  "kitchenSchedules",
  "tasks",
  "combo_offers",
  "combo",
  "callHistory",
  "tablePreferences",
  "subscriptions",
];

// Plain objects in db.json — stored as one doc with id="singleton"
const SINGLETON_COLLECTIONS = [
  "grooming",
  "mise",
  "kitchenAssign",
  "kitchenMise",
  "serviceAssign",
  "serviceGrooming",
  "serviceMise",
  "comboSectionConfig",
  "categoryCards",
];

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */

/** Strip MongoDB internal fields from a lean doc before sending to client. */
function stripMeta(doc) {
  if (!doc) return doc;
  const out = { ...doc };
  delete out._id;
  delete out.__v;
  return out;
}

/** Emit an event to a single admin's own socket room (see chat:register above). */
function emitToAdmin(adminId, event, payload) {
  io.to(`admin:${adminId}`).emit(event, payload);
}

/** Whether an admin currently has at least one connected socket (see chat:register). */
function isAdminOnline(adminId) {
  const room = io.sockets.adapter.rooms.get(`admin:${adminId}`);
  return !!room && room.size > 0;
}

/** Emit a data-change event with a unique eventId to prevent double-firing. */
function emitChange(resource, action, payload) {
  io.emit("data-change", {
    resource,
    action,
    payload,
    eventId: `${resource}_${action}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 7)}`,
  });
}

/** Resources that trigger an admin "new booking" toast on creation. */
const BOOKING_META = {
  eventBookings: { label: "New event booking", route: "/event-bookings" },
  reservations: { label: "New reservation", route: "/reservations" },
  celebrations: { label: "New celebration booking", route: "/celebrations" },
  cateringOrders: { label: "New catering order", route: "/catering" },
  preBookings: { label: "New pre-booking", route: "/pre-bookings" },
  subscriptions: { label: "New subscription", route: "/subscriptions" },
};

function notifyNewBooking(resource, body) {
  const meta = BOOKING_META[resource];
  if (!meta) return;
  const name = body.name || body.userName || body.customerName || "";
  io.emit("new-booking", {
    resource,
    message: name ? `${meta.label} — ${name}` : meta.label,
    route: meta.route,
  });
}

/**
 * Generate a safe, incrementing order id like "order_00001".
 * The user-panel sends id:"pending" as a placeholder; the server assigns the real id.
 */
async function generateOrderId() {
  const Model = getModel("orders");
  const docs = await Model.find(
    { id: { $regex: /^order_\d+$/ } },
    { id: 1 }
  ).lean();

  let maxNum = 0;
  for (const d of docs) {
    const n = parseInt(d.id.replace("order_", ""), 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }

  let candidateNum = maxNum + 1;
  let candidate = `order_${String(candidateNum).padStart(5, "0")}`;

  // Guard against rare concurrent-order race
  while (await Model.exists({ id: candidate })) {
    candidateNum += 1;
    candidate = `order_${String(candidateNum).padStart(5, "0")}`;
  }
  return candidate;
}

/* ─────────────────────────────────────────
   AUTH MIDDLEWARE
───────────────────────────────────────── */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* ─────────────────────────────────────────
   PHASE-4 — STAFF / ROLE-BASED AUTH
   Mounted separately from the legacy customer
   /auth/* routes below (which operate on the
   `users` collection, not `admins`).
───────────────────────────────────────── */
app.use("/staff-auth", authRouter);
app.use("/todos", todoRouter);

/* ─────────────────────────────────────────
   LEGACY / CUSTOMER AUTH ROUTES
───────────────────────────────────────── */

// POST /auth/register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, ...rest } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "email and password are required" });

    const Model = getModel("users");
    const existing = await Model.findOne({ email }).lean();
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    const id = String(Date.now());
    const doc = await Model.create({ ...rest, email, password: hash, id });
    const result = stripMeta(doc.toObject());
    delete result.password;

    res.status(201).json(result);
  } catch (err) {
    console.error("POST /auth/register", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "email and password are required" });

    const Model = getModel("users");
    const user = await Model.findOne({ email }).lean();
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const payload = { id: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

    const { password: _pw, _id, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error("POST /auth/login", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/session-login — mobile-number lookup, matching how the user
// panel (Welcome.js) actually authenticates customers (no password).
// Issues an httpOnly cookie session instead of the frontend trusting a
// raw userId in localStorage.
/* ─────────────────────────────────────────
   GET /auth/mobile-exists?mobile=... — used only to power the
   mobile-number autocomplete on the login screen, before any session
   exists. Deliberately returns nothing but a boolean (never actual
   user records) — the old approach called the admin-only GET /users
   and filtered every customer's mobile number client-side, which both
   (a) 401s now that admin routes are properly session-gated, and
   (b) would have exposed every customer's phone number to anyone on
   the login screen even if it had "worked". This route can't be used
   to enumerate real numbers beyond exact/prefix matches the caller
   already typed, and returns only { exists: boolean }.
───────────────────────────────────────── */
app.get("/auth/mobile-exists", async (req, res) => {
  try {
    const mobile = String(req.query.mobile || "").trim();
    if (!mobile) return res.json({ exists: false });
    const match = await getModel("users").findOne({ mobile }).lean();
    res.json({ exists: !!match });
  } catch (err) {
    console.error("GET /auth/mobile-exists", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/session-login", async (req, res) => {
  try {
    const { mobile } = req.body;
    if (!mobile) return res.status(400).json({ error: "mobile is required" });

    const Model = getModel("users");
    const matches = await Model.find({ mobile }).lean();
    if (matches.length === 0) return res.status(404).json({ error: "No account exists with this mobile number" });
    if (matches.length > 1) return res.status(409).json({ error: "Multiple accounts found. Contact support." });

    const user = matches[0];
    await createCustomerSession(user.id, req, res);

    const result = stripMeta(user);
    delete result.password;
    res.json({ user: result });
  } catch (err) {
    console.error("POST /auth/session-login", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/session-signup — first-time mobile signup, also used by the
// user panel. Creates the user doc, then immediately starts a session
// the same way session-login does, so signup logs the customer straight in.
app.post("/auth/session-signup", async (req, res) => {
  try {
    const { name, mobile } = req.body;
    if (!name || !mobile) return res.status(400).json({ error: "name and mobile are required" });

    const Model = getModel("users");
    const existing = await Model.find({ mobile }).lean();
    if (existing.length > 0) return res.status(409).json({ error: "An account already exists with this mobile number" });

    const newUser = {
      id: `user_${mobile}`,
      name: name.trim(),
      mobile,
      favourites: [],
      combo: [],
      orders: [],
    };
    await Model.create(newUser);
    await createCustomerSession(newUser.id, req, res);

    res.status(201).json({ user: newUser });
  } catch (err) {
    console.error("POST /auth/session-signup", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/me — called on app mount to restore the logged-in customer
// from the httpOnly cookie, so a page reload keeps them signed in as
// long as the session is valid server-side (rather than trusting
// whatever id happens to be sitting in localStorage).
app.get("/auth/me", requireCustomerAuth, async (req, res) => {
  try {
    const Model = getModel("users");
    const user = await Model.findOne({ id: req.customerUserId }).lean();
    if (!user) return res.status(401).json({ error: "Account not found" });

    const result = stripMeta(user);
    delete result.password;
    res.json({ user: result });
  } catch (err) {
    console.error("GET /auth/me", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/logout — clears the customer session, both server-side
// (so the cookie can't be replayed) and the cookie itself.
app.post("/auth/logout", async (req, res) => {
  try {
    const sessionId = req.cookies ? req.cookies[CUSTOMER_SESSION_COOKIE] : null;
    if (sessionId) await CustomerSession.deleteOne({ sessionId });
    res.clearCookie(CUSTOMER_SESSION_COOKIE, customerCookieOpts());
    res.json({ success: true });
  } catch (err) {
    console.error("POST /auth/logout", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   GET /orders/mine — a logged-in customer's own order history.
   Registered BEFORE the generic /orders loop (which requires admin
   auth) so this customer-facing route takes priority. Reads from the
   orders collection directly (rather than the embedded copy on the
   user doc) so it stays correct even if an order is later updated
   (status changes, etc.) after being embedded at creation time.
───────────────────────────────────────── */
app.get("/orders/mine", requireCustomerAuth, async (req, res) => {
  try {
    const docs = await getModel("orders")
      .find({ userId: req.customerUserId })
      .sort({ createdAt: -1 })
      .lean();
    res.json(docs.map(stripMeta));
  } catch (err) {
    console.error("GET /orders/mine", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   PATCH /users/me/favourites — toggle a dish in the logged-in
   customer's own favourites. Registered BEFORE the generic /users
   loop (which requires admin auth via requireAdminAuth) so this
   customer-facing route takes priority — the wishlist heart on the
   food list/grid/expanded pages calls this with the customer's own
   session cookie, which the generic admin-only /users/:id route
   would otherwise reject outright (401/403), silently failing the
   toggle with no visible error to the customer.
   Body: the favourite object to add ({ id, name, image, ... }), or
   { id, _remove: true } to remove one. Returns the updated user doc
   so the caller can refresh currentUser.favourites in one round trip.
───────────────────────────────────────── */
app.patch("/users/me/favourites", requireCustomerAuth, async (req, res) => {
  try {
    const favourite = req.body || {};
    if (!favourite.id) return res.status(400).json({ error: "favourite.id is required" });

    const Model = getModel("users");

    // Single atomic update instead of a read-then-write pair — halves the
    // DB round trips per toggle (was: findOne, then findOneAndUpdate).
    // $pull/$addToSet both operate directly on the stored array, so no
    // separate read of the current favourites is needed first.
    const update = favourite._remove
      ? { $pull: { favourites: { id: favourite.id } } }
      : { $addToSet: { favourites: favourite } };

    const updated = await Model.findOneAndUpdate(
      { id: req.customerUserId },
      update,
      { returnDocument: "after" }
    ).lean();

    if (!updated) return res.status(404).json({ error: "Account not found" });

    const result = stripMeta(updated);
    delete result.password;
    res.json(result);
  } catch (err) {
    console.error("PATCH /users/me/favourites", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   GET /users/me — the logged-in customer's own profile. Registered
   BEFORE the generic /users/:id loop (admin-only) so this takes
   priority for a customer's own session. Used by every booking form
   to pre-fill name/mobile/email (bookingCrud.resolveUser()) instead
   of the admin-gated GET /users/:id, which always 401s for a
   customer session.
───────────────────────────────────────── */
app.get("/users/me", requireCustomerAuth, async (req, res) => {
  try {
    const user = await getModel("users").findOne({ id: req.customerUserId }).lean();
    if (!user) return res.status(404).json({ error: "Account not found" });
    const result = stripMeta(user);
    delete result.password;
    res.json(result);
  } catch (err) {
    console.error("GET /users/me", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   PATCH /users/me — update the logged-in customer's own profile
   fields (name, mobile, email, combo favourites, etc.). Deliberately
   allowlists which fields can be self-updated rather than accepting
   a raw full-document overwrite — the users collection is shared with
   staff/admin accounts and carries a `role` field, so blindly trusting
   client-supplied fields here would let a customer escalate their own
   account. Add to ALLOWED_SELF_UPDATE_FIELDS as new self-editable
   profile fields are introduced.
───────────────────────────────────────── */
const ALLOWED_SELF_UPDATE_FIELDS = ["name", "mobile", "email", "combo", "address"];
app.patch("/users/me", requireCustomerAuth, async (req, res) => {
  try {
    const update = {};
    for (const field of ALLOWED_SELF_UPDATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        update[field] = req.body[field];
      }
    }
    if (!Object.keys(update).length) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    const updated = await getModel("users")
      .findOneAndUpdate({ id: req.customerUserId }, update, { returnDocument: "after" })
      .lean();
    if (!updated) return res.status(404).json({ error: "Account not found" });

    const result = stripMeta(updated);
    delete result.password;
    res.json(result);
  } catch (err) {
    console.error("PATCH /users/me", err.message);
    res.status(500).json({ error: err.message });
  }
});


/**
 * requireCustomerAuthOrNext — same cookie/session check as
 * requireCustomerAuth, but used only on the booking routes below,
 * which are registered at the same paths (/reservations, etc.) as the
 * admin-scoped ARRAY_COLLECTIONS routes further down this file.
 *
 * requireCustomerAuth hard-401s when there's no valid samcafe_uid
 * cookie — correct for customer-only routes like /auth/me, but wrong
 * here: Express matches routes in registration order, so if this
 * block 401'd on a missing/expired customer cookie, an admin session
 * (which only ever carries samcafe_sid, never samcafe_uid) would
 * never reach the real admin-scoped handler for these same paths
 * registered later — every admin request to /reservations,
 * /celebrations, /preBookings, /cateringOrders, and /eventBookings
 * would 401 outright, regardless of how valid the admin's own session
 * was. (This was live in production: any leftover/expired samcafe_uid
 * cookie from previously using the customer-facing panel in the same
 * browser was enough to make GET /reservations etc. always return
 * "Session expired" for an admin, no matter which role logged in.)
 *
 * Falling through via next() when there's no valid customer session
 * lets the request continue on to the admin-scoped handler further
 * down instead of dead-ending here. A genuine customer session is
 * still required (and still enforced) for the customer-scoped
 * behavior itself — this only changes what happens when that specific
 * session is absent.
 */
async function requireCustomerAuthOrNext(req, res, next) {
  try {
    const sessionId = req.cookies ? req.cookies[CUSTOMER_SESSION_COOKIE] : null;
    if (!sessionId) return next("route");

    const session = await CustomerSession.findOne({ sessionId }).lean();
    if (!session || session.expiresAt < new Date()) {
      return next("route");
    }

    CustomerSession.updateOne(
      { sessionId },
      { $set: { lastActive: new Date(), expiresAt: new Date(Date.now() + CUSTOMER_SESSION_TTL_MS) } }
    ).catch(() => { });

    req.customerSessionId = sessionId;
    req.customerUserId = session.userId;
    next();
  } catch (err) {
    console.error("requireCustomerAuthOrNext error:", err.message);
    res.status(500).json({ error: "Auth check failed" });
  }
}

/* ─────────────────────────────────────────
   Customer-scoped booking routes: reservations, celebrations,
   preBookings, cateringOrders, eventBookings, subscriptions.
   Registered BEFORE the generic ARRAY_COLLECTIONS loop (admin-only)
   so these take priority for a customer session. Mirrors the exact
   shape the admin panel and eventBookingCrud.js (User Panel) already
   expect — same collections, same id/status conventions — the only
   difference is the auth guard and that reads/updates/deletes are
   scoped to the caller's own userId so one customer can never see or
   modify another's bookings.

   Uses requireCustomerAuthOrNext (not requireCustomerAuth): when
   there's no valid customer session, the request falls through to the
   admin-scoped ARRAY_COLLECTIONS handler for the same path instead of
   401ing outright — see that function's comment for why the plain
   401-on-missing-cookie version broke every admin request to these
   exact paths.
───────────────────────────────────────── */
const CUSTOMER_BOOKING_COLLECTIONS = [
  "reservations",
  "celebrations",
  "preBookings",
  "cateringOrders",
  "eventBookings",
  "subscriptions",
];

CUSTOMER_BOOKING_COLLECTIONS.forEach((name) => {
  const base = `/${name}`;

  // POST /reservations (etc.) — create a booking owned by the caller.
  // Forces userId to the authenticated session regardless of what the
  // client sent, so a customer can never create a booking under
  // someone else's account.
  app.post(base, requireCustomerAuthOrNext, async (req, res) => {
    try {
      const Model = getModel(name);
      const doc = { ...req.body, userId: req.customerUserId };
      const created = await Model.create(doc);
      const result = stripMeta(created.toObject ? created.toObject() : created);
      emitChange(name, "created", result);
      notifyNewBooking(name, result);
      res.status(201).json(result);
    } catch (err) {
      console.error(`POST ${base} (customer)`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /reservations (etc.) — the caller's own bookings only.
  app.get(base, requireCustomerAuthOrNext, async (req, res) => {
    try {
      const docs = await getModel(name)
        .find({ userId: req.customerUserId })
        .sort({ createdAt: -1 })
        .lean();
      res.json(docs.map(stripMeta));
    } catch (err) {
      console.error(`GET ${base} (customer)`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /reservations/:id (etc.) — single booking, only if it's the
  // caller's own (404s rather than 403s if it belongs to someone
  // else, so as not to leak whether the id exists at all).
  app.get(`${base}/:id`, requireCustomerAuthOrNext, async (req, res) => {
    try {
      const doc = await getModel(name)
        .findOne({ id: req.params.id, userId: req.customerUserId })
        .lean();
      if (!doc) return res.status(404).json({ error: "Not found" });
      res.json(stripMeta(doc));
    } catch (err) {
      console.error(`GET ${base}/:id (customer)`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /reservations/:id (etc.) — update, own bookings only. Used for
  // cancellation (status → "cancelled") via bookingCrud.cancel().
  // userId is re-forced to the caller's own id on every update so a
  // crafted payload can never reassign a booking to another account.
  app.put(`${base}/:id`, requireCustomerAuthOrNext, async (req, res) => {
    try {
      const Model = getModel(name);
      const update = { ...req.body, userId: req.customerUserId };
      const updated = await Model.findOneAndUpdate(
        { id: req.params.id, userId: req.customerUserId },
        update,
        { returnDocument: "after" }
      ).lean();
      if (!updated) return res.status(404).json({ error: "Not found" });
      const result = stripMeta(updated);
      emitChange(name, "updated", result);
      res.json(result);
    } catch (err) {
      console.error(`PUT ${base}/:id (customer)`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /reservations/:id (etc.) — own bookings only.
  app.delete(`${base}/:id`, requireCustomerAuthOrNext, async (req, res) => {
    try {
      const result = await getModel(name).deleteOne({
        id: req.params.id,
        userId: req.customerUserId,
      });
      if (!result.deletedCount) return res.status(404).json({ error: "Not found" });
      emitChange(name, "deleted", req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error(`DELETE ${base}/:id (customer)`, err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

/* ─────────────────────────────────────────
   GET /tablePreferences — read-only reference data (dining
   preference options shown in booking forms, e.g. "Window seat",
   "Quiet area"). Not owned by any one user, so no userId scoping —
   any authenticated customer can read the full list. Registered
   BEFORE the generic admin-only loop so a customer session isn't
   rejected trying to populate a booking form's preference dropdown.
───────────────────────────────────────── */
app.get("/tablePreferences", requireCustomerAuth, async (req, res) => {
  try {
    const docs = await getModel("tablePreferences").find({}).lean();
    res.json(docs.map(stripMeta));
  } catch (err) {
    console.error("GET /tablePreferences (customer)", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   ORDERS — dedicated create route
   Registered BEFORE the generic loop so it
   takes priority for POST /orders.
   Assigns a real order id server-side and
   embeds the order into the user doc for
   per-user order history / revenue stats.
───────────────────────────────────────── */
app.post("/orders", async (req, res) => {
  try {
    const newOrder = { ...req.body };
    newOrder.id = await generateOrderId();
    // Customer-facing order placement doesn't go through admin auth, so it
    // can't be scoped from req.admin. The user panel should send venueId
    // once it has branch selection; until then, fall back to whichever
    // venue was created first (Main Branch) so orders aren't lost/orphaned.
    if (!newOrder.venueId) {
      const { Venue } = venuesModule;
      const fallback = await Venue.findOne().sort({ createdAt: 1 }).lean();
      newOrder.venueId = fallback ? fallback.id : null;
    }

    const doc = await getModel("orders").create(newOrder);
    const result = stripMeta(doc.toObject());

    // Embed a copy into the user document for quick history lookups
    if (result.userId) {
      try {
        await getModel("users").updateOne(
          { id: result.userId },
          { $push: { orders: result } }
        );
      } catch (embedErr) {
        console.warn("Could not embed order in user doc:", embedErr.message);
      }
    }

    // Deduct consumed ingredient stock server-side, using the ingredient
    // quantities already embedded on each order item (item.ingredients,
    // each { name, quantity } in grams). This used to run client-side —
    // the customer's browser would fetch the ENTIRE ingredients
    // collection (including every other ingredient's current stock
    // level) and push authenticated writes back to it directly, which
    // is both an unnecessary data exposure and, now that admin routes
    // are properly session-gated, simply can't work from a customer
    // session at all. Doing it here means the customer only ever sends
    // what they ordered; the server computes and applies the deduction
    // with the same access it already has for order creation, and a
    // failure here doesn't roll back or block the order itself — stock
    // accuracy issues (e.g. a race between two simultaneous orders) are
    // worth fixing but shouldn't ever prevent someone's food order from
    // going through.
    try {
      const usedKgByName = new Map();
      for (const item of Array.isArray(result.items) ? result.items : []) {
        const qty = Number(item.quantity) || 1;
        for (const ing of Array.isArray(item.ingredients) ? item.ingredients : []) {
          if (!ing?.name) continue;
          const usedKg = ((Number(ing.quantity) || 0) * qty) / 1000;
          if (usedKg <= 0) continue;
          usedKgByName.set(ing.name, (usedKgByName.get(ing.name) || 0) + usedKg);
        }
      }

      if (usedKgByName.size) {
        const IngredientModel = getModel("ingredients");
        await Promise.all(
          Array.from(usedKgByName.entries()).map(([name, usedKg]) =>
            // $inc with a negative value is atomic — two orders deducting
            // the same ingredient concurrently can't clobber each other's
            // write the way a client-side read-then-write round trip
            // could. Floors at 0 in a follow-up clamp rather than letting
            // stock go negative under high concurrency.
            IngredientModel.updateOne({ name }, { $inc: { stockRemaining: -usedKg } })
          )
        );
        await IngredientModel.updateMany(
          { name: { $in: Array.from(usedKgByName.keys()) }, stockRemaining: { $lt: 0 } },
          { $set: { stockRemaining: 0 } }
        );
      }
    } catch (stockErr) {
      console.warn("Could not deduct ingredient stock for order", result.id, stockErr.message);
    }

    emitChange("orders", "created", result);
    res.status(201).json(result);
  } catch (err) {
    console.error("POST /orders", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   ARRAY COLLECTION ROUTES — venue-scoped + permission-matrix-gated

   Every collection here is multi-tenant: every document carries a
   venueId, every request is authenticated, and every read/write is
   checked against the permission matrix (permissions.js) for the
   caller's roleTitle + this module. Super Admin always passes and
   can optionally scope to one venue via ?venueId= (the venue
   switcher) — omit it to see all venues combined.

   Non-Super-Admin callers are hard-scoped to their own venueId
   (req.admin.venueId) on every op — they can never read, create,
   update, or delete another venue's data, even if they pass a
   different venueId explicitly.

   Every write is recorded to the audit log (auditLog.js).
───────────────────────────────────────── */

/** requirePerm(name, action) — auth + permission-matrix check for a given module. */
function requirePerm(name, action) {
  return async (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: "Not logged in" });
    const ok = await hasPermission(req.admin, name, action);
    if (!ok) return res.status(403).json({ error: "Insufficient permissions" });
    next();
  };
}

/**
 * scopeFilter(req) — the venueId filter to apply to a query.
 *   Super Admin + no ?venueId=  -> {} (see everything)
 *   Super Admin + ?venueId=X    -> { venueId: X }
 *   Everyone else               -> { venueId: req.admin.venueId } (forced)
 */
function scopeFilter(req) {
  if (req.admin.roleGroup === "Super Admin") {
    return req.query.venueId ? { venueId: req.query.venueId } : {};
  }
  return { venueId: req.admin.venueId };
}

/** The venueId a new document created by req.admin should be stamped with. */
function scopeVenueForCreate(req) {
  if (req.admin.roleGroup === "Super Admin") {
    // Super Admin must specify which venue a new record belongs to.
    return req.body.venueId || req.query.venueId || null;
  }
  return req.admin.venueId;
}

/**
 * Public menu-browsing routes — no session required at all.
 *
 * The user panel's fetchMenu() needs categories/ingredients/combo/offers/
 * tables/events before a customer has ever logged in (or even created an
 * account) — that's the whole point of browsing a menu. These were
 * previously served by the generic ARRAY_COLLECTIONS routes below, which
 * are gated by requireAdminAuth — correct for the admin panel's writes,
 * but wrong for a guest's read-only menu view, and the actual cause of
 * every "Failed to load menu" 401 a first-time visitor saw. Root-caused
 * the same session as the /users/me/favourites fix (same underlying
 * pattern: a customer-facing call was hitting an admin-only route).
 *
 * Kept intentionally narrow and read-only — only the exact collections
 * fetchMenu() actually needs for guest browsing. Orders/favourites for a
 * *specific* customer still correctly require a session (see /auth/me,
 * /orders/mine, /users/me/favourites above) — a public route can't know
 * who's asking, so those aren't included here.
 */
const PUBLIC_MENU_COLLECTIONS = ["categories", "ingredients", "combo", "offers", "tables", "events"];
PUBLIC_MENU_COLLECTIONS.forEach((name) => {
  app.get(`/public/${name}`, async (req, res) => {
    try {
      const filter = req.query.venueId ? { venueId: req.query.venueId } : {};
      const docs = await getModel(name).find(filter).lean();
      res.json(docs.map(stripMeta));
    } catch (err) {
      console.error(`GET /public/${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

ARRAY_COLLECTIONS.forEach((name) => {
  const base = `/${name}`;

  // GET /collection — list, scoped to caller's venue (or filtered/all for Super Admin)
  app.get(base, requireAdminAuth, requirePerm(name, "read"), async (req, res) => {
    try {
      const docs = await getModel(name).find(scopeFilter(req)).lean();
      res.json(docs.map(stripMeta));
    } catch (err) {
      console.error(`GET /${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /collection/:id — single document by app "id" field, still venue-scoped
  app.get(`${base}/:id`, requireAdminAuth, requirePerm(name, "read"), async (req, res) => {
    try {
      const Model = getModel(name);
      const filter = { ...scopeFilter(req), id: req.params.id };
      let doc = await Model.findOne(filter).lean();
      // Fallback: allow querying by MongoDB _id (still venue-scoped)
      if (!doc && mongoose.Types.ObjectId.isValid(req.params.id)) {
        doc = await Model.findOne({ ...scopeFilter(req), _id: req.params.id }).lean();
      }
      if (!doc) return res.status(404).json({ error: "Not found" });
      res.json(stripMeta(doc));
    } catch (err) {
      console.error(`GET /${name}/:id`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /collection — create (orders has its own route above)
  if (name !== "orders") {
    app.post(base, requireAdminAuth, requirePerm(name, "write"), async (req, res) => {
      try {
        const venueId = scopeVenueForCreate(req);
        if (!venueId) {
          return res.status(400).json({ error: "venueId is required (Super Admin must specify one)" });
        }
        const body = { ...req.body, venueId };
        if (!body.id) body.id = String(Date.now());
        const doc = await getModel(name).create(body);
        const result = stripMeta(doc.toObject());
        emitChange(name, "created", result);
        notifyNewBooking(name, result);
        logAudit(req, { action: "create", resource: name, targetId: result.id, after: result });
        res.status(201).json(result);
      } catch (err) {
        console.error(`POST /${name}`, err.message);
        res.status(500).json({ error: err.message });
      }
    });
  }

  // PUT /collection/:id — full replace (upsert so PUT on new id creates it), venue-scoped
  app.put(`${base}/:id`, requireAdminAuth, requirePerm(name, "write"), async (req, res) => {
    try {
      const filter = { ...scopeFilter(req), id: req.params.id };
      const before = await getModel(name).findOne(filter).lean();
      // On upsert-create, stamp the record with the caller's (or Super
      // Admin's chosen) venue rather than trusting an arbitrary body.venueId.
      const venueId = before ? before.venueId : scopeVenueForCreate(req);
      if (!venueId) {
        return res.status(400).json({ error: "venueId is required (Super Admin must specify one)" });
      }
      const body = { ...req.body, id: req.params.id, venueId };
      const doc = await getModel(name)
        .findOneAndReplace(filter, body, { returnDocument: "after", upsert: true })
        .lean();
      const result = stripMeta(doc);
      emitChange(name, "updated", result);
      logAudit(req, { action: "update", resource: name, targetId: result.id, before, after: result });
      res.json(result);
    } catch (err) {
      console.error(`PUT /${name}/:id`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /collection/:id — partial update, venue-scoped (never touches another venue's doc)
  app.patch(`${base}/:id`, requireAdminAuth, requirePerm(name, "write"), async (req, res) => {
    try {
      const filter = { ...scopeFilter(req), id: req.params.id };
      const before = await getModel(name).findOne(filter).lean();
      if (!before) return res.status(404).json({ error: "Not found" });
      // venueId is never editable via PATCH body — reassigning a record to
      // a different venue is a deliberate, separate operation if ever needed.
      const { venueId: _ignoredVenueId, ...patchBody } = req.body;
      const doc = await getModel(name)
        .findOneAndUpdate(filter, { $set: patchBody }, { returnDocument: "after" })
        .lean();
      const result = stripMeta(doc);
      emitChange(name, "updated", result);
      logAudit(req, { action: "update", resource: name, targetId: result.id, before, after: result });
      res.json(result);
    } catch (err) {
      console.error(`PATCH /${name}/:id`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /collection/:id — remove, venue-scoped
  app.delete(`${base}/:id`, requireAdminAuth, requirePerm(name, "write"), async (req, res) => {
    try {
      const filter = { ...scopeFilter(req), id: req.params.id };
      const doc = await getModel(name).findOneAndDelete(filter).lean();
      if (!doc) return res.status(404).json({ error: "Not found" });
      const result = stripMeta(doc);
      emitChange(name, "deleted", result);
      logAudit(req, { action: "delete", resource: name, targetId: result.id, before: result });

      // Every login account must be linked to a real staff record — if
      // the staff record itself is deleted, its login account (if any)
      // is deleted along with it, so an account can never outlive the
      // staff member it belongs to. Session cleanup mirrors the
      // DELETE /staff-auth/admins/:id route.
      if (name === "staff") {
        const { Admin, Session } = require("./auth");
        const linkedAccount = await Admin.findOneAndDelete({ staffId: result.id }).lean();
        if (linkedAccount) {
          await Session.deleteMany({ adminId: linkedAccount.id });
          logAudit(req, { action: "delete", resource: "admins", targetId: linkedAccount.id, before: linkedAccount });
        }
      }

      res.json(result);
    } catch (err) {
      console.error(`DELETE /${name}/:id`, err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

/* ─────────────────────────────────────────
   SINGLETON COLLECTION ROUTES — now one-per-venue

   Previously these were global (a single doc with id="singleton").
   With multi-venue, each branch needs its own grooming/mise/assign
   config, so the "singleton" is now scoped per venueId: the app id
   field becomes `singleton:<venueId>` internally but the API shape
   is unchanged (still returns the bare object, not wrapped).

   `theme` is the one exception carried over from SINGLETON_COLLECTIONS
   below — see the dedicated theme guard further down, which keeps it
   truly global and Super-Admin-only, per the "theme stays global"
   decision.

   GET    /collection   → returns the object for the caller's venue
                           (or ?venueId= for Super Admin), or {} if unseeded
   PUT    /collection   → full replace (upsert) for that venue
   PATCH  /collection   → partial merge update (upsert) for that venue
───────────────────────────────────────── */
const GLOBAL_SINGLETONS = new Set(["theme", "categoryCards"]); // Super Admin only, not venue-scoped
const VENUE_SINGLETONS = SINGLETON_COLLECTIONS.filter((n) => !GLOBAL_SINGLETONS.has(n));

function singletonIdFor(name, venueId) {
  return GLOBAL_SINGLETONS.has(name) ? "singleton" : `singleton:${venueId}`;
}

/** Which venueId a singleton read/write should target for this caller. */
function singletonVenueId(req) {
  if (!req.admin) {
    throw new Error("singletonVenueId called without req.admin — auth middleware did not run first");
  }
  if (req.admin.roleGroup === "Super Admin") {
    return (req.query && req.query.venueId) || (req.body && req.body.venueId) || null;
  }
  return req.admin.venueId;
}

VENUE_SINGLETONS.forEach((name) => {
  const base = `/${name}`;

  app.get(base, requireAdminAuth, requirePerm(name, "read"), async (req, res) => {
    try {
      const venueId = singletonVenueId(req);
      if (!venueId) return res.json({}); // Super Admin with no venue picked yet
      const doc = await getModel(name).findOne({ id: singletonIdFor(name, venueId) }).lean();
      if (!doc) return res.json({});
      const { _id, __v, id, ...rest } = doc;
      res.json(rest);
    } catch (err) {
      console.error(`GET /${name}`, err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });

  app.put(base, requireAdminAuth, requirePerm(name, "write"), async (req, res) => {
    try {
      const venueId = singletonVenueId(req);
      if (!venueId) return res.status(400).json({ error: "venueId is required (Super Admin must specify one)" });
      const before = await getModel(name).findOne({ id: singletonIdFor(name, venueId) }).lean();
      const body = { ...req.body, id: singletonIdFor(name, venueId), venueId };
      const doc = await getModel(name)
        .findOneAndReplace({ id: singletonIdFor(name, venueId) }, body, { returnDocument: "after", upsert: true })
        .lean();
      const { _id, __v, id, ...result } = doc;
      emitChange(name, "updated", result);
      logAudit(req, { action: "update", resource: name, targetId: venueId, before, after: result });
      res.json(result);
    } catch (err) {
      console.error(`PUT /${name}`, err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch(base, requireAdminAuth, requirePerm(name, "write"), async (req, res) => {
    try {
      const venueId = singletonVenueId(req);
      if (!venueId) return res.status(400).json({ error: "venueId is required (Super Admin must specify one)" });
      const before = await getModel(name).findOne({ id: singletonIdFor(name, venueId) }).lean();
      const { venueId: _ignored, ...patchBody } = req.body;
      const doc = await getModel(name)
        .findOneAndUpdate(
          { id: singletonIdFor(name, venueId) },
          { $set: { ...patchBody, venueId } },
          { returnDocument: "after", upsert: true }
        )
        .lean();
      const { _id, __v, id, ...result } = doc;
      emitChange(name, "updated", result);
      logAudit(req, { action: "update", resource: name, targetId: venueId, before, after: result });
      res.json(result);
    } catch (err) {
      console.error(`PATCH /${name}`, err.message, err.stack);
      res.status(500).json({ error: err.message });
    }
  });
});

/* ─────────────────────────────────────────
   COMBO OFFERS — public read
   Powers the "Offer applied" notification banner in the user-panel
   Combo builder (ComboPage.js) — same problem and same fix as
   combo-section-config/public above: combo_offers is an ARRAY_COLLECTION
   behind requireAdminAuth, but the user panel only ever holds a customer
   session. Read-only; writes still go through the Super-Admin-gated
   /combo_offers route. Resolves to the main branch for the same reason
   documented on combo-section-config/public.
───────────────────────────────────────── */
app.get("/combo-offers/public", async (req, res) => {
  try {
    const { Venue } = venuesModule;
    const mainBranch = (await Venue.findOne({ isMainBranch: true }).lean()) || (await Venue.findOne().sort({ createdAt: 1 }).lean());
    if (!mainBranch) return res.json([]);

    const docs = await getModel("combo_offers").find({ venueId: mainBranch.id }).lean();
    res.json(docs.map(stripMeta));
  } catch (err) {
    console.error("GET /combo-offers/public", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   COMBO SECTION CONFIG — public read
   The user-panel Combo page (ComboPage.js) needs to read the admin's
   category → combo-section mapping (Manage Combo Categories), but that
   config lives in the venue-scoped comboSectionConfig singleton behind
   requireAdminAuth — the user panel is a public/customer surface that
   only ever holds a customer session cookie, never an admin one, so it
   can never satisfy that check. Mirrors GET /category-cards/public
   above: a dedicated, read-only, unauthenticated route for the one
   customer-facing page that needs this data.
   The user panel has no venue concept of its own (single-storefront
   app), so this always resolves to whichever venue is currently marked
   as the main branch — falling back to the oldest-created venue if none
   is explicitly marked yet, matching ensureMainBranchAndBackfill()'s own
   fallback logic below.
───────────────────────────────────────── */
app.get("/combo-section-config/public", async (req, res) => {
  try {
    const { Venue } = venuesModule;
    const mainBranch = (await Venue.findOne({ isMainBranch: true }).lean()) || (await Venue.findOne().sort({ createdAt: 1 }).lean());
    if (!mainBranch) return res.json({ sections: [] });

    const doc = await getModel("comboSectionConfig").findOne({ id: singletonIdFor("comboSectionConfig", mainBranch.id) }).lean();
    if (!doc) return res.json({ sections: [] });
    const { _id, __v, id, ...rest } = doc;
    res.json(rest);
  } catch (err) {
    console.error("GET /combo-section-config/public", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   CATEGORY CARDS — public read
   The "special cards" row at the top of the user-panel Food Category
   page (My Favourites, Crowd Picks, My Orders, Combos, Offers,
   Events & Booking) is admin-configurable (name/image/enabled) via
   the categoryCards singleton above, but the user panel is a public,
   unauthenticated surface — it can't send an admin session cookie to
   read it. This mirrors GET /orders/mine's approach of a dedicated
   customer/public-facing route sitting alongside the admin-gated one.
   Read-only; writes still go through the Super-Admin-gated
   /categoryCards route below.
───────────────────────────────────────── */
app.get("/category-cards/public", async (req, res) => {
  try {
    const doc = await getModel("categoryCards").findOne({ id: "singleton" }).lean();
    if (!doc) return res.json({});
    const { _id, __v, id, ...rest } = doc;
    res.json(rest);
  } catch (err) {
    console.error("GET /category-cards/public", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   THEME — stays global and Super-Admin-only (not venue-scoped), per
   the "one theme, controlled only by Super Admin" decision.
   CATEGORY CARDS reuses the same global/Super-Admin-write shape for
   its admin-panel-facing route (see the public read route above for
   the user-panel-facing counterpart).
───────────────────────────────────────── */
// Public theme read — the customer app needs this to render its UI theme
// before any login, same reasoning as PUBLIC_MENU_COLLECTIONS above.
app.get("/public/theme", async (_req, res) => {
  try {
    const doc = await getModel("theme").findOne({ id: "singleton" }).lean();
    if (!doc) return res.json({});
    const { _id, __v, id, ...rest } = doc;
    res.json(rest);
  } catch (err) {
    console.error("GET /public/theme", err.message);
    res.status(500).json({ error: err.message });
  }
});

GLOBAL_SINGLETONS.forEach((name) => {
  const base = `/${name}`;

  // Any logged-in admin can READ the theme (it renders the whole UI).
  app.get(base, requireAdminAuth, async (req, res) => {
    try {
      const doc = await getModel(name).findOne({ id: "singleton" }).lean();
      if (!doc) return res.json({});
      const { _id, __v, id, ...rest } = doc;
      res.json(rest);
    } catch (err) {
      console.error(`GET /${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Only Super Admin can WRITE the theme.
  app.put(base, requireAdminAuth, requireAdminRole("Super Admin"), async (req, res) => {
    try {
      const before = await getModel(name).findOne({ id: "singleton" }).lean();
      const body = { ...req.body, id: "singleton" };
      const doc = await getModel(name)
        .findOneAndReplace({ id: "singleton" }, body, { returnDocument: "after", upsert: true })
        .lean();
      const { _id, __v, id, ...result } = doc;
      emitChange(name, "updated", result);
      logAudit(req, { action: "update", resource: name, targetId: "global", before, after: result });
      res.json(result);
    } catch (err) {
      console.error(`PUT /${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.patch(base, requireAdminAuth, requireAdminRole("Super Admin"), async (req, res) => {
    try {
      const before = await getModel(name).findOne({ id: "singleton" }).lean();
      const doc = await getModel(name)
        .findOneAndUpdate({ id: "singleton" }, { $set: req.body }, { returnDocument: "after", upsert: true })
        .lean();
      const { _id, __v, id, ...result } = doc;
      emitChange(name, "updated", result);
      logAudit(req, { action: "update", resource: name, targetId: "global", before, after: result });
      res.json(result);
    } catch (err) {
      console.error(`PATCH /${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

/* ─────────────────────────────────────────
   SOCKET.IO
───────────────────────────────────────── */
// In-memory table bell state (ephemeral — acceptable to lose on restart)
let activeBells = {};

/* ── Printer bridge relay state ──
   The local print-bridge (running next to the physical Epson printer)
   connects out to this server as a normal socket.io client and
   registers itself. Admin/user panels never talk to it directly —
   everything is relayed through here, so no public IP/port/tunnel
   is ever needed on the cafe's local network. */
let printerSocketId = null;

// jobId -> { requesterSocketId, timeout }
const pendingPrintJobs = new Map();
const PRINT_JOB_TIMEOUT_MS = 15000;

// If the bridge just dropped, it's usually mid-reconnect a moment later
// (e.g. brief wifi blip). Give it a short grace window to re-register
// before telling the requester it's offline, instead of failing instantly.
const PRINTER_RECONNECT_GRACE_MS = 4000;
let printerOnlineWaiters = []; // resolve callbacks waiting on the bridge to (re)register

function isPrinterOnline() {
  return !!(printerSocketId && io.sockets.sockets.get(printerSocketId));
}

function waitForPrinterOnline(timeoutMs) {
  if (isPrinterOnline()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      printerOnlineWaiters = printerOnlineWaiters.filter((w) => w !== onOnline);
      resolve(false);
    }, timeoutMs);
    function onOnline() {
      clearTimeout(timer);
      resolve(true);
    }
    printerOnlineWaiters.push(onOnline);
  });
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Sync current bell state to the newly connected client
  socket.emit("bell-sync", activeBells);

  // Staff chat: the client announces its own admin id right after
  // connecting so we can target it directly (emitToAdmin below) without
  // every chat event being broadcast to every connected socket. Also
  // flips any messages waiting for this admin from "sent" to
  // "delivered" (single → double tick) and tells each sender.
  socket.on("chat:register", async (payload) => {
    const adminId = payload && payload.adminId;
    if (!adminId || typeof adminId !== "string") return;
    socket.data.chatAdminId = adminId;
    socket.join(`admin:${adminId}`);
    if (typeof chatModule.markDelivered === "function") {
      const bySender = await chatModule.markDelivered(adminId);
      bySender.forEach((messageIds, senderId) => {
        emitToAdmin(senderId, "chat:delivered", { toId: adminId, messageIds });
      });
    }
  });

  // Tell the newly connected client current printer status right away
  socket.emit("printer:status", { online: isPrinterOnline() });

  socket.on("bell-ring", (payload) => {
    const { tableNo } = payload || {};
    if (!tableNo) return;
    activeBells[tableNo] = true;
    io.emit("bell-ring", { tableNo });
  });

  socket.on("bell-off", (payload) => {
    const { tableNo } = payload || {};
    if (!tableNo) return;
    delete activeBells[tableNo];
    io.emit("bell-off", { tableNo });
  });

  socket.on("theme-update", (payload) => {
    socket.broadcast.emit("theme-update", payload);
  });

  /* ── Printer bridge registers itself ──
     Payload: { secret } — a shared secret so random clients can't
     claim to be the printer. Set PRINTER_BRIDGE_SECRET in .env on
     both this server and the local bridge machine. */
  socket.on("printer:register", (payload) => {
    const { secret } = payload || {};
    if (process.env.PRINTER_BRIDGE_SECRET && secret !== process.env.PRINTER_BRIDGE_SECRET) {
      console.warn(`Printer bridge auth failed from ${socket.id}`);
      socket.emit("printer:register-ack", { ok: false, error: "Invalid secret" });
      return;
    }
    printerSocketId = socket.id;
    socket.data.isPrinterBridge = true;
    console.log(`Printer bridge registered: ${socket.id}`);
    socket.emit("printer:register-ack", { ok: true });
    io.emit("printer:status", { online: true });

    // Wake up any print requests that were waiting out the grace period
    const waiters = printerOnlineWaiters;
    printerOnlineWaiters = [];
    waiters.forEach((w) => w());
  });

  // Any client (admin/user panel) asking for current printer status
  socket.on("printer:status-check", () => {
    socket.emit("printer:status", { online: isPrinterOnline() });
  });

  /* ── Panel requests a print job ──
     Payload: { jobId, jobType: "kot" | "bill" | "test", order }
     jobId is generated client-side (e.g. crypto.randomUUID()) so the
     requester can match the eventual result. */
  socket.on("printer:print", async (payload) => {
    const { jobId, jobType, order } = payload || {};
    if (!jobId || !jobType) {
      socket.emit("printer:result", { jobId, success: false, error: "Missing jobId or jobType" });
      return;
    }
    if (!isPrinterOnline()) {
      // Don't fail instantly — the bridge may be mid-reconnect after a
      // brief drop. Wait a short grace period for it to come back.
      const cameBackOnline = await waitForPrinterOnline(PRINTER_RECONNECT_GRACE_MS);
      if (!cameBackOnline) {
        socket.emit("printer:result", { jobId, success: false, error: "Printer bridge is offline" });
        return;
      }
    }

    pendingPrintJobs.set(jobId, { requesterSocketId: socket.id });

    // Safety timeout in case the bridge never responds
    const timer = setTimeout(() => {
      if (pendingPrintJobs.has(jobId)) {
        pendingPrintJobs.delete(jobId);
        io.to(socket.id).emit("printer:result", {
          jobId,
          success: false,
          error: "Print job timed out — printer may be offline or unreachable",
        });
      }
    }, PRINT_JOB_TIMEOUT_MS);
    pendingPrintJobs.get(jobId).timeout = timer;

    io.to(printerSocketId).emit("printer:print", { jobId, jobType, order });
  });

  /* ── Bridge reports the outcome of a job ──
     Payload: { jobId, success, message, error } */
  socket.on("printer:result", (payload) => {
    const { jobId } = payload || {};
    const job = pendingPrintJobs.get(jobId);
    if (!job) return; // already timed out or unknown job
    clearTimeout(job.timeout);
    pendingPrintJobs.delete(jobId);
    io.to(job.requesterSocketId).emit("printer:result", payload);
  });

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
    if (socket.id === printerSocketId) {
      printerSocketId = null;
      console.log("Printer bridge disconnected");
      io.emit("printer:status", { online: false });
    }
  });
});

/* ─────────────────────────────────────────
   HEALTH CHECK
───────────────────────────────────────── */
app.get("/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

app.use(
  "/venues",
  venuesModule.buildRouter({ requireAuth: requireAdminAuth, requireRole: requireAdminRole, logAudit })
);
app.use(
  "/permissions",
  permissionsModule.buildRouter({ requireAuth: requireAdminAuth, requireRole: requireAdminRole, logAudit })
);
app.use(
  "/roles",
  rolesModule.buildRouter({
    requireAuth: requireAdminAuth,
    requireRole: requireAdminRole,
    logAudit,
  })
);
// TEMPORARY DIAGNOSTIC — remove after debugging the cookie/SameSite issue.
// Reports config the server is actually running with, without exposing secrets.
app.get("/__debug_cookie_config", (_req, res) => {
  res.json({
    NODE_ENV: process.env.NODE_ENV || null,
    isProd_would_be: process.env.NODE_ENV === "production",
    trustProxySetting: app.get("trust proxy"),
    debugMarker: "trust-proxy-fix-v1", // bump this string each time you redeploy to confirm freshness
  });
});

app.use(
  "/work-plan",
  workPlanModule.buildRouter({
    requireAuth: requireAdminAuth,
    requireRole: requireAdminRole,
    logAudit,
  })
);
app.use(
  "/audit-logs",
  auditLogModule.buildRouter({ requireAuth: requireAdminAuth, requireRole: requireAdminRole })
);
app.use(
  "/documents",
  documentsModule.buildRouter({ requireAuth: requireAdminAuth, requireRole: requireAdminRole, logAudit })
);
app.use(
  "/payments",
  paymentsModule.buildRouter({ requireAuth: requireAdminAuth, logAudit, emitChange })
);
app.use(
  "/bank-account",
  bankAccountModule.buildRouter({ requireAuth: requireAdminAuth, requireRole: requireAdminRole, logAudit })
);
app.use(
  "/chat",
  chatModule.buildRouter({ requireAuth: requireAdminAuth, logAudit, emitToAdmin, isAdminOnline })
);

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

/* ─────────────────────────────────────────
   KEEP-ALIVE SELF-PING
   Prevents Render free tier from spinning
   down after 15 min of inactivity.
   Set SELF_URL in .env to enable.
───────────────────────────────────────── */
const SELF_URL = process.env.SELF_URL || null;
if (SELF_URL) {
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/health`);
      console.log("Keep-alive: self-ping OK");
    } catch (err) {
      console.warn("Keep-alive ping failed:", err.message);
    }
  }, 10 * 60 * 1000); // every 10 minutes
}

/* ─────────────────────────────────────────
   START
───────────────────────────────────────── */
const PORT = process.env.PORT || 4000;

/**
 * ensureMainBranchAndBackfill — one-time migration run on every boot
 * (cheap no-op once it's done). Creates a "Main Branch" venue if none
 * exists yet, then backfills venueId onto every pre-existing document
 * in every venue-scoped collection (and onto admins without a venue,
 * skipping Super Admins) so nothing becomes invisible the moment
 * venue scoping goes live.
 */
async function ensureMainBranchAndBackfill() {
  const { Venue, newVenueId } = venuesModule;

  let mainBranch = await Venue.findOne().sort({ createdAt: 1 }).lean();
  if (!mainBranch) {
    mainBranch = await Venue.create({
      id: newVenueId(),
      name: "Main Branch",
      address: "Not yet set — update in Venues",
      area: "Not yet set",
    });
    mainBranch = mainBranch.toObject();
    console.log(`[migration] Created default venue "Main Branch" (${mainBranch.id})`);
  }

  // Backfill every ARRAY_COLLECTIONS doc missing venueId.
  for (const name of ARRAY_COLLECTIONS) {
    try {
      const Model = getModel(name);
      const result = await Model.updateMany(
        { venueId: { $exists: false } },
        { $set: { venueId: mainBranch.id } }
      );
      if (result.modifiedCount) {
        console.log(`[migration] Backfilled venueId on ${result.modifiedCount} doc(s) in "${name}"`);
      }
    } catch (err) {
      console.error(`[migration] Backfill failed for "${name}":`, err.message);
    }
  }

  // Backfill admins: only non-Super-Admin accounts get pinned to Main Branch.
  const adminResult = await Admin.updateMany(
    { venueId: null, roleGroup: { $ne: "Super Admin" } },
    { $set: { venueId: mainBranch.id } }
  );
  if (adminResult.modifiedCount) {
    console.log(`[migration] Assigned ${adminResult.modifiedCount} admin account(s) to "Main Branch"`);
  }

  return mainBranch;
}

/**
 * resetMonthlySalaryFieldsIfNeeded — advance, deduction, penalty, bonus,
 * and overtime on every staff member's salary record are per-month
 * figures (Salary Management page), not running totals, so they need to
 * clear back to 0 at the start of each new calendar month rather than
 * carrying over. `remainingSalary` is a 1-element array holding the
 * current record — this zeroes those five fields on every element
 * (structurally always one) while leaving `advance`'s historical
 * carry-forward alone, since only these five reset.
 *
 * A marker doc (in a tiny dedicated "salaryResetState" collection)
 * records the last month this ran for, so it's a no-op on every server
 * restart within the same month, and only actually resets once when the
 * month first rolls over — checked both at startup and periodically
 * (below), since a long-running process wouldn't otherwise notice the
 * month changing without a restart.
 */
const SalaryResetState = mongoose.model(
  "SalaryResetState",
  new mongoose.Schema({ id: String, lastResetMonth: String }, { versionKey: false }),
  "salaryResetState"
);

async function resetMonthlySalaryFieldsIfNeeded() {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const state = await SalaryResetState.findOneAndUpdate(
      { id: "singleton" },
      { $setOnInsert: { id: "singleton", lastResetMonth: currentMonth } },
      { upsert: true, new: true }
    );
    if (state.lastResetMonth === currentMonth) return; // already reset (or just initialized) for this month

    const StaffModel = getModel("staff");
    // $expr lets `remaining`/`salaryRemaining` reset to each staff
    // member's own base salary (not a flat 0), matching what the UI
    // would compute once every add-on/deduction field is back to zero.
    const result = await StaffModel.updateMany(
      { "remainingSalary.0": { $exists: true } },
      [
        {
          $set: {
            remainingSalary: {
              $map: {
                input: "$remainingSalary",
                in: {
                  $mergeObjects: [
                    "$$this",
                    { advance: 0, deduction: 0, penalty: 0, bonus: 0, overtime: 0, remaining: { $ifNull: ["$salary", 0] } },
                  ],
                },
              },
            },
            salaryRemaining: { $ifNull: ["$salary", 0] },
          },
        },
      ]
    );
    await SalaryResetState.updateOne({ id: "singleton" }, { $set: { lastResetMonth: currentMonth } });
    console.log(`[salary-reset] Reset monthly salary fields on ${result.modifiedCount} staff record(s) for ${currentMonth}.`);
  } catch (err) {
    console.error("[salary-reset] Failed to reset monthly salary fields:", err.message);
  }
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("Connected to MongoDB");
    await ensureMainBranchAndBackfill();
    await ensureAdminsHaveStaffRecords();
    await permissionsModule.seedDefaultPermissions();
    await rolesModule.ensureDefaultRoles();
    await rolesModule.retireRemovedRoles();
    await resetMonthlySalaryFieldsIfNeeded();
    // Re-check every 6 hours so a long-running process (no restart)
    // still resets promptly after midnight on the 1st of the month.
    setInterval(resetMonthlySalaryFieldsIfNeeded, 6 * 60 * 60 * 1000);
    chatModule.scheduleWeeklyChatPurge(() => io.emit("chat:purged", {}));
    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });