/**
 * auth.js — Sam Cafe Phase-4 Role-Based Authentication
 *
 * Model:
 *   Role hierarchy (roleGroup -> roleTitle):
 *     Supervisor  -> Sous Chef | Captain
 *     Manager     -> Service Manager | Chef
 *     Super Admin -> General Manager | Proprietor
 *
 *   admins       — login accounts (email/password), one per staff member.
 *                  Optionally linked to an HR record in `staff` via staffId.
 *   sessions     — server-side session records. A signed, random session id
 *                  is set as an httpOnly cookie. Every request that needs
 *                  auth looks the session up in Mongo, so sessions can be
 *                  revoked (logout, "log out everywhere", expiry) instantly
 *                  instead of relying purely on a stateless JWT.
 *   resetTokens  — one-time forgot-password tokens.
 *
 * Reload persistence: the frontend calls GET /staff-auth/me on mount. As
 * long as the httpOnly cookie is present and the session hasn't
 * expired/been revoked, the admin stays logged in across refreshes/tab
 * closes — no client-side token juggling required.
 *
 * Mounted at /staff-auth (not /auth) to stay separate from the existing
 * customer-facing /auth/register + /auth/login routes in server.js, which
 * operate on the `users` (customer) collection, not `admins` (staff).
 */

const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { sendResetPasswordEmail } = require("./Mailer");

const router = express.Router();

// Generic-schema accessor for the `staff` collection (HR records) — used
// to validate that a staffId passed to create-staff-account points to a
// real staff record. Mirrors server.js's getModel() pattern but is kept
// local here to avoid a circular require; mongoose.models[...] is
// checked first since server.js may have already registered the same
// collection name via its own generic schema.
function getStaffModel() {
  if (mongoose.models.staff) return mongoose.models.staff;
  const anySchema = new mongoose.Schema({}, { strict: false, timestamps: false, versionKey: false, id: false });
  return mongoose.model("staff", anySchema, "staff");
}

/**
 * ensureAdminsHaveStaffRecords() — runs on every server startup, after
 * ensureMainBranchAndBackfill(). Every login account must be linked to a
 * real staff record (staffId), but that rule was added after some
 * accounts already existed (e.g. accounts created directly against the
 * database, or before create-staff-account enforced it) — those have
 * staffId: null and show up with no staff info in the Login Accounts
 * list. It also re-heals accounts whose linked staffId points at a
 * record that was since deleted (e.g. someone deleted the HR record but
 * left the login account in place) — a case earlier versions of this
 * function left untouched, which is why a Super Admin account like a
 * General Manager's could silently stop appearing on the Staffs page.
 * Creates a minimal matching staff record for each affected account and
 * back-links it. Safe to run every time: an admin whose staffId still
 * resolves to a real staff doc is left untouched.
 */
