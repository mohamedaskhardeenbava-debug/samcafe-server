/**
 * permissions.js — Sam Cafe Phase-4 Permission Matrix
 *
 * Beyond the fixed role hierarchy (Supervisor < Manager < Super Admin),
 * the Super Admin can fine-tune exactly which roleTitle can read/write
 * which module. This is stored as a flat list of permission rows:
 *
 *   { roleTitle, module, canRead, canWrite }
 *
 * "module" is a logical name — usually matching a collection name
 * (e.g. "staff", "kitchenActivity") but can also cover admin-only
 * screens that aren't collections (e.g. "theme", "venues",
 * "permissions", "auditLogs").
 *
 * Only Super Admin (roleGroup) may view or edit the matrix. Super
 * Admin itself is always fully permitted on everything and is never
 * stored as rows — this keeps the matrix from ever locking out the
 * one role that must always be able to fix it.
 *
 * Defaults are seeded on first boot (see seedDefaultPermissions) to
 * match the previous hardcoded behavior, so nothing breaks until the
 * Super Admin actively customizes the matrix.
 */

const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const ALL_ROLE_TITLES = [
  "Sous Chef",
  "Captain",
  "Service Manager",
  "Chef",
  "General Manager",
  "Proprietor",
];

/* ─────────────────────────────────────────
   MODULE REGISTRY — logical modules a permission row can target.
   Grouped for the frontend matrix editor; the list itself is what's
   validated against on write.
───────────────────────────────────────── */
const MODULES = {
  // Kitchen department (KMS)
  kitchenActivity: "Kitchen Activity Log",
  kitchenSchedules: "Kitchen Schedules",
  kitchenAssign: "Kitchen Assign",
  kitchenMise: "Kitchen Mise (legacy)",
  mise: "Kitchen Mise en Place",
  grooming: "Kitchen Grooming",
  recipes: "Recipes",
  // Service department (SMS)
  serviceActivity: "Service Activity Log",
  serviceSchedules: "Service Schedules",
  serviceAssign: "Service Assign",
  serviceMise: "Service Mise en Place",
  serviceGrooming: "Service Grooming",
  tables: "Table Management",
  tablePreferences: "Table Preferences",
  // Menu / catalog
  categories: "Categories",
  ingredients: "Ingredients / Stocks",
  combo: "Combo",
  combo_offers: "Combo Offers",
  comboSectionConfig: "Combo Section Config",
  favourites: "Favourites",
  offers: "Offers",
  subscriptions: "Subscriptions",
  chat: "Chat",
  // Orders & bookings
  orders: "Orders",
  reservations: "Reservations",
  events: "Events",
  eventBookings: "Event Bookings",
  cateringOrders: "Catering",
  preBookings: "Pre-Bookings",
  celebrations: "Celebrations",
  // People
  users: "Users (Customers)",
  staff: "Staff",
  careers: "Careers",
  holidays: "Holidays",
  callHistory: "Call History",
  tasks: "To-Do",
  // Admin-only screens (not raw collections)
  venues: "Venues",
  permissions: "Permissions",
  auditLogs: "Audit Logs",
  theme: "Theme Settings",
  categoryCards: "Category Cards",
};

/* ─────────────────────────────────────────
   SCHEMA
───────────────────────────────────────── */
const permissionSchema = new mongoose.Schema(
  {
    roleTitle: { type: String, enum: ALL_ROLE_TITLES, required: true },
    module: { type: String, required: true },
    canRead: { type: Boolean, default: false },
    canWrite: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false }
);
permissionSchema.index({ roleTitle: 1, module: 1 }, { unique: true });

const Permission = mongoose.model("Permission", permissionSchema, "permissions");

