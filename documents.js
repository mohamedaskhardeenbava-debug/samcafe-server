/**
 * documents.js — Sam Cafe Phase-4 Documents Module
 *
 * Tracks compliance/licensing documents (FSSAI, Sanitary Inspection,
 * Food Inspection, Fire Inspection, GST, etc.) with a reminder date so
 * renewals aren't missed. Every route is Super Admin only — this isn't
 * a per-venue-permission module like the generic ARRAY_COLLECTIONS
 * routes, it's a fixed, hardcoded role gate, same as venues.js/
 * auditLog.js.
 *
 * The uploaded file is stored as a base64 data URL in `fileData` (same
 * convention already used for dish/ingredient/profile images
 * elsewhere in this codebase) plus its original name/mime type, so no
 * separate file-storage service is required.
 */

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();

const DEPARTMENTS = ["FSSAI", "Sanitary Inspection", "Food Inspection", "Fire Inspection", "GST"];

/* ─────────────────────────────────────────
   SCHEMA
───────────────────────────────────────── */
const documentSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    name: { type: String, required: true, trim: true },
    department: { type: String, required: true, enum: DEPARTMENTS },
    date: { type: String, required: true }, // issue/filed date, "YYYY-MM-DD"
    reminderDate: { type: String, default: "" }, // "YYYY-MM-DD", optional
    fileName: { type: String, default: "" },
    fileType: { type: String, default: "" },
    fileData: { type: String, default: "" }, // base64 data URL
    venueId: { type: String, default: null },
    createdBy: { type: String, default: null }, // admin id
  },
  { timestamps: true, versionKey: false }
);

const Document = mongoose.model("Document", documentSchema, "documents");

function newDocumentId() {
  return `doc_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function safeDocument(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  return obj;
}

/* ─────────────────────────────────────────
   ROUTES — Super Admin only. Mounted at /documents.
───────────────────────────────────────── */
function buildRouter({ requireAuth, requireRole, logAudit }) {
  // GET /documents — list, newest first
  router.get("/", requireAuth, requireRole("Super Admin"), async (_req, res) => {
    try {
      const docs = await Document.find().sort({ createdAt: -1 }).lean();
      res.json(docs.map(safeDocument));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /documents/:id
  router.get("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const doc = await Document.findOne({ id: req.params.id }).lean();
      if (!doc) return res.status(404).json({ error: "Document not found" });
      res.json(safeDocument(doc));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /documents
  router.post("/", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { name, department, date, reminderDate, fileName, fileType, fileData, venueId } = req.body;
      if (!name || !department || !date) {
        return res.status(400).json({ error: "name, department, and date are required" });
      }
      if (!DEPARTMENTS.includes(department)) {
        return res.status(400).json({ error: `department must be one of: ${DEPARTMENTS.join(", ")}` });
      }
      const doc = await Document.create({
        id: req.body.id || newDocumentId(),
        name,
        department,
        date,
        reminderDate: reminderDate || "",
        fileName: fileName || "",
        fileType: fileType || "",
        fileData: fileData || "",
        venueId: venueId || null,
        createdBy: req.admin.id,
      });
      const result = safeDocument(doc);
      await logAudit(req, { action: "create", resource: "documents", targetId: result.id, after: result });
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /documents/:id — full replace, used by the details page edit form
  router.put("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const before = await Document.findOne({ id: req.params.id }).lean();
      if (!before) return res.status(404).json({ error: "Document not found" });

      const { name, department, date, reminderDate, fileName, fileType, fileData, venueId } = req.body;
      if (department && !DEPARTMENTS.includes(department)) {
        return res.status(400).json({ error: `department must be one of: ${DEPARTMENTS.join(", ")}` });
      }
      const update = {};
      if (name !== undefined) update.name = name;
      if (department !== undefined) update.department = department;
      if (date !== undefined) update.date = date;
      if (reminderDate !== undefined) update.reminderDate = reminderDate;
      if (fileName !== undefined) update.fileName = fileName;
      if (fileType !== undefined) update.fileType = fileType;
      if (fileData !== undefined) update.fileData = fileData;
      if (venueId !== undefined) update.venueId = venueId;

      const doc = await Document.findOneAndUpdate(
        { id: req.params.id },
        { $set: update },
        { returnDocument: "after" }
      ).lean();
      const result = safeDocument(doc);
      await logAudit(req, {
        action: "update",
        resource: "documents",
        targetId: result.id,
        before: safeDocument(before),
        after: result,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /documents/:id
  router.delete("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const before = await Document.findOneAndDelete({ id: req.params.id }).lean();
      if (!before) return res.status(404).json({ error: "Document not found" });
      await logAudit(req, { action: "delete", resource: "documents", targetId: req.params.id, before: safeDocument(before) });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter, Document, safeDocument, newDocumentId, DEPARTMENTS };