async function ensureAdminsHaveStaffRecords() {
  try {
    const allAdmins = await Admin.find({});
    if (allAdmins.length === 0) return;

    const StaffModel = getStaffModel();
    const staffIds = allAdmins.map((a) => a.staffId).filter(Boolean);
    const existingStaff = staffIds.length > 0
      ? await StaffModel.find({ id: { $in: staffIds } }).select("id").lean()
      : [];
    const existingStaffIds = new Set(existingStaff.map((s) => s.id));

    // Orphaned = never linked, OR linked to a staffId that no longer
    // exists (e.g. the HR record was deleted after linking).
    const orphaned = allAdmins.filter((a) => !a.staffId || !existingStaffIds.has(a.staffId));
    if (orphaned.length === 0) return;

    let created = 0;
    for (const admin of orphaned) {
      const staffId = `staff_${(admin.name || "member").toLowerCase().replace(/\s+/g, "_")}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      await StaffModel.create({
        id: staffId,
        name: admin.name,
        role: "Manager", // safe generic HR job title; the admin can change this from the Staffs page afterward
        venueId: admin.venueId || null,
        contact: admin.phone || "",
        workType: "full-time",
        employmentType: "permanent",
        joiningDate: admin.createdAt ? new Date(admin.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
        previousExperience: [],
        bank: { name: "", account: "", ifsc: "" },
      });
      admin.staffId = staffId;
      await admin.save();
      created += 1;
    }
    console.log(`Created ${created} staff record(s) for previously-unlinked or de-synced login account(s).`);
  } catch (err) {
    console.error("Failed to backfill staff records for admins:", err.message);
  }
}

// Lazy require to avoid a circular dependency (auditLog.js doesn't need
// auth.js, but keeping the require inside the function is defensive and
// costs nothing since Node caches modules).
function logAudit(...args) {
  return require("./auditLog").logAudit(...args);
}

/* ─────────────────────────────────────────
   ROLE MODEL
───────────────────────────────────────── */
const ROLE_TREE = {
  Supervisor: ["Sous Chef", "Captain"],
  Manager: ["Service Manager", "Chef"],
  "Super Admin": ["General Manager", "Proprietor"],
};

const ALL_ROLE_GROUPS = Object.keys(ROLE_TREE);
const ALL_ROLE_TITLES = Object.values(ROLE_TREE).flat();

// Rank purely for "does A outrank B" checks — Super Admin > Manager > Supervisor.
const ROLE_RANK = { Supervisor: 1, Manager: 2, "Super Admin": 3 };

function isValidRolePair(roleGroup, roleTitle) {
  return !!ROLE_TREE[roleGroup] && ROLE_TREE[roleGroup].includes(roleTitle);
}

// Simple, standard email shape check — used wherever a login account's
// email is set (create-staff-account, admin edit) so a malformed address
// never reaches the database.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === "string" && EMAIL_RE.test(email.trim());
}

/**
 * CREATABLE_TITLES — staff-creation hierarchy (Requirement: staff page
 * account creation/deletion, not open self-signup). Keyed by the
 * creator's roleTitle, valued as the list of roleTitles they're allowed
 * to create or delete accounts for. Super Admin (General Manager,
 * Proprietor) bypasses this map entirely (checked separately below) and
 * can create/delete anyone.
 *
 *   Chef             -> Sous Chef
 *   Service Manager  -> Captain, Sous Chef, Chef   (Manager rank -> both Supervisor titles + peer Manager titles below is NOT intended;
 *                        per spec: "service manager can do for captain and supervisor")
 *   Captain          -> (a Supervisor title) -> Supervisor-rank titles below Captain: none defined, so Captain creates no one by default
 *                        per spec: "captain can do for supervisor" — Captain can create Sous Chef/Captain-level (Supervisor rank) accounts
 *
 * Re-reading the spec literally: "chef can do for sous chef" (Manager ->
 * Supervisor, same dept), "service manager can do for captain and
 * supervisor" (Manager -> both Supervisor titles), "captain can do for
 * supervisor" (Supervisor -> Supervisor rank, i.e. peer/lower titles).
 * "Supervisor" here refers to the Supervisor RANK (Sous Chef + Captain),
 * not a literal roleTitle (there isn't one).
 */
const CREATABLE_TITLES = {
  Chef: ["Sous Chef"],
  "Service Manager": ["Captain", "Sous Chef"],
  Captain: ["Sous Chef", "Captain"],
};

/** canCreateRoleTitle(creatorAdmin, targetRoleTitle) */
function canCreateRoleTitle(creator, targetRoleTitle) {
  if (!creator) return false;
  if (creator.roleGroup === "Super Admin") return true;
  const allowed = CREATABLE_TITLES[creator.roleTitle] || [];
  return allowed.includes(targetRoleTitle);
}

/** requireCanManageStaff — allows Super Admin, or a roleTitle present in
 * CREATABLE_TITLES (i.e. someone with at least one creatable title below
 * them). Route handlers still re-check canCreateRoleTitle per-target. */
function requireCanManageStaff(req, res, next) {
  if (!req.admin) return res.status(401).json({ error: "Not logged in" });
  if (req.admin.roleGroup === "Super Admin") return next();
  if (CREATABLE_TITLES[req.admin.roleTitle]) return next();
  return res.status(403).json({ error: "Insufficient permissions" });
}

/**
 * DEPARTMENT — which side of the house a roleTitle belongs to. Drives
 * KMS/SMS module defaults and the "who can see whose profile" rule:
 * a manager/supervisor can see profiles in their own department that
 * rank at or below them, but never anyone who outranks them. Super
 * Admin roleTitles have no department — they see everyone.
 */
const DEPARTMENT_BY_ROLE_TITLE = {
  "Sous Chef": "kitchen",
  Chef: "kitchen",
  Captain: "service",
  "Service Manager": "service",
  "General Manager": null,
  Proprietor: null,
};

function departmentFor(roleTitle) {
  return DEPARTMENT_BY_ROLE_TITLE[roleTitle] || null;
}

/* ─────────────────────────────────────────
   SCHEMAS
───────────────────────────────────────── */
const adminSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true }, // bcrypt hash
    roleGroup: { type: String, enum: ALL_ROLE_GROUPS, required: true },
    roleTitle: { type: String, enum: ALL_ROLE_TITLES, required: true },
    // Every non-Super-Admin account belongs to exactly one venue (branch).
    // Super Admin accounts leave this null — they're global and can see/
    // manage every venue. Enforced in the signup/admin-edit routes below,
    // not at the schema level, so Super Admin creation isn't blocked.
    venueId: { type: String, default: null },
    staffId: { type: String, default: null }, // link to the HR `staff` record this account belongs to. Required for every NEW account (enforced in create-staff-account below) so every login is tied to a real staff member; nullable here only so older accounts created before this rule don't fail to load.
    phone: { type: String, default: "" },
    photo: { type: String, default: "" },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    mustResetPassword: { type: Boolean, default: false }, // set true for migrated accounts with temp passwords
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

const sessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    adminId: { type: String, required: true },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    lastActive: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo TTL auto-cleanup

const resetTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    adminId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
  },
  { versionKey: false }
);
resetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const todoSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    adminId: { type: String, required: true },
    title: { type: String, required: true },
    notes: { type: String, default: "" },
    period: { type: String, enum: ["daily", "weekly", "monthly"], default: "daily" },
    dueDate: { type: String, default: "" }, // YYYY-MM-DD
    status: { type: String, enum: ["pending", "done"], default: "pending" },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { versionKey: false }
);

const Admin = mongoose.model("Admin", adminSchema, "admins");
const Session = mongoose.model("Session", sessionSchema, "sessions");
const ResetToken = mongoose.model("ResetToken", resetTokenSchema, "resetTokens");
const Todo = mongoose.model("Todo", todoSchema, "todos");

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */
const SESSION_COOKIE = "samcafe_sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function genSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

function safeAdmin(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  delete obj.password;
  obj.department = departmentFor(obj.roleTitle);
  return obj;
}

function cookieOpts() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd, // Render/Vercel are HTTPS in prod; localhost dev needs secure:false
    sameSite: isProd ? "none" : "lax", // cross-origin cookie (Vercel frontend -> Render backend) needs SameSite=None
    maxAge: SESSION_TTL_MS,
    path: "/",
  };
}

async function createSession(adminId, req, res) {
  const sessionId = genSessionId();
  await Session.create({
    sessionId,
    adminId,
    userAgent: req.headers["user-agent"] || "",
    ip: req.ip,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  const opts = cookieOpts();
  console.log("[cookie debug] setting session cookie with options:", JSON.stringify(opts), "req.secure:", req.secure, "x-forwarded-proto:", req.headers["x-forwarded-proto"]);
  res.cookie(SESSION_COOKIE, sessionId, opts);
  return sessionId;
}

/**
 * requireAuth — validates the session cookie against the sessions
 * collection, attaches req.admin (full safe admin doc) + req.session.
 *
 * A page load fires many parallel requests (one per collection), each
 * hitting requireAuth — without caching that's 2 DB round-trips
 * (Session.findOne + Admin.findOne) per request, every time. A short
 * in-memory cache keyed by sessionId collapses that burst into a single
 * pair of queries per session per cache window, which is the majority
 * of requireAuth's latency on every admin-panel page load. The TTL is
 * short enough that role/status changes (suspending an account, editing
 * a role) still take effect within a few seconds — not instantly, but
 * fast enough that it isn't a meaningful security gap for an internal
 * staff tool, and far better than the un-cached cost on every request.
 */
const AUTH_CACHE_TTL_MS = 5 * 1000;
const authCache = new Map(); // sessionId -> { at, session, admin }

function invalidateAuthCache(sessionId) {
  if (sessionId) authCache.delete(sessionId);
  else authCache.clear();
}

async function requireAuth(req, res, next) {
  try {
    const sessionId = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    if (!sessionId) return res.status(401).json({ error: "Not logged in" });

    const cached = authCache.get(sessionId);
    if (cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) {
      req.session = cached.session;
      req.admin = cached.admin;
      return next();
    }

    const session = await Session.findOne({ sessionId }).lean();
    if (!session || session.expiresAt < new Date()) {
      res.clearCookie(SESSION_COOKIE, cookieOpts());
      authCache.delete(sessionId);
      return res.status(401).json({ error: "Session expired" });
    }

    const admin = await Admin.findOne({ id: session.adminId }).lean();
    if (!admin || admin.status !== "active") {
      authCache.delete(sessionId);
      return res.status(401).json({ error: "Account not available" });
    }

    // Sliding expiry: touch lastActive + push expiresAt forward on activity.
    Session.updateOne(
      { sessionId },
      { $set: { lastActive: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } }
    ).catch(() => { });

    req.session = session;
    req.admin = safeAdmin(admin);
    authCache.set(sessionId, { at: Date.now(), session, admin: req.admin });
    next();
  } catch (err) {
    console.error("requireAuth error:", err.message);
    res.status(500).json({ error: "Auth check failed" });
  }
}

/** requireRole("Manager", "Super Admin") — allow only listed role groups. */
function requireRole(...allowedGroups) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: "Not logged in" });
    if (!allowedGroups.includes(req.admin.roleGroup)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

/** requireMinRank("Manager") — allow this role group or anything ranked higher. */
function requireMinRank(minGroup) {
  const minRank = ROLE_RANK[minGroup] || 0;
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: "Not logged in" });
    if ((ROLE_RANK[req.admin.roleGroup] || 0) < minRank) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    next();
  };
}

/* ─────────────────────────────────────────
   ROUTES
───────────────────────────────────────── */

/**
 * POST /auth/create-staff-account — replaces open self-serve signup.
 * Only a logged-in admin whose roleTitle appears in CREATABLE_TITLES (or
 * Super Admin) may call this, and only to create an account at or below
 * their permitted tier (see canCreateRoleTitle). The account is created
 * with a temporary password the creator sets; the new staff member must
 * change it via forgot-password (or is forced to on first login via
 * mustResetPassword) before doing anything else.
 *
 * Non-Super-Admin creators may not choose a venueId — the new account is
 * always pinned to the creator's own venue, since a Manager/Supervisor
 * can only ever manage staff at their own branch.
 */
router.post("/create-staff-account", requireAuth, requireCanManageStaff, async (req, res) => {
  try {
    const { name, email, roleGroup, roleTitle, tempPassword, phone, staffId, venueId } = req.body;
    if (!name || !email || !roleGroup || !roleTitle || !tempPassword) {
      return res.status(400).json({ error: "name, email, roleGroup, roleTitle, tempPassword are required" });
    }
    if (!staffId) {
      return res.status(400).json({ error: "staffId is required — every login account must be linked to a staff record" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }
    if (!isValidRolePair(roleGroup, roleTitle)) {
      return res.status(400).json({ error: "roleTitle does not belong to roleGroup" });
    }
    if (tempPassword.length < 6) {
      return res.status(400).json({ error: "Temporary password must be at least 6 characters" });
    }
    if (!canCreateRoleTitle(req.admin, roleTitle)) {
      return res.status(403).json({ error: `You are not permitted to create a ${roleTitle} account` });
    }

    const staffRecord = await getStaffModel().findOne({ id: staffId }).lean();
    if (!staffRecord) {
      return res.status(400).json({ error: "staffId does not match an existing staff record" });
    }
    // The login role must match the staff member's HR job title exactly —
    // a Chef's login can't be created as a Captain, etc.
    if (staffRecord.role !== roleTitle) {
      return res.status(400).json({ error: `Login role must match the staff member's job role (${staffRecord.role})` });
    }
    const alreadyLinked = await Admin.findOne({ staffId }).lean();
    if (alreadyLinked) {
      return res.status(409).json({ error: "This staff member already has a login account" });
    }

    let resolvedVenueId = null;
    if (roleGroup === "Super Admin") {
      if (req.admin.roleGroup !== "Super Admin") {
        return res.status(403).json({ error: "Only Super Admin can create Super Admin accounts" });
      }
      resolvedVenueId = null;
    } else if (req.admin.roleGroup === "Super Admin") {
      // Super Admin may target any venue explicitly.
      if (!venueId) return res.status(400).json({ error: "venueId is required for this role" });
      const { Venue } = require("./venues");
      const venue = await Venue.findOne({ id: venueId }).lean();
      if (!venue) return res.status(400).json({ error: "venueId does not match an existing venue" });
      resolvedVenueId = venueId;
    } else {
      // Non-Super-Admin creators are pinned to their own venue.
      resolvedVenueId = req.admin.venueId;
    }

    const existing = await Admin.findOne({ email: email.toLowerCase().trim() }).lean();
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(tempPassword, 10);
    const admin = await Admin.create({
      id: newId("admin"),
      name,
      email: email.toLowerCase().trim(),
      password: hash,
      roleGroup,
      roleTitle,
      venueId: resolvedVenueId,
      staffId,
      phone: phone || "",
      mustResetPassword: true, // force the new staff member to set their own password on first login
    });

    const safe = safeAdmin(admin);
    await logAudit(req, { action: "create", resource: "admins", targetId: safe.id, after: safe });
    res.status(201).json({ admin: safe });
  } catch (err) {
    console.error("POST /auth/create-staff-account", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (!admin) {
      await logAudit(req, { action: "login_failed", resource: "session", targetId: email });
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (admin.status !== "active") {
      await logAudit(req, { action: "login_failed", resource: "session", targetId: admin.id, adminOverride: safeAdmin(admin) });
      return res.status(403).json({ error: "Account is suspended" });
    }

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) {
      await logAudit(req, { action: "login_failed", resource: "session", targetId: admin.id, adminOverride: safeAdmin(admin) });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    admin.lastLoginAt = new Date();
    await admin.save();

    await createSession(admin.id, req, res);
    const safe = safeAdmin(admin);
    req.admin = safe;
    await logAudit(req, { action: "login", resource: "session", targetId: safe.id });
    res.json({ admin: safe });
  } catch (err) {
    console.error("POST /auth/login", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/logout — revoke current session only
router.post("/logout", async (req, res) => {
  try {
    const sessionId = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    if (sessionId) {
      const session = await Session.findOne({ sessionId }).lean();
      if (session) {
        const admin = await Admin.findOne({ id: session.adminId }).lean();
        await logAudit(req, { action: "logout", resource: "session", targetId: session.adminId, adminOverride: admin ? safeAdmin(admin) : null });
      }
      await Session.deleteOne({ sessionId });
      invalidateAuthCache(sessionId);
    }
    res.clearCookie(SESSION_COOKIE, cookieOpts());
    res.json({ success: true });
  } catch (err) {
    console.error("POST /auth/logout", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/logout-all — revoke every session for the current admin
router.post("/logout-all", requireAuth, async (req, res) => {
  try {
    await Session.deleteMany({ adminId: req.admin.id });
    res.clearCookie(SESSION_COOKIE, cookieOpts());
    invalidateAuthCache(); // this admin's other sessions may be cached under different sessionIds — clear all
    await logAudit(req, { action: "logout", resource: "session", targetId: req.admin.id, after: { allSessions: true } });
    res.json({ success: true });
  } catch (err) {
    console.error("POST /auth/logout-all", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/me — session check on page load/reload. Frontend calls this
// once on mount; a 200 means "still logged in", a 401 sends to /login.
router.get("/me", requireAuth, async (req, res) => {
  res.json({ admin: req.admin });
});

// GET /auth/my-permissions — the caller's OWN permission rows, keyed by
// module. Unlike GET /permissions (Super-Admin-only, full matrix), this
// is open to any logged-in admin so the frontend can gate sidebar/buttons
// without needing Super Admin rights. Super Admin gets an empty object
// back (the frontend already treats Super Admin as fully permitted).
router.get("/my-permissions", requireAuth, async (req, res) => {
  try {
    if (req.admin.roleGroup === "Super Admin") return res.json({});
    const { Permission } = require("./permissions");
    const rows = await Permission.find({ roleTitle: req.admin.roleTitle }).lean();
    const byModule = {};
    for (const r of rows) {
      byModule[r.module] = { canRead: !!r.canRead, canWrite: !!r.canWrite };
    }
    res.json(byModule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/forgot-password — issue a one-time reset token.
// In production this token would be emailed; here it's returned directly
// so the flow is usable without an email provider wired up yet.
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email is required" });

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() }).lean();
    // Always respond success-shaped to avoid leaking which emails exist.
    if (!admin) return res.json({ success: true });

    const token = crypto.randomBytes(24).toString("hex");
    await ResetToken.create({
      token,
      adminId: admin.id,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min
    });

    // Send the reset link by email. If SMTP isn't configured yet,
    // sendResetPasswordEmail() logs a warning and resolves quietly rather
    // than throwing, so this route still returns success either way.
    const { sent } = await sendResetPasswordEmail(admin.email, token);
    if (!sent) {
      console.log(`[password reset] SMTP not configured — token for ${admin.email}: ${token}`);
    }
    await logAudit(req, {
      action: "update",
      resource: "session",
      targetId: admin.id,
      adminOverride: safeAdmin(admin),
      after: { event: "forgot_password_requested" },
    });
    res.json({ success: true, ...(process.env.NODE_ENV !== "production" ? { token } : {}) });
  } catch (err) {
    console.error("POST /auth/forgot-password", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/reset-password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: "token and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const record = await ResetToken.findOne({ token });
    if (!record || record.used || record.expiresAt < new Date()) {
      return res.status(400).json({ error: "Reset link is invalid or expired" });
    }

    const admin = await Admin.findOne({ id: record.adminId });
    if (!admin) return res.status(400).json({ error: "Account not found" });

    admin.password = await bcrypt.hash(newPassword, 10);
    await admin.save();

    record.used = true;
    await record.save();

    // Reset should invalidate existing sessions for safety.
    await Session.deleteMany({ adminId: admin.id });

    await logAudit(req, {
      action: "update",
      resource: "session",
      targetId: admin.id,
      adminOverride: safeAdmin(admin),
      after: { event: "password_reset_completed" },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("POST /auth/reset-password", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /auth/me — update own profile (name/phone/photo only — not role/email)
router.patch("/me", requireAuth, async (req, res) => {
  try {
    const { name, phone, photo } = req.body;
    const admin = await Admin.findOne({ id: req.admin.id });
    if (!admin) return res.status(404).json({ error: "Account not found" });
    const before = safeAdmin(admin);

    if (name !== undefined) admin.name = name;
    if (phone !== undefined) admin.phone = phone;
    if (photo !== undefined) admin.photo = photo;
    await admin.save();

    const after = safeAdmin(admin);
    await logAudit(req, { action: "update", resource: "admins", targetId: admin.id, before, after });
    res.json({ admin: after });
  } catch (err) {
    console.error("PATCH /auth/me", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /auth/change-password — while logged in, requires current password
router.patch("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const admin = await Admin.findOne({ id: req.admin.id });
    const valid = await bcrypt.compare(currentPassword, admin.password);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

    admin.password = await bcrypt.hash(newPassword, 10);
    admin.mustResetPassword = false;
    await admin.save();

    await logAudit(req, { action: "update", resource: "session", targetId: admin.id, after: { event: "password_changed" } });

    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /auth/change-password", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   ADMIN MANAGEMENT (Super Admin only)
───────────────────────────────────────── */

// GET /auth/admins — Super Admin sees every account (optionally filtered
// by ?venueId= for the venue switcher). A mid-tier admin who can manage
// staff (CREATABLE_TITLES) instead sees only accounts at their own venue
// whose roleTitle is one they're permitted to create/delete — i.e. the
// same set the Staffs page account-creation control should offer.
router.get("/admins", requireAuth, requireCanManageStaff, async (req, res) => {
  try {
    let filter = {};
    if (req.admin.roleGroup === "Super Admin") {
      if (req.query.venueId) filter.venueId = req.query.venueId;
    } else {
      filter = {
        venueId: req.admin.venueId,
        roleTitle: { $in: CREATABLE_TITLES[req.admin.roleTitle] || [] },
      };
    }
    const admins = await Admin.find(filter).lean();

    // Enrich each account with its linked staff record's HR job title,
    // so the Login Accounts list can show which staff member (and what
    // they actually do day-to-day) an account belongs to — see also
    // GET /staff-auth/unlinked-staff for the reverse view (staff with no
    // account yet).
    const staffIds = admins.map((a) => a.staffId).filter(Boolean);
    const staffRecords = staffIds.length > 0 ? await getStaffModel().find({ id: { $in: staffIds } }).lean() : [];
    const staffById = new Map(staffRecords.map((s) => [s.id, s]));

    res.json(
      admins.map((a) => {
        const safe = safeAdmin(a);
        const staff = staffById.get(a.staffId);
        return { ...safe, staffName: staff?.name || null, staffJobRole: staff?.role || null };
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/unlinked-staff — staff records at the caller's scope that
// don't yet have a login account, for the "Create Account" flow's staff
// picker (so every account is created FROM an existing staff record
// instead of a free-typed name/email, per the "every account holder
// must be a staff member" requirement).
router.get("/unlinked-staff", requireAuth, requireCanManageStaff, async (req, res) => {
  try {
    const staffFilter = {};
    if (req.admin.roleGroup !== "Super Admin") {
      staffFilter.venueId = req.admin.venueId;
    } else if (req.query.venueId) {
      staffFilter.venueId = req.query.venueId;
    }
    const [allStaff, linkedAdmins] = await Promise.all([
      getStaffModel().find(staffFilter).lean(),
      Admin.find({ staffId: { $ne: null } }).select("staffId").lean(),
    ]);
    const linkedIds = new Set(linkedAdmins.map((a) => a.staffId));
    const unlinked = allStaff.filter((s) => !linkedIds.has(s.id));
    res.json(unlinked.map((s) => ({ id: s.id, name: s.name, role: s.role, venueId: s.venueId })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /auth/admins/:id — Super Admin edits anyone's role/status/venue
router.patch("/admins/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
  try {
    const { roleGroup, roleTitle, status, venueId } = req.body;
    const admin = await Admin.findOne({ id: req.params.id });
    if (!admin) return res.status(404).json({ error: "Account not found" });
    const before = safeAdmin(admin);

    if (roleGroup && roleTitle) {
      if (!isValidRolePair(roleGroup, roleTitle)) {
        return res.status(400).json({ error: "roleTitle does not belong to roleGroup" });
      }
      admin.roleGroup = roleGroup;
      admin.roleTitle = roleTitle;
      // Super Admin is always global; demoting out of Super Admin without
      // a venueId in the same request would strand the account with no
      // venue, so require one unless they're staying/becoming Super Admin.
      if (roleGroup === "Super Admin") {
        admin.venueId = null;
      } else if (!venueId && !admin.venueId) {
        return res.status(400).json({ error: "venueId is required when assigning a non-Super-Admin role" });
      }
    }
    if (venueId !== undefined) {
      if (admin.roleGroup === "Super Admin" && venueId) {
        return res.status(400).json({ error: "Super Admin accounts must remain venue-less (global)" });
      }
      if (venueId) {
        const { Venue } = require("./venues");
        const venue = await Venue.findOne({ id: venueId }).lean();
        if (!venue) return res.status(400).json({ error: "venueId does not match an existing venue" });
      }
      admin.venueId = venueId || null;
    }
    if (status) admin.status = status;
    await admin.save();

    const after = safeAdmin(admin);
    invalidateAuthCache(); // role/status/venue changed — any cached session for this admin is now stale
    await logAudit(req, { action: "update", resource: "admins", targetId: admin.id, before, after });
    res.json({ admin: after });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /auth/admins/:id — Super Admin can delete anyone. A mid-tier
// admin (Chef, Service Manager, Captain) may only delete an account that
// (a) is at their own venue and (b) has a roleTitle they're permitted to
// create, per canCreateRoleTitle — i.e. strictly-lower-in-hierarchy staff.
router.delete("/admins/:id", requireAuth, requireCanManageStaff, async (req, res) => {
  try {
    const before = await Admin.findOne({ id: req.params.id }).lean();
    if (!before) return res.status(404).json({ error: "Account not found" });

    if (req.admin.roleGroup !== "Super Admin") {
      if (before.venueId !== req.admin.venueId || !canCreateRoleTitle(req.admin, before.roleTitle)) {
        return res.status(403).json({ error: "You are not permitted to delete this account" });
      }
    }

    await Admin.deleteOne({ id: req.params.id });
    await Session.deleteMany({ adminId: req.params.id });
    invalidateAuthCache();
    await logAudit(req, { action: "delete", resource: "admins", targetId: req.params.id, before: safeAdmin(before) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   VISIBLE STAFF — profile-visibility scoping (Requirements 3 & 4)
   Returns the admins a given logged-in admin is allowed to see:
     - Super Admin: everyone, everywhere (optionally filtered by ?venueId=)
     - Manager/Supervisor: only accounts in the SAME venue AND the SAME
       department (kitchen vs service) AND at or below their own rank.
       A supervisor never sees their manager, and neither ever sees a
       Super Admin.
───────────────────────────────────────── */
router.get("/visible-staff", requireAuth, async (req, res) => {
  try {
    const me = req.admin;
    let filter = {};

    if (me.roleGroup === "Super Admin") {
      if (req.query.venueId) filter.venueId = req.query.venueId;
      // else: no filter — see everyone across every venue
    } else {
      const myDept = departmentFor(me.roleTitle);
      const myRank = ROLE_RANK[me.roleGroup] || 0;
      // Only roleTitles that are (a) in my department and (b) my rank or
      // lower qualify. Super Admin roleTitles are never included here.
      const eligibleTitles = ALL_ROLE_TITLES.filter((title) => {
        if (departmentFor(title) !== myDept) return false;
        const groupOfTitle = Object.entries(ROLE_TREE).find(([, titles]) => titles.includes(title))[0];
        return (ROLE_RANK[groupOfTitle] || 0) <= myRank;
      });
      filter = { venueId: me.venueId, roleTitle: { $in: eligibleTitles } };
    }

    const admins = await Admin.find(filter).lean();
    res.json(admins.map(safeAdmin));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   TODOS  (per-admin, filterable by period — Phase-4 item 7)
───────────────────────────────────────── */
const todoRouter = express.Router();

// GET /todos?period=daily|weekly|monthly&status=pending|done
todoRouter.get("/", requireAuth, async (req, res) => {
  try {
    const { period, status } = req.query;
    const filter = { adminId: req.admin.id };
    if (period) filter.period = period;
    if (status) filter.status = status;
    const todos = await Todo.find(filter).sort({ createdAt: -1 }).lean();
    res.json(todos.map((t) => ({ ...t, _id: undefined })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

todoRouter.post("/", requireAuth, async (req, res) => {
  try {
    const { title, notes, period, dueDate } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });
    const todo = await Todo.create({
      id: newId("todo"),
      adminId: req.admin.id,
      title,
      notes: notes || "",
      period: period || "daily",
      dueDate: dueDate || "",
    });
    res.status(201).json(todo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

todoRouter.patch("/:id", requireAuth, async (req, res) => {
  try {
    const todo = await Todo.findOne({ id: req.params.id, adminId: req.admin.id });
    if (!todo) return res.status(404).json({ error: "Todo not found" });

    const { title, notes, period, dueDate, status } = req.body;
    if (title !== undefined) todo.title = title;
    if (notes !== undefined) todo.notes = notes;
    if (period !== undefined) todo.period = period;
    if (dueDate !== undefined) todo.dueDate = dueDate;
    if (status !== undefined) {
      todo.status = status;
      todo.completedAt = status === "done" ? new Date() : null;
    }
    await todo.save();
    res.json(todo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

todoRouter.delete("/:id", requireAuth, async (req, res) => {
  try {
    await Todo.deleteOne({ id: req.params.id, adminId: req.admin.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  todoRouter,
  requireAuth,
  requireRole,
  requireMinRank,
  requireCanManageStaff,
  canCreateRoleTitle,
  CREATABLE_TITLES,
  ROLE_TREE,
  ROLE_RANK,
  DEPARTMENT_BY_ROLE_TITLE,
  departmentFor,
  Admin,
  Session,
  Todo,
  invalidateAuthCache,
  ensureAdminsHaveStaffRecords,
};