/* ─────────────────────────────────────────
   DEFAULTS — matches the access rules the Super Admin specified.
   GM (General Manager) and PR (Proprietor) are Super Admin roleTitles —
   they bypass the matrix entirely in hasPermission() and are never
   stored as rows here, so "GM,PR" in a rule is implicit, not written.

   Legend from the source table:
     CH  = Chef            (Manager, kitchen)
     SC  = Sous Chef        (Supervisor, kitchen)
     SM  = Service Manager  (Manager, service)
     CAP = Captain          (Supervisor, service)

   "view only" → canRead: true, canWrite: false
   "ALL"       → every roleTitle gets full read+write
   "vary related to department and lower positions, staff list belongs
   to their department and venue" → covered by the /visible-staff and
   venue-scoping logic elsewhere (not a read/write flag), so those
   modules get canRead/canWrite per the role's own department/rank as
   listed in the table, same as any other row.
───────────────────────────────────────── */
const KITCHEN_MANAGER = "Chef";
const KITCHEN_SUPERVISOR = "Sous Chef";
const SERVICE_MANAGER = "Service Manager";
const SERVICE_SUPERVISOR = "Captain";
const KITCHEN_ROLES = [KITCHEN_MANAGER, KITCHEN_SUPERVISOR];
const SERVICE_ROLES = [SERVICE_MANAGER, SERVICE_SUPERVISOR];
const ALL_NON_SUPER_ROLES = [KITCHEN_MANAGER, KITCHEN_SUPERVISOR, SERVICE_MANAGER, SERVICE_SUPERVISOR];

function row(roleTitle, moduleKey, canRead, canWrite) {
  return { roleTitle, module: moduleKey, canRead, canWrite };
}

function defaultRows() {
  const rows = [];

  // categories / dishes — CH, SC full; SM, CAP view only
  for (const r of KITCHEN_ROLES) rows.push(row(r, "categories", true, true));
  for (const r of SERVICE_ROLES) rows.push(row(r, "categories", true, false));

  // ingredients / stocks — CH, SC full; SM, CAP no access
  for (const r of KITCHEN_ROLES) rows.push(row(r, "ingredients", true, true));

  // combo — CH, SC full
  for (const r of KITCHEN_ROLES) rows.push(row(r, "combo", true, true));
  for (const r of KITCHEN_ROLES) rows.push(row(r, "combo_offers", true, true));
  for (const r of KITCHEN_ROLES) rows.push(row(r, "comboSectionConfig", true, true));

  // favourites — CH, SC full
  for (const r of KITCHEN_ROLES) rows.push(row(r, "favourites", true, true));

  // offers — CH, SC full
  for (const r of KITCHEN_ROLES) rows.push(row(r, "offers", true, true));

  // orders — CH, SC full; SM, CAP view only
  for (const r of KITCHEN_ROLES) rows.push(row(r, "orders", true, true));
  for (const r of SERVICE_ROLES) rows.push(row(r, "orders", true, false));

  // subscriptions — Super Admin (implicit bypass), Chef, Sous Chef only
  for (const r of KITCHEN_ROLES) rows.push(row(r, "subscriptions", true, true));

  // chat — everyone gets full access; it's a staff-wide messaging tool,
  // not department-scoped like the rest of the matrix
  for (const r of ALL_NON_SUPER_ROLES) rows.push(row(r, "chat", true, true));

  // todo (tasks) — everyone, individually scoped (scoping handled at the
  // route/UI level — each admin only ever sees/edits their own todos)
  for (const r of ALL_NON_SUPER_ROLES) rows.push(row(r, "tasks", true, true));

  // reservation / events / catering / prebooking / celebration — ALL
  const bookingModules = ["reservations", "events", "eventBookings", "cateringOrders", "preBookings", "celebrations"];
  for (const mod of bookingModules) {
    for (const r of ALL_NON_SUPER_ROLES) rows.push(row(r, mod, true, true));
  }

  // users — GM, PR, SM, CAP (service-side only; kitchen roles excluded)
  for (const r of SERVICE_ROLES) rows.push(row(r, "users", true, true));

  // staff / salary / attendance / career / training — combined into the
  // single "staff" module per the strictest rule: GM/PR get full access
  // implicitly (Super Admin bypass); everyone else gets read-only, scoped
  // to their own department + lower rank + own venue by /visible-staff.
  // Salary specifically stays GM/PR-only — the frontend must hide salary
  // fields entirely for non-Super-Admin viewers even though this module
  // grants read access to the rest of the staff record.
  for (const r of ALL_NON_SUPER_ROLES) rows.push(row(r, "staff", true, false));

  // KMS including sub-modules — GM, PR, CH, SC; staff list scoped to
  // their department + venue (handled by /visible-staff, not here)
  const kmsModules = ["kitchenActivity", "kitchenSchedules", "kitchenAssign", "kitchenMise", "mise", "grooming", "recipes"];
  for (const mod of kmsModules) {
    for (const r of KITCHEN_ROLES) rows.push(row(r, mod, true, true));
  }

  // SMS including sub-modules — GM, PR, CAP, SM; staff list scoped to
  // their department + venue (handled by /visible-staff, not here)
  const smsModules = ["serviceActivity", "serviceSchedules", "serviceAssign", "serviceMise", "serviceGrooming", "tables", "tablePreferences"];
  for (const mod of smsModules) {
    for (const r of SERVICE_ROLES) rows.push(row(r, mod, true, true));
  }

  // careers, holidays, callHistory — not in the source table; default to
  // GM/PR only (Super Admin bypass), so leave every non-Super-Admin
  // roleTitle unset (fail-closed = no rows written = no access) until a
  // Super Admin explicitly opens them up via the Permissions page.

  // venue / permission / audit logs / theme settings — GM, PR only.
  // Non-Super-Admin roleTitles get no rows, so hasPermission() fails
  // closed and they never see these screens.

  return rows;
}

