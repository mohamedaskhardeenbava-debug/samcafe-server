/**
 * venues.js — Sam Cafe Phase-4 Venue (Branch) Module
 *
 * A "venue" is a physical branch of the restaurant. Every piece of
 * operational data (staff, orders, KMS/SMS activity, menus, bookings,
 * etc.) belongs to exactly one venue via a `venueId` field, giving each
 * branch its own isolated slice of data. Super Admins are the only
 * accounts without a venueId — they're global and can see/manage every
 * venue.
 *
 * Only Super Admins may create, edit, or delete venues. Any logged-in
 * admin may list venues (needed to render names/labels, and for the
 * Super Admin venue switcher).
 */

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();

/* ─────────────────────────────────────────
   SCHEMA
───────────────────────────────────────── */
const venueSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    name: { type: String, required: true, trim: true }, // branch name
    address: { type: String, required: true, trim: true }, // branch address
    area: { type: String, required: true, trim: true }, // generalized location / branch area
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    createdBy: { type: String, default: null }, // admin id
  },
  { timestamps: true, versionKey: false }
);

const Venue = mongoose.model("Venue", venueSchema, "venues");

function newVenueId() {
  return `venue_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function safeVenue(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  return obj;
}

/* ─────────────────────────────────────────
   ROUTES
   Mounted at /venues in server.js. Guards (requireAuth, requireRole)
   are injected from auth.js/server.js at mount time to avoid a
   circular require between auth.js and venues.js.
───────────────────────────────────────── */
function buildRouter({ requireAuth, requireRole, logAudit }) {
  // GET /venues/public — minimal, unauthenticated list (id + name only) so
  // the pre-login Signup form can offer a venue picker. Deliberately omits
  // address/area/status to avoid leaking internal details publicly.
  router.get("/public", async (_req, res) => {
    try {
      const venues = await Venue.find({ status: "active" }).select("id name").lean();
      res.json(venues.map((v) => ({ id: v.id, name: v.name })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /venues — any logged-in admin (needed for labels + venue switcher)
  router.get("/", requireAuth, async (_req, res) => {
    try {
      const venues = await Venue.find().sort({ name: 1 }).lean();
      res.json(venues.map(safeVenue));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /venues/:id
  router.get("/:id", requireAuth, async (req, res) => {
    try {
      const venue = await Venue.findOne({ id: req.params.id }).lean();
      if (!venue) return res.status(404).json({ error: "Venue not found" });
      res.json(safeVenue(venue));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /venues — Super Admin only
  router.post("/", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { name, address, area } = req.body;
      if (!name || !address || !area) {
        return res.status(400).json({ error: "name, address, and area are required" });
      }
      const venue = await Venue.create({
        id: newVenueId(),
        name,
        address,
        area,
        createdBy: req.admin.id,
      });
      const result = safeVenue(venue);
      await logAudit(req, { action: "create", resource: "venues", targetId: result.id, after: result });
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /venues/:id — Super Admin only
  router.patch("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const before = await Venue.findOne({ id: req.params.id }).lean();
      if (!before) return res.status(404).json({ error: "Venue not found" });

      const { name, address, area, status } = req.body;
      const update = {};
      if (name !== undefined) update.name = name;
      if (address !== undefined) update.address = address;
      if (area !== undefined) update.area = area;
      if (status !== undefined) update.status = status;

      const venue = await Venue.findOneAndUpdate(
        { id: req.params.id },
        { $set: update },
        { returnDocument: "after" }
      ).lean();
      const result = safeVenue(venue);
      await logAudit(req, {
        action: "update",
        resource: "venues",
        targetId: result.id,
        before: safeVenue(before),
        after: result,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /venues/:id — Super Admin only. Blocked if any admin/staff is
  // still assigned to this venue, to avoid orphaning accounts.
  router.delete("/:id", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { Admin } = require("./auth");
      const stillInUse = await Admin.exists({ venueId: req.params.id });
      if (stillInUse) {
        return res.status(409).json({
          error: "Cannot delete a venue that still has staff assigned to it. Reassign them first.",
        });
      }
      const before = await Venue.findOneAndDelete({ id: req.params.id }).lean();
      if (!before) return res.status(404).json({ error: "Venue not found" });
      await logAudit(req, { action: "delete", resource: "venues", targetId: req.params.id, before: safeVenue(before) });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter, Venue, safeVenue, newVenueId };
