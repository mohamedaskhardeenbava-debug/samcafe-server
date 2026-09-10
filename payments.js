/**
 * payments.js — Sam Cafe Direct UPI QR Payment System
 *
 * Generates a standard UPI deep-link (`upi://pay?...`) for a restaurant
 * order/bill, using the UPI VPA configured in Admin → Bank Accounts (see
 * bankAccount.js). The admin panel encodes this into a QR code shown in
 * the order preview modal and printed on the receipt — no payment
 * gateway, no third-party API calls, no webhook.
 *
 * WHY THIS MODULE CANNOT AUTO-DETECT PAYMENT SUCCESS
 * -----------------------------------------------------
 * A standard UPI intent URI has no callback mechanism: once the QR is
 * scanned, the entire payment happens between the customer's UPI app and
 * their bank — this server is never involved and receives no
 * notification of any kind. This is fundamentally different from a
 * gateway integration (Cashfree/Razorpay/etc), which sits in the
 * payment path and can report back via webhook or an order-status API.
 * Without a bank/PSP integration (which is exactly what a payment
 * gateway normally provides, and what this feature is explicitly
 * avoiding), there is no way to programmatically verify a UPI
 * transaction from a plain deep-link QR.
 *
 * Given that, the ONLY honest design is: the QR shows what to pay, and a
 * human (the admin/cashier) confirms it was actually received — by
 * checking their own UPI app / bank SMS / bank statement — then clicks
 * "Mark as Paid" in the admin panel. This module's job is to make that
 * confirmation safe rather than automatic:
 *
 *   - IDEMPOTENT: confirming an already-PAID record just returns it
 *     unchanged (200, not an error) — a duplicate click, a second staff
 *     member, or a retried request can never "pay" an order twice or
 *     overwrite who/when it was confirmed.
 *   - BOUND TO ONE ORDER: the confirm route re-validates that the
 *     Payment record's own orderId matches the order id in the URL
 *     before touching anything, so a stale QR/tab for the wrong order
 *     can't accidentally mark a different order paid.
 *   - EXACT-AMOUNT STAMPED AT CREATION: the amount encoded in the QR is
 *     stored on the Payment record the moment it's created (not
 *     re-read from the order later, which could have changed via a
 *     split/edit in the meantime) — the confirm route returns this
 *     stamped amount so the admin panel can show "Confirm ₹X was
 *     received for Order #Y" right before the click, making an
 *     amount-mismatch mistake something the admin can actually see and
 *     catch, not something that fails silently.
 *   - NO SCREENSHOT UPLOAD PATH: deliberately not supported. A screenshot
 *     is trivially fabricated (even a genuine one can be reused across
 *     orders) and provides no more integrity than the admin's own
 *     judgment already does — accepting one as "proof" would create a
 *     false sense of verification without actually adding any.
 *
 * This is the same tradeoff every small merchant using a personal UPI
 * QR code already makes today — checking their own phone before
 * marking an order fulfilled. This module doesn't pretend to remove
 * that human step; it just makes the step it hands off to a human as
 * safe and hard-to-misuse as possible.
 */

const mongoose = require("mongoose");
const { BankAccount, safeBankAccount } = require("./bankAccount");

/* ─────────────────────────────────────────
   SCHEMA — one doc per UPI QR generated for a bill
───────────────────────────────────────── */
const paymentSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true }, // our own generated id, see newPaymentId()
    orderId: { type: String, required: true, index: true }, // restaurant order's id — every route below checks this
    billNo: { type: Number, default: null }, // for split bills, which bill this covers
    amount: { type: Number, required: true }, // exact amount encoded in the QR at creation time — never re-derived later
    currency: { type: String, default: "INR" },
    upiVpa: { type: String, required: true }, // VPA the QR was generated against, snapshotted at creation (see note on bankAccount.js changes)
    upiUrl: { type: String, required: true }, // the full upi://pay?... string encoded in the QR
    status: {
      type: String,
      enum: ["PENDING", "PAID"],
      default: "PENDING",
    },
    confirmedBy: { type: String, default: null }, // admin id who clicked "Mark as Paid"
    confirmedAt: { type: Date, default: null },
    venueId: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

const Payment = mongoose.model("Payment", paymentSchema, "payments");

function newPaymentId(orderId) {
  return `pay_${orderId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function safePayment(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  return obj;
}

/**
 * Builds a standard UPI deep-link URI. Every value that can contain
 * spaces or special characters is percent-encoded individually — do not
 * encode the whole string afterward, since that would double-encode the
 * `&`/`=` separators the URI itself relies on.
 *
 *   upi://pay?pa=<vpa>&pn=<payee name>&am=<amount>&cu=INR&tn=<note>&tr=<ref>
 *
 * `tr` (transaction reference) is set to our own Payment id, which is
 * unique per QR generated — this is what lets a customer's UPI app /
 * bank statement show a reference the admin could in principle look up
 * later, even though this system doesn't require them to.
 */
function buildUpiUrl({ vpa, payeeName, amount, paymentId, note }) {
  const amountStr = Number(amount).toFixed(2);
  const params = [
    `pa=${encodeURIComponent(vpa)}`,
    `pn=${encodeURIComponent(payeeName)}`,
    `am=${amountStr}`,
    `cu=INR`,
    `tn=${encodeURIComponent(note)}`,
    `tr=${encodeURIComponent(paymentId)}`,
  ];
  return `upi://pay?${params.join("&")}`;
}