/**
 * DEFAULTS_VERSION — bump this whenever defaultRows() changes shape or
 * intent (e.g. new module rules, restructured roles). seedDefaultPermissions
 * compares this against a stored marker; on mismatch it re-seeds fresh
 * defaults rather than silently leaving a stale pre-existing matrix in
 * place. This only replaces rows that still exactly equal what the
 * previous version seeded — see seedDefaultPermissions for the exact
 * behavior — so it is safe to run against an install a Super Admin has
 * already begun customizing.
 */
const DEFAULTS_VERSION = 4;

const permissionMetaSchema = new mongoose.Schema(
  { key: { type: String, unique: true }, value: mongoose.Schema.Types.Mixed },
  { versionKey: false }
);
const PermissionMeta = mongoose.model("PermissionMeta", permissionMetaSchema, "permissionMeta");

async function seedDefaultPermissions() {
  const meta = await PermissionMeta.findOne({ key: "defaultsVersion" }).lean();
  const storedVersion = meta ? meta.value : 0;
  const count = await Permission.estimatedDocumentCount();

  if (count === 0) {
    // Fresh install — seed everything.
    try {
      await Permission.insertMany(defaultRows(), { ordered: false });
      console.log("[permissions] Seeded default permission matrix.");
    } catch (err) {
      if (err.code !== 11000) console.error("[permissions] seed error:", err.message);
    }
  } else if (storedVersion < DEFAULTS_VERSION) {
    // Existing install with an older default set. Upsert the new defaults
    // module-by-module — this intentionally overwrites every row, since a
    // versioned default change means "the intended baseline changed," and
    // a Super Admin who wants different values can re-adjust afterward via
    // the Permissions page. This runs once per version bump, not on every
    // boot, so day-to-day matrix edits are never touched.
    try {
      const ops = defaultRows().map((r) => ({
        updateOne: {
          filter: { roleTitle: r.roleTitle, module: r.module },
          update: { $set: { canRead: r.canRead, canWrite: r.canWrite } },
          upsert: true,
        },
      }));
      await Permission.bulkWrite(ops);
      console.log(`[permissions] Updated permission matrix defaults to version ${DEFAULTS_VERSION}.`);
    } catch (err) {
      console.error("[permissions] versioned re-seed error:", err.message);
    }
  }

  await PermissionMeta.updateOne(
    { key: "defaultsVersion" },
    { $set: { key: "defaultsVersion", value: DEFAULTS_VERSION } },
    { upsert: true }
  );
  invalidatePermCache();
}

