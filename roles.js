/**
 * roles.js — Sam Cafe "Roles" registry (Roles and Responsibilities page)
 *
 * This is now the single source of truth for role labels shown anywhere
 * in the admin panel — the Permissions "all roles" filter, the Staffs
 * page login-role dropdown, and any other role picker all read from
 * GET /roles instead of a hardcoded list. Adding or deleting a role here
 * reflects immediately in every one of those dropdowns.
 *
 * Seeded on first boot with the seven roles used throughout Sam Cafe:
 * General Manager, Proprietor, Chef, Sous Chef, Service Manager,
 * Captain, Supervisor. A Super Admin can rename, describe, add to, or
 * delete from this list at any time via the Roles tab.
 *
 * `roleGroup` links an entry back to the fixed ROLE_TREE rank
 * (Supervisor / Manager / Super Admin) used by auth.js for the actual
 * login/permission hierarchy, when the title matches one of the six
 * structural roleTitles (Sous Chef, Captain, Service Manager, Chef,
 * General Manager, Proprietor). Entries that don't match a structural
 * roleTitle (e.g. a purely descriptive "Supervisor" entry, which is a
 * rank name rather than a roleTitle in ROLE_TREE) simply have
 * roleGroup: null — they display fine everywhere but can't be used to
 * log an account in directly, since there's no matching auth roleTitle.
 *
 * Read is open to any logged-in admin (dropdowns need this everywhere,
 * not just on the Staffs page); write is Super Admin only.
 */

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();

const roleEntrySchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    title: { type: String, required: true, trim: true }, // e.g. "Sous Chef"
    responsibilities: { type: String, default: "", trim: true },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

const RoleEntry = mongoose.model("RoleEntry", roleEntrySchema, "roleEntries");

// Default seed — matches auth.js ROLE_TREE's six structural titles, plus
// "Supervisor" (the rank name covering Sous Chef + Captain) so it's
// visible as a role reference on the page even though it isn't itself a
// loginable roleTitle.
const DEFAULT_ROLES = [
  { title: "General Manager", responsibilities: "Oversees overall restaurant operations across all departments and branches; ultimate operational authority alongside the Proprietor." },
  { title: "Proprietor", responsibilities: "Restaurant owner; full authority over business, staffing, and financial decisions." },
  { title: "Chef", responsibilities: "Leads the kitchen — menu execution, food quality, and kitchen staff supervision, including Sous Chef." },
  { title: "Sous Chef", responsibilities: "Second-in-command in the kitchen; assists the Chef and manages kitchen operations in their absence." },
  { title: "Service Manager", responsibilities: "Oversees front-of-house service, staffing, and guest experience across Captain and Supervisor-level staff." },
  { title: "Captain", responsibilities: "Leads a service section or shift; supervises Supervisor-level floor staff and coordinates guest service." },
  { title: "Supervisor", responsibilities: "Floor-level supervisory role overseeing day-to-day service or kitchen tasks; rank shared by Sous Chef and Captain." },
];

/** Ensures the default roles exist — run once on server startup. Safe to
 * call repeatedly; only inserts titles that don't already exist, so a
 * Super Admin's edits/deletes are never overwritten on restart. */
async function ensureDefaultRoles() {
  try {
    const existingTitles = new Set((await RoleEntry.find().select("title").lean()).map((r) => r.title));
    const missing = DEFAULT_ROLES.filter((r) => !existingTitles.has(r.title));
    if (missing.length === 0) return;
    await RoleEntry.insertMany(
      missing.map((r) => ({
        id: `role_seed_${r.title.toLowerCase().replace(/\s+/g, "_")}`,
        title: r.title,
        responsibilities: r.responsibilities,
        createdBy: null,
      }))
    );
    console.log(`Seeded ${missing.length} default role(s).`);
  } catch (err) {
    console.error("Failed to seed default roles:", err.message);
  }
}

// Job-title labels removed per admin request — no longer valid HR job
// titles shown next to a staff member's name. retireRemovedRoles() below
// "Chef" is intentionally NOT deleted from the Roles and Responsibilities
// registry itself — it's also one of the six structural login roleTitles
// in auth.js's ROLE_TREE, required for the permission system to function.
const REMOVED_REGISTRY_TITLES = ["Biller", "Receptionist", "Assistant Chef", "Cleaner"];

/** One-time migration — run on server startup, after ensureDefaultRoles().
 * Deletes any roleEntries doc matching REMOVED_REGISTRY_TITLES (never
 * "Chef" — see note above). Staff records that still carry a retired job
 * title as their free-text `role` are left untouched — they're no longer
 * auto-reassigned to a fallback title, so an admin can correct each one
 * deliberately from the Staffs page instead of it silently changing.
 * Idempotent — a repeat run finds nothing left to change and is a no-op. */
async function retireRemovedRoles() {
  try {
    const del = await RoleEntry.deleteMany({ title: { $in: REMOVED_REGISTRY_TITLES } });
    if (del.deletedCount) console.log(`Removed ${del.deletedCount} retired role registry entr(y/ies).`);
  } catch (err) {
    console.error("Failed to retire removed roles:", err.message);
  }
}

function newRoleId() {
  return `role_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function safeRole(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  return obj;
}

/* ─────────────────────────────────────────
   ROUTES — Mounted at /roles.
───────────────────────────────────────── */
function buildRouter({ requireAuth, requireRole, logAudit }) {
  // GET /roles — any logged-in admin. This is the single source every
  // role dropdown in the admin panel should read from.
  router.get("/", requireAuth, async (_req, res) => {
    try {
      const entries = await RoleEntry.find().sort({ title: 1 }).lean();
      res.json(entries.map(safeRole));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { title, responsibilities } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: "title is required" });
      const dup = await RoleEntry.findOne({ title: title.trim() }).lean();
      if (dup) return res.status(409).json({ error: "A role with this title already exists" });
      const entry = await RoleEntry.create({
        id: newRoleId(),
        title: title.trim(),
        responsibilities: responsibilities || "",
        createdBy: req.admin.id,
      });
      const result = safeRole(entry);
      logAudit(req, { action: "create", resource: "roles", targetId: result.id, after: result });
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const before = await RoleEntry.findOne({ id: req.params.id }).lean();
      if (!before) return res.status(404).json({ error: "Role entry not found" });
      const { title, responsibilities } = req.body;
      const update = {};
      if (title !== undefined) update.title = title.trim();
      if (responsibilities !== undefined) update.responsibilities = responsibilities;
      const entry = await RoleEntry.findOneAndUpdate({ id: req.params.id }, { $set: update }, { returnDocument: "after" }).lean();
      const result = safeRole(entry);
      logAudit(req, { action: "update", resource: "roles", targetId: result.id, before: safeRole(before), after: result });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const before = await RoleEntry.findOneAndDelete({ id: req.params.id }).lean();
      if (!before) return res.status(404).json({ error: "Role entry not found" });
      logAudit(req, { action: "delete", resource: "roles", targetId: req.params.id, before: safeRole(before) });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter, RoleEntry, safeRole, ensureDefaultRoles, retireRemovedRoles, DEFAULT_ROLES };