/**
 * Marks the linked restaurant order's paymentStatus as "completed".
 * Best-effort: a failure here never blocks the confirm response itself,
 * since the Payment doc (the source of truth for the QR/status flow) is
 * already saved as PAID by the time this runs.
 */
async function markOrderPaid(getModel, emitChange, orderId) {
  if (!getModel || !orderId) return;
  try {
    const OrderModel = getModel("orders");
    const updated = await OrderModel.findOneAndUpdate(
      { id: orderId },
      { $set: { paymentStatus: "completed" } },
      { new: true }
    ).lean();
    if (updated) {
      delete updated._id;
      emitChange && emitChange("orders", "updated", updated);
    }
  } catch (err) {
    console.warn("Could not mark order paymentStatus completed for order", orderId, err.message);
  }
}

/* ─────────────────────────────────────────
   ROUTES. Mounted at /payments.
   Every route is any authenticated admin (cashier-level action, not
   Super-Admin-only) — same gate as the rest of the order-handling
   surface. There is no unauthenticated route in this module at all
   (unlike the old Cashfree webhook/public-status), since there is no
   external party that ever needs to call in here.
───────────────────────────────────────── */
function buildRouter({ requireAuth, logAudit, emitChange, getModel }) {
  const express = require("express");
  const router = express.Router();

  // POST /payments/orders — generate a UPI QR payment record for a bill
  router.post("/orders", requireAuth, async (req, res) => {
    try {
      const { orderId, amount, billNo } = req.body;
      if (!orderId || !(Number(amount) > 0)) {
        return res.status(400).json({ error: "orderId and a positive amount are required" });
      }

      const bankAccount = await BankAccount.findOne({ id: "singleton" }).lean();
      const upiVpa = (bankAccount?.upiVpa || "").trim();
      if (!upiVpa) {
        return res.status(503).json({
          error: "No UPI ID is configured. Add one in Admin → Bank Accounts before generating a payment QR.",
        });
      }

      const paymentId = newPaymentId(orderId);
      const roundedAmount = Math.round(Number(amount) * 100) / 100;
      const upiUrl = buildUpiUrl({
        vpa: upiVpa,
        payeeName: bankAccount?.accountHolderName || "Sam Cafe",
        amount: roundedAmount,
        paymentId,
        note: `Order ${orderId}${billNo ? ` Bill ${billNo}` : ""}`,
      });

      const doc = await Payment.create({
        id: paymentId,
        orderId,
        billNo: billNo ?? null,
        amount: roundedAmount,
        upiVpa,
        upiUrl,
        status: "PENDING",
        venueId: req.body.venueId || req.admin?.venueId || null,
        createdBy: req.admin?.id || null,
      });

      const result = safePayment(doc);
      await logAudit(req, { action: "create", resource: "payments", targetId: paymentId, after: result });
      res.status(201).json(result);
    } catch (err) {
      console.error("POST /payments/orders", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /payments/orders/:id — fetch a single payment record's current status
  router.get("/orders/:id", requireAuth, async (req, res) => {
    try {
      const local = await Payment.findOne({ id: req.params.id }).lean();
      if (!local) return res.status(404).json({ error: "Payment record not found" });
      res.json(safePayment(local));
    } catch (err) {
      console.error("GET /payments/orders/:id", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /payments/orders?orderId= — payment record(s) for a restaurant order
  router.get("/orders", requireAuth, async (req, res) => {
    try {
      const filter = {};
      if (req.query.orderId) filter.orderId = req.query.orderId;
      const docs = await Payment.find(filter).sort({ createdAt: -1 }).limit(50).lean();
      res.json(docs.map(safePayment));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /payments/orders/:id/confirm — the ONLY way a payment ever
  // becomes PAID in this system: an admin, having checked their own UPI
  // app / bank SMS / statement, explicitly confirms it. See the
  // file-level comment for why this is a deliberate manual step, and
  // the guardrails (idempotent, order-bound) built into this route.
  router.post("/orders/:id/confirm", requireAuth, async (req, res) => {
    try {
      const local = await Payment.findOne({ id: req.params.id });
      if (!local) return res.status(404).json({ error: "Payment record not found" });

      // Accidental-association guard: the caller must state which order
      // it believes it's confirming, and that must match what this
      // Payment record was actually created for. A stale QR/tab left
      // open for a different/older order can never confirm payment
      // against the wrong order this way.
      const { orderId } = req.body || {};
      if (!orderId || orderId !== local.orderId) {
        return res.status(409).json({
          error: "This payment record does not belong to the order specified. Refresh and try again.",
        });
      }

      // Idempotency guard: confirming an already-PAID record is not an
      // error — it just returns the existing (unchanged) record. This
      // means a duplicate click, a second admin confirming the same
      // bill, or a retried request after a flaky connection can never
      // overwrite who/when it was originally confirmed, and never
      // double-fires markOrderPaid or the audit log.
      if (local.status === "PAID") {
        return res.json(safePayment(local));
      }

      local.status = "PAID";
      local.confirmedBy = req.admin?.id || null;
      local.confirmedAt = new Date();
      await local.save();

      const result = safePayment(local);
      emitChange && emitChange("payments", "updated", result);
      await markOrderPaid(getModel, emitChange, local.orderId);
      await logAudit(req, { action: "update", resource: "payments", targetId: local.id, after: result });

      res.json(result);
    } catch (err) {
      console.error("POST /payments/orders/:id/confirm", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter, Payment, safePayment, buildUpiUrl };