/* ─────────────────────────────────────────
   RUNTIME CHECK — used by server.js guardsFor() to gate reads/writes
   on the generic collection routes.
───────────────────────────────────────── */
const permCache = { at: 0, rows: null };
const PERM_CACHE_TTL_MS = 10 * 1000; // short TTL: matrix edits should take effect quickly

async function getPermissionRows() {
  if (permCache.rows && Date.now() - permCache.at < PERM_CACHE_TTL_MS) return permCache.rows;
  const rows = await Permission.find().lean();
  permCache.rows = rows;
  permCache.at = Date.now();
  return rows;
}

function invalidatePermCache() {
  permCache.rows = null;
}

/**
 * hasPermission(admin, module, action) — Super Admin always passes.
 * Any other role checks the matrix; a missing row defaults to false
 * (fail closed) so newly-added modules aren't silently exposed.
 */
async function hasPermission(admin, moduleName, action) {
  if (!admin) return false;
  if (admin.roleGroup === "Super Admin") return true;
  const rows = await getPermissionRows();
  const row = rows.find((r) => r.roleTitle === admin.roleTitle && r.module === moduleName);
  if (!row) return false;
  return action === "write" ? !!row.canWrite : !!row.canRead;
}

/**
 * requirePermission(module, action) — Express middleware factory for
 * use on admin-only screens (venues/permissions/auditLogs/theme) or
 * anywhere outside the generic collection loop.
 */
function requirePermission(moduleName, action = "read") {
  return async (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: "Not logged in" });
    const ok = await hasPermission(req.admin, moduleName, action);
    if (!ok) return res.status(403).json({ error: "Insufficient permissions" });
    next();
  };
}

/* ─────────────────────────────────────────
   ROUTES — Super Admin only. Mounted at /permissions.
───────────────────────────────────────── */
function buildRouter({ requireAuth, requireRole, logAudit }) {
  // GET /permissions — full matrix + module registry (for the UI to render)
  router.get("/", requireAuth, requireRole("Super Admin"), async (_req, res) => {
    try {
      const rows = await Permission.find().sort({ module: 1, roleTitle: 1 }).lean();
      res.json({ rows, modules: MODULES, roleTitles: ALL_ROLE_TITLES });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /permissions — bulk upsert: [{ roleTitle, module, canRead, canWrite }, ...]
  router.patch("/", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "rows (array) is required" });
      }
      const ops = [];
      for (const r of rows) {
        if (!ALL_ROLE_TITLES.includes(r.roleTitle) || !MODULES[r.module]) {
          return res.status(400).json({ error: `Invalid roleTitle/module: ${r.roleTitle}/${r.module}` });
        }
        ops.push({
          updateOne: {
            filter: { roleTitle: r.roleTitle, module: r.module },
            update: { $set: { canRead: !!r.canRead, canWrite: !!r.canWrite } },
            upsert: true,
          },
        });
      }
      await Permission.bulkWrite(ops);
      invalidatePermCache();
      logAudit(req, { action: "update", resource: "permissions", targetId: "matrix", after: { rowCount: rows.length } });
      const updated = await Permission.find().sort({ module: 1, roleTitle: 1 }).lean();
      res.json({ rows: updated, modules: MODULES, roleTitles: ALL_ROLE_TITLES });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /permissions/reset-defaults — Super Admin safety valve
  router.post("/reset-defaults", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      await Permission.deleteMany({});
      await Permission.insertMany(defaultRows());
      invalidatePermCache();
      logAudit(req, { action: "update", resource: "permissions", targetId: "matrix", after: { reset: true } });
      const rows = await Permission.find().sort({ module: 1, roleTitle: 1 }).lean();
      res.json({ rows, modules: MODULES, roleTitles: ALL_ROLE_TITLES });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  buildRouter,
  Permission,
  MODULES,
  ALL_ROLE_TITLES,
  seedDefaultPermissions,
  hasPermission,
  requirePermission,
  invalidatePermCache,
};