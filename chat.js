/**
 * chat.js — Sam Cafe Staff Chat Module
 *
 * One-to-one messaging between staff (Admin accounts) at the same
 * venue. Every logged-in admin can chat — this is deliberately NOT
 * gated behind the Super-Admin-managed Permissions matrix (like
 * Todo.js, it's a personal-productivity tool available to any
 * authenticated account, not a business-data module).
 *
 * Attachments (image / video / audio / generic file) are stored the
 * same way documents.js and dish/ingredient images already do in
 * this codebase: as a base64 data URL directly on the message doc,
 * capped at 2MB client-side and re-checked server-side. No separate
 * file-storage service required.
 *
 * A conversation between two admins is identified by a deterministic
 * "roomId" — their two ids sorted and joined with "__" — so either
 * side can always resolve the same thread without a separate
 * conversation-lookup collection.
 *
 * DELIVERY / READ STATE (single / double / coloured-double tick)
 * ----------------------------------------------------------------
 * - sent:        always true once the doc is created.
 * - deliveredAt: set the moment the recipient has an active socket
 *                connection — either immediately at send time (they're
 *                already online) or the next time they connect
 *                (chat:register in server.js calls markDelivered).
 * - readAt:      set when the recipient opens the thread
 *                (PATCH /chat/:staffId/read).
 *
 * "CLEAR FOR ME" vs "CLEAR FOR EVERYONE"
 * ----------------------------------------------------------------
 * - everyone: hard-deletes every message in the room (both sides lose
 *   history) — only really meaningful as "we both agree to wipe this".
 * - me: adds the caller's id to each message's deletedFor[] instead of
 *   deleting the row, so the other side's copy is untouched. Every read
 *   route filters deletedFor out for the calling admin.
 */

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");

const router = express.Router();

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2MB, mirrors the client-side guard

/* ─────────────────────────────────────────
   SCHEMA
───────────────────────────────────────── */
const chatMessageSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    roomId: { type: String, required: true, index: true }, // `${idA}__${idB}` sorted
    venueId: { type: String, default: null },
    fromId: { type: String, required: true },
    toId: { type: String, required: true },
    type: { type: String, enum: ["text", "image", "video", "audio", "file"], default: "text" },
    text: { type: String, default: "" },
    fileName: { type: String, default: "" },
    fileType: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
    fileData: { type: String, default: "" }, // base64 data URL
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    deletedFor: { type: [String], default: [] }, // admin ids who cleared this "for me"
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
chatMessageSchema.index({ roomId: 1, createdAt: 1 });

const ChatMessage = mongoose.model("ChatMessage", chatMessageSchema, "chatMessages");

function newMessageId() {
  return `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function roomIdFor(idA, idB) {
  return [idA, idB].sort().join("__");
}

function safeMessage(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  return obj;
}

/** Rough byte length of a base64 data URL, without decoding it fully. */
function approxDataUrlBytes(dataUrl) {
  if (!dataUrl) return 0;
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

/**
 * Called from server.js's chat:register socket handler when `adminId`
 * connects. Flips every message addressed to them (still undelivered)
 * to delivered, and returns a Map<senderId, messageIds[]> so the
 * caller can tell each sender "these were delivered".
 */
async function markDelivered(adminId) {
  const pending = await ChatMessage.find({ toId: adminId, deliveredAt: null }).select("id fromId").lean();
  if (pending.length === 0) return new Map();

  await ChatMessage.updateMany(
    { toId: adminId, deliveredAt: null },
    { $set: { deliveredAt: new Date() } }
  );

  const bySender = new Map();
  for (const m of pending) {
    if (!bySender.has(m.fromId)) bySender.set(m.fromId, []);
    bySender.get(m.fromId).push(m.id);
  }
  return bySender;
}

/**
 * Called from server.js on boot and then re-armed every 24h. Deletes
 * every chat message whose createdAt is before today's local midnight,
 * so a day's conversation history never survives past 12:00 AM the
 * next day.
 */
async function purgeMessagesBeforeToday() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const result = await ChatMessage.deleteMany({ createdAt: { $lt: startOfToday } });
  if (result.deletedCount > 0) {
    console.log(`Staff chat: purged ${result.deletedCount} message(s) from before today`);
  }
  return result.deletedCount;
}

/**
 * Schedules purgeMessagesBeforeToday to run once right at the next
 * local midnight, then every 24h after that. Call once on server boot.
 * `onPurged` (optional) is called with the deleted count after each
 * run, so the caller can notify any connected clients.
 */
function scheduleMidnightChatPurge(onPurged) {
  const runOnce = async () => {
    try {
      const deletedCount = await purgeMessagesBeforeToday();
      if (deletedCount > 0 && typeof onPurged === "function") onPurged(deletedCount);
    } catch (err) {
      console.error("Staff chat midnight purge failed:", err.message);
    }
  };

  const runAndReschedule = async () => {
    await runOnce();
    setInterval(runOnce, 24 * 60 * 60 * 1000);
  };

  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0); // next occurrence of 12:00 AM
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();
  setTimeout(runAndReschedule, msUntilMidnight);
}

/* ─────────────────────────────────────────
   ROUTES — Mounted at /chat. Any authenticated admin.
───────────────────────────────────────── */
function buildRouter({ requireAuth, logAudit, emitToAdmin, isAdminOnline }) {
  // GET /chat/staff?venueId=... — the left-sidebar list. Regular admins
  // always see their own venue; Super Admin sees whichever venue is
  // selected in the topbar switcher (falls back to every admin if none
  // given, e.g. before the switcher has loaded).
  router.get("/staff", requireAuth, async (req, res) => {
    try {
      const Admin = mongoose.model("Admin");
      const filter = { id: { $ne: req.admin.id }, status: "active" };
      if (req.admin.roleGroup === "Super Admin") {
        if (req.query.venueId) filter.venueId = req.query.venueId;
      } else {
        filter.venueId = req.admin.venueId;
      }
      const admins = await Admin.find(filter).select("id name roleTitle roleGroup venueId photo email phone").lean();

      // Last message + unread count per conversation, so the sidebar can
      // show a preview and a badge without N+1 round trips from the client.
      const roomIds = admins.map((a) => roomIdFor(req.admin.id, a.id));
      const lastMessages = await ChatMessage.aggregate([
        { $match: { roomId: { $in: roomIds }, deletedFor: { $ne: req.admin.id } } },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$roomId",
            lastText: { $first: "$text" },
            lastType: { $first: "$type" },
            lastAt: { $first: "$createdAt" },
            lastFromId: { $first: "$fromId" },
          },
        },
      ]);
      const lastByRoom = new Map(lastMessages.map((m) => [m._id, m]));

      const unreadCounts = await ChatMessage.aggregate([
        { $match: { roomId: { $in: roomIds }, toId: req.admin.id, readAt: null, deletedFor: { $ne: req.admin.id } } },
        { $group: { _id: "$roomId", count: { $sum: 1 } } },
      ]);
      const unreadByRoom = new Map(unreadCounts.map((u) => [u._id, u.count]));

      const result = admins.map((a) => {
        const roomId = roomIdFor(req.admin.id, a.id);
        const last = lastByRoom.get(roomId);
        return {
          id: a.id,
          name: a.name,
          roleTitle: a.roleTitle,
          roleGroup: a.roleGroup,
          venueId: a.venueId,
          photo: a.photo || "",
          email: a.email || "",
          phone: a.phone || "",
          lastMessage: last
            ? {
                text: last.lastType === "text" ? last.lastText : `Sent ${last.lastType === "file" ? "a file" : `a${last.lastType === "audio" ? "n" : ""} ${last.lastType}`}`,
                at: last.lastAt,
                fromMe: last.lastFromId === req.admin.id,
              }
            : null,
          unreadCount: unreadByRoom.get(roomId) || 0,
        };
      });

      // Most recently active conversations first, then alphabetical.
      result.sort((a, b) => {
        const at = a.lastMessage ? new Date(a.lastMessage.at).getTime() : 0;
        const bt = b.lastMessage ? new Date(b.lastMessage.at).getTime() : 0;
        if (at !== bt) return bt - at;
        return (a.name || "").localeCompare(b.name || "");
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /chat/:staffId — full thread with one other admin, oldest first,
  // excluding anything the caller cleared "for me".
  router.get("/:staffId", requireAuth, async (req, res) => {
    try {
      const roomId = roomIdFor(req.admin.id, req.params.staffId);
      const messages = await ChatMessage.find({ roomId, deletedFor: { $ne: req.admin.id } })
        .sort({ createdAt: 1 })
        .lean();
      res.json(messages.map(safeMessage));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /chat/:staffId — send a message (text or attachment) to another admin.
  // Also used for "share/forward" from the client — same shape, new roomId.
  router.post("/:staffId", requireAuth, async (req, res) => {
    try {
      const toId = req.params.staffId;
      if (toId === req.admin.id) {
        return res.status(400).json({ error: "Cannot message yourself" });
      }
      const Admin = mongoose.model("Admin");
      const toAdmin = await Admin.findOne({ id: toId }).lean();
      if (!toAdmin) return res.status(404).json({ error: "Staff member not found" });

      // Super Admin broadcasts/announcements are one-way: any staff
      // member can be messaged by a Super Admin, but staff cannot reply
      // back to a Super Admin. Enforced here (not just hidden in the
      // UI) since a disabled input is trivially bypassable via the API.
      if (toAdmin.roleGroup === "Super Admin" && req.admin.roleGroup !== "Super Admin") {
        return res.status(403).json({ error: "You can't reply to a Super Admin in staff chat" });
      }

      const { type, text, fileName, fileType, fileData } = req.body;
      const msgType = ["text", "image", "video", "audio", "file"].includes(type) ? type : "text";

      if (msgType === "text" && (!text || !text.trim())) {
        return res.status(400).json({ error: "text is required for a text message" });
      }
      let fileSize = 0;
      if (msgType !== "text") {
        if (!fileData) return res.status(400).json({ error: "fileData is required for an attachment" });
        fileSize = approxDataUrlBytes(fileData);
        if (fileSize > MAX_ATTACHMENT_BYTES) {
          return res.status(413).json({ error: "Attachment exceeds the 2MB limit" });
        }
      }

      const recipientOnline = typeof isAdminOnline === "function" && isAdminOnline(toId);
      const roomId = roomIdFor(req.admin.id, toId);
      const doc = await ChatMessage.create({
        id: newMessageId(),
        roomId,
        venueId: req.admin.venueId || toAdmin.venueId || null,
        fromId: req.admin.id,
        toId,
        type: msgType,
        text: msgType === "text" ? text.trim() : "",
        fileName: fileName || "",
        fileType: fileType || "",
        fileSize,
        fileData: msgType === "text" ? "" : fileData,
        deliveredAt: recipientOnline ? new Date() : null,
      });

      const result = safeMessage(doc);
      if (typeof emitToAdmin === "function") {
        emitToAdmin(toId, "chat:message", result);
        emitToAdmin(req.admin.id, "chat:message", result); // echo to sender's other tabs/devices
      }
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /chat/:staffId/read — mark every message FROM that staff member as read.
  router.patch("/:staffId/read", requireAuth, async (req, res) => {
    try {
      const roomId = roomIdFor(req.admin.id, req.params.staffId);
      const now = new Date();
      const before = await ChatMessage.find({ roomId, toId: req.admin.id, readAt: null }).select("id").lean();
      await ChatMessage.updateMany(
        { roomId, toId: req.admin.id, readAt: null },
        { $set: { readAt: now, deliveredAt: now } }
      );
      if (typeof emitToAdmin === "function" && before.length > 0) {
        emitToAdmin(req.params.staffId, "chat:read", {
          byId: req.admin.id,
          messageIds: before.map((m) => m.id),
          readAt: now,
        });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /chat/:staffId?scope=me|everyone — default "everyone" for
  // backward compatibility; the client always sends scope explicitly now.
  router.delete("/:staffId", requireAuth, async (req, res) => {
    try {
      const roomId = roomIdFor(req.admin.id, req.params.staffId);
      const scope = req.query.scope === "me" ? "me" : "everyone";

      if (scope === "everyone") {
        await ChatMessage.deleteMany({ roomId });
        if (typeof emitToAdmin === "function") {
          emitToAdmin(req.params.staffId, "chat:cleared", { byId: req.admin.id, roomId, scope });
        }
      } else {
        await ChatMessage.updateMany({ roomId }, { $addToSet: { deletedFor: req.admin.id } });
      }

      if (logAudit) {
        logAudit(req, { action: "delete", resource: "chat", targetId: roomId, before: { roomId, scope } });
      }
      res.json({ success: true, scope });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /chat/:staffId/messages — bulk-delete selected messages,
  // "for me" only (removes them from the caller's own view; the other
  // side keeps their copy, same semantics as WhatsApp's "delete for me").
  router.delete("/:staffId/messages", requireAuth, async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "ids array is required" });
      }
      const roomId = roomIdFor(req.admin.id, req.params.staffId);
      await ChatMessage.updateMany(
        { roomId, id: { $in: ids } },
        { $addToSet: { deletedFor: req.admin.id } }
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  buildRouter,
  ChatMessage,
  safeMessage,
  roomIdFor,
  markDelivered,
  purgeMessagesBeforeToday,
  scheduleMidnightChatPurge,
  MAX_ATTACHMENT_BYTES,
};
