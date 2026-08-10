/**
 * workPlan.js — Sam Cafe "Work Plan" (Dashboard → Work Plan tab)
 *
 * Upcoming meetings and work-schedule items for the Super Admin. Visible
 * and editable only by Super Admin accounts — every route requires
 * requireRole("Super Admin"), and every item is scoped to the calling
 * admin's own id (adminId), so even if two different Super Admin
 * accounts exist (e.g. General Manager and Proprietor), each sees only
 * their own plan, not each other's.
 *
 * Deliberately its own small collection rather than reusing the generic
 * ARRAY_COLLECTIONS venue-scoped pattern in server.js — a work plan
 * entry belongs to a person, not a branch, and Super Admin isn't
 * pinned to one venue.
 */

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();

const workPlanItemSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    adminId: { type: String, required: true }, // owner — a Super Admin account's id
    title: { type: String, required: true, trim: true },
    notes: { type: String, default: "", trim: true },
    type: { type: String, enum: ["meeting", "task"], default: "meeting" },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    time: { type: String, default: "" }, // "HH:MM", optional (all-day if blank)
    location: { type: String, default: "", trim: true }, // room, branch, or video-call link
    status: { type: String, enum: ["upcoming", "done", "cancelled"], default: "upcoming" },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

const WorkPlanItem = mongoose.model("WorkPlanItem", workPlanItemSchema, "workPlanItems");

function newItemId() {
  return `wp_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function safeItem(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  return obj;
}

/* ─────────────────────────────────────────
   ROUTES — Mounted at /work-plan. Super Admin only, scoped to the
   caller's own adminId.
───────────────────────────────────────── */
function buildRouter({ requireAuth, requireRole, logAudit }) {
  // GET /work-plan?status=upcoming|done|cancelled&from=YYYY-MM-DD&to=YYYY-MM-DD
  router.get("/", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { status, from, to } = req.query;
      const filter = { adminId: req.admin.id };
      if (status) filter.status = status;
      if (from || to) {
        filter.date = {};
        if (from) filter.date.$gte = from;
        if (to) filter.date.$lte = to;
      }
      const items = await WorkPlanItem.find(filter).sort({ date: 1, time: 1 }).lean();
      res.json(items.map(safeItem));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { title, notes, type, date, time, location } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: "title is required" });
      if (!date) return res.status(400).json({ error: "date is required" });
      const item = await WorkPlanItem.create({
        id: newItemId(),
        adminId: req.admin.id,
        title: title.trim(),
        notes: notes || "",
        type: type === "task" ? "task" : "meeting",
        date,
        time: time || "",
        location: location || "",
      });
      const result = safeItem(item);
      await logAudit(req, { action: "create", resource: "workPlan", targetId: result.id, after: result });
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const item = await WorkPlanItem.findOne({ id: req.params.id, adminId: req.admin.id });
      if (!item) return res.status(404).json({ error: "Work plan item not found" });
      const before = safeItem(item.toObject());

      const { title, notes, type, date, time, location, status } = req.body;
      if (title !== undefined) item.title = title.trim();
      if (notes !== undefined) item.notes = notes;
      if (type !== undefined) item.type = type === "task" ? "task" : "meeting";
      if (date !== undefined) item.date = date;
      if (time !== undefined) item.time = time;
      if (location !== undefined) item.location = location;
      if (status !== undefined) item.status = status;
      await item.save();

      const result = safeItem(item);
      await logAudit(req, { action: "update", resource: "workPlan", targetId: result.id, before, after: result });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const before = await WorkPlanItem.findOneAndDelete({ id: req.params.id, adminId: req.admin.id }).lean();
      if (!before) return res.status(404).json({ error: "Work plan item not found" });
      await logAudit(req, { action: "delete", resource: "workPlan", targetId: req.params.id, before: safeItem(before) });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter, WorkPlanItem, safeItem };
