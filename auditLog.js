/**
 * auditLog.js — Sam Cafe Phase-4 Audit Logging
 *
 * Records every create/update/delete write across every collection,
 * plus login/logout events, so a Super Admin can answer "who did
 * what, and when." Writes are best-effort and never block or fail
 * the original request — logAudit() swallows its own errors.
 *
 * A capped-ish retention isn't enforced here (Mongo capped collections
 * can't be indexed the way we need for filtering), but a TTL index is
 * applied so entries age out automatically after a year, keeping the
 * collection from growing unbounded.
 */

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();

const auditLogSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    adminId: { type: String, default: null },
    adminName: { type: String, default: "" },
    adminRoleTitle: { type: String, default: "" },
    venueId: { type: String, default: null },
    action: { type: String, enum: ["login", "logout", "login_failed", "create", "update", "delete"], required: true },
    resource: { type: String, required: true }, // collection/module name, or "session"
    targetId: { type: String, default: "" },
    before: { type: mongoose.Schema.Types.Mixed, default: undefined },
    after: { type: mongoose.Schema.Types.Mixed, default: undefined },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 }); // 1 year retention
auditLogSchema.index({ adminId: 1, createdAt: -1 });
auditLogSchema.index({ resource: 1, createdAt: -1 });
auditLogSchema.index({ venueId: 1, createdAt: -1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema, "auditLogs");

function newAuditId() {
  return `audit_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

/** Redact obviously sensitive fields before persisting a before/after snapshot. */
function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of ["password", "passwordHash", "token"]) {
    if (key in clone) clone[key] = "[redacted]";
  }
  return clone;
}

/**
 * logAudit(req, { action, resource, targetId, before, after })
 * `req` is expected to carry req.admin (from requireAuth) when available;
 * falls back gracefully for pre-auth events like failed logins.
 */
async function logAudit(req, { action, resource, targetId = "", before, after, adminOverride } = {}) {
  try {
    const admin = adminOverride || req.admin || null;
    await AuditLog.create({
      id: newAuditId(),
      adminId: admin ? admin.id : null,
      adminName: admin ? admin.name : "",
      adminRoleTitle: admin ? admin.roleTitle : "",
      venueId: admin ? admin.venueId || null : null,
      action,
      resource,
      targetId: String(targetId || ""),
      before: before !== undefined ? redact(before) : undefined,
      after: after !== undefined ? redact(after) : undefined,
      ip: req.ip || "",
      userAgent: (req.headers && req.headers["user-agent"]) || "",
    });
  } catch (err) {
    console.error("[auditLog] failed to record entry:", err.message);
  }
}

/* ─────────────────────────────────────────
   ROUTES — Super Admin only. Mounted at /audit-logs.
───────────────────────────────────────── */
function buildRouter({ requireAuth, requireRole }) {
  // GET /audit-logs?adminId=&resource=&venueId=&action=&from=&to=&limit=&page=
  router.get("/", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { adminId, resource, venueId, action, status, from, to, fromTime, toTime, who, target } = req.query;
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

      const filter = {};
      if (adminId) filter.adminId = adminId;
      if (resource) filter.resource = { $regex: resource, $options: "i" };
      if (venueId) filter.venueId = venueId;
      if (action) filter.action = action;
      // "status" is a coarser success/failure split over action, distinct
      // from the exact action filter above (matches the positive/negative
      // badge shown in the UI).
      if (status === "negative") filter.action = { $in: ["delete", "login_failed"] };
      else if (status === "positive") filter.action = { $nin: ["delete", "login_failed"] };
      if (who) filter.adminName = { $regex: who, $options: "i" };
      if (target) filter.targetId = { $regex: target, $options: "i" };
      if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(`${to}T23:59:59.999`);
      }
      // Time-of-day filtering ("HH:MM") cuts across dates, so it can't be
      // expressed as a simple Mongo range on createdAt. When either bound
      // is present, pull the date-filtered set into memory, filter by
      // local time-of-day, then paginate the result ourselves.
      let logs, total;
      if (fromTime || toTime) {
        const all = await AuditLog.find(filter).sort({ createdAt: -1 }).lean();
        const inTimeRange = (d) => {
          const hh = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          const t = `${hh}:${mm}`;
          if (fromTime && t < fromTime) return false;
          if (toTime && t > toTime) return false;
          return true;
        };
        const matched = all.filter((l) => inTimeRange(new Date(l.createdAt)));
        total = matched.length;
        logs = matched.slice((page - 1) * limit, (page - 1) * limit + limit);
      } else {
        [logs, total] = await Promise.all([
          AuditLog.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
          AuditLog.countDocuments(filter),
        ]);
      }

      res.json({
        logs: logs.map((l) => ({ ...l, _id: undefined })),
        total,
        page,
        limit,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /audit-logs/:id — single entry, used by the audit log details page.
  router.get("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const log = await AuditLog.findOne({ id: req.params.id }).lean();
      if (!log) return res.status(404).json({ error: "Audit log entry not found" });
      res.json({ ...log, _id: undefined });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter, AuditLog, logAudit };
