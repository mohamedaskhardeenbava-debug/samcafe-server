/**
 * payments.js — Sam Cafe Cashfree Payment Gateway integration
 *
 * Creates a Cashfree Order for a given restaurant order/bill amount and
 * returns a `payment_link` that the admin panel encodes into the QR shown
 * on the Orders page and the bill receipt (replacing the old static UPI
 * VPA QR in Orders.js's buildUpiUrl/StableQRCode).
 *
 * Cashfree PG API docs: https://docs.cashfree.com/reference/pg-new-apis-endpoint
 * Uses the Orders API (2023-08-01) — one Cashfree order per bill, with a
 * hosted payment_link customers can scan/pay via UPI/cards/wallets, and a
 * webhook + polling status endpoint so the admin panel can know when it's
 * actually been paid (unlike the old static UPI QR, which had no way to
 * confirm payment).
 *
 * Requires in .env:
 *   CASHFREE_APP_ID
 *   CASHFREE_SECRET_KEY
 *   CASHFREE_ENV=sandbox   (or "production")
 *   CASHFREE_WEBHOOK_SECRET  (optional but recommended — same as SECRET_KEY
 *                             unless a separate webhook secret was configured
 *                             in the Cashfree dashboard)
 */

const crypto = require("crypto");
const mongoose = require("mongoose");

const CASHFREE_ENV = (process.env.CASHFREE_ENV || "sandbox").toLowerCase();
const CASHFREE_BASE_URL =
  CASHFREE_ENV === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
const CASHFREE_API_VERSION = "2023-08-01";

// Cashfree requires order_meta.return_url to be an absolute HTTPS URL —
// it rejects plain http:// even for localhost. If PUBLIC_APP_URL isn't
// set, or is set to an http:// value, fall back to a placeholder https
// URL rather than sending something Cashfree will reject outright with
// a 400 ("url should be https"). This URL only matters if a customer
// completes payment via Cashfree's hosted page and gets redirected back
// to it — it's never visited during the QR-scan flow itself, so a
// non-reachable placeholder is safe while developing locally.
const rawPublicAppUrl = (process.env.PUBLIC_APP_URL || "").trim();
const PUBLIC_APP_URL = (
  rawPublicAppUrl && rawPublicAppUrl.startsWith("https://")
    ? rawPublicAppUrl
    : "https://samcafe.example.com"
).replace(/\/$/, "");

function cashfreeConfigured() {
  return !!(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

function cashfreeHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-version": CASHFREE_API_VERSION,
    "x-client-id": process.env.CASHFREE_APP_ID,
    "x-client-secret": process.env.CASHFREE_SECRET_KEY,
  };
}

// One-time startup diagnostic — never logs the real secret, just enough
// to spot a blank/whitespace/mismatched-env value. Safe to leave in or
// remove once the 401 is resolved.
(function logCashfreeConfigOnBoot() {
  const appId = process.env.CASHFREE_APP_ID || "";
  const secret = process.env.CASHFREE_SECRET_KEY || "";
  console.log("[Cashfree config]", {
    targetEnv: CASHFREE_ENV,
    baseUrl: CASHFREE_BASE_URL,
    appIdLength: appId.length,
    appIdPreview: appId ? `${appId.slice(0, 4)}...${appId.slice(-4)}` : "(empty)",
    appIdHasWhitespace: /\s/.test(appId),
    secretKeyLength: secret.length,
    secretKeyHasWhitespace: /\s/.test(secret),
    secretLooksLikeTestKey: secret.startsWith("cfsk_ma_test_"),
    secretLooksLikeProdKey: secret.startsWith("cfsk_ma_prod_"),
  });
})();

/* ─────────────────────────────────────────
   SCHEMA — one doc per Cashfree order created, keyed to our order id
───────────────────────────────────────── */
const paymentSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true }, // = cf_order_id (our own ref, matches Cashfree's order_id)
    orderId: { type: String, required: true, index: true }, // our restaurant order's id
    billNo: { type: Number, default: null }, // for split bills, which bill this covers
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: ["PENDING", "PAID", "EXPIRED", "FAILED", "CANCELLED"],
      default: "PENDING",
    },
    paymentSessionId: { type: String, default: "" },
    paymentLink: { type: String, default: "" },
    cfPaymentId: { type: String, default: "" }, // set once paid
    venueId: { type: String, default: null },
    createdBy: { type: String, default: null },
    raw: { type: mongoose.Schema.Types.Mixed, default: null }, // last Cashfree response, for debugging
  },
  { timestamps: true, versionKey: false }
);

const Payment = mongoose.model("Payment", paymentSchema, "payments");

function newPaymentOrderId(orderId) {
  // Cashfree order ids must be alphanumeric + a few symbols, unique per order.
  return `pay_${orderId}_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;
}

function safePayment(doc) {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  delete obj.raw; // internal only, never sent to the client
  return obj;
}

/* ─────────────────────────────────────────
   ROUTES. Mounted at /payments.
   Order creation/status is any authenticated admin (cashier-level action,
   not a Super-Admin-only module) — gated the same way most write routes
   are, via requireAuth only. The webhook has no admin session at all
   (Cashfree calls it directly) and is verified via signature instead.
───────────────────────────────────────── */
function buildRouter({ requireAuth, logAudit, emitChange }) {
  const express = require("express");
  const router = express.Router();

  // POST /payments/orders — create a Cashfree order + payment link for a bill
  router.post("/orders", requireAuth, async (req, res) => {
    if (!cashfreeConfigured()) {
      return res.status(503).json({ error: "Cashfree is not configured on the server (missing CASHFREE_APP_ID/CASHFREE_SECRET_KEY)" });
    }
    try {
      const { orderId, amount, billNo, customerName, customerPhone } = req.body;
      if (!orderId || !(Number(amount) > 0)) {
        return res.status(400).json({ error: "orderId and a positive amount are required" });
      }

      const cfOrderId = newPaymentOrderId(orderId);

      const payload = {
        order_id: cfOrderId,
        order_amount: Number(amount.toFixed ? amount.toFixed(2) : amount),
        order_currency: "INR",
        customer_details: {
          // Cashfree requires a customer_id + at least one contact method.
          customer_id: `guest_${orderId}`,
          customer_name: customerName || "Guest",
          customer_phone: customerPhone || "9999999999",
        },
        order_meta: {
          // Where Cashfree redirects the browser after a hosted-page payment.
          // Not used for the QR flow itself, but required by the API.
          return_url: `${PUBLIC_APP_URL}/payment-status?order_id={order_id}`,
          notify_url: process.env.CASHFREE_WEBHOOK_URL || undefined,
        },
        order_note: `Sam Cafe order ${orderId}${billNo ? ` (bill ${billNo})` : ""}`,
      };

      const cfRes = await fetch(`${CASHFREE_BASE_URL}/orders`, {
        method: "POST",
        headers: cashfreeHeaders(),
        body: JSON.stringify(payload),
      });
      const cfData = await cfRes.json();

      if (!cfRes.ok) {
        console.error("Cashfree order creation failed", cfRes.status, cfData);
        return res.status(502).json({ error: cfData.message || "Cashfree order creation failed" });
      }

      const paymentLink =
        cfData.payment_link ||
        (cfData.payment_session_id
          ? `https://payments${CASHFREE_ENV === "production" ? "" : "-test"}.cashfree.com/order/#${cfData.payment_session_id}`
          : "");

      const doc = await Payment.create({
        id: cfOrderId,
        orderId,
        billNo: billNo ?? null,
        amount: Number(amount),
        status: "PENDING",
        paymentSessionId: cfData.payment_session_id || "",
        paymentLink,
        venueId: req.body.venueId || req.admin?.venueId || null,
        createdBy: req.admin?.id || null,
        raw: cfData,
      });

      const result = safePayment(doc);
      await logAudit(req, { action: "create", resource: "payments", targetId: cfOrderId, after: result });
      res.status(201).json(result);
    } catch (err) {
      console.error("POST /payments/orders", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /payments/orders/:id — poll status (admin panel calls this after showing the QR)
  router.get("/orders/:id", requireAuth, async (req, res) => {
    try {
      const local = await Payment.findOne({ id: req.params.id });
      if (!local) return res.status(404).json({ error: "Payment order not found" });

      // Re-check with Cashfree in case the webhook hasn't landed yet.
      if (cashfreeConfigured() && local.status === "PENDING") {
        try {
          const cfRes = await fetch(`${CASHFREE_BASE_URL}/orders/${encodeURIComponent(req.params.id)}`, {
            headers: cashfreeHeaders(),
          });
          if (cfRes.ok) {
            const cfData = await cfRes.json();
            const mapped = mapCashfreeStatus(cfData.order_status);
            if (mapped && mapped !== local.status) {
              local.status = mapped;
              local.raw = cfData;
              await local.save();
              emitChange && emitChange("payments", "updated", safePayment(local));
            }
          }
        } catch (pollErr) {
          console.warn("Cashfree status poll failed, returning last-known status", pollErr.message);
        }
      }

      res.json(safePayment(local));
    } catch (err) {
      console.error("GET /payments/orders/:id", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /payments/orders?orderId= — latest payment record(s) for a restaurant order
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

  // POST /payments/webhook — Cashfree server-to-server payment notification.
  // No admin session; verified via x-webhook-signature per Cashfree's docs
  // (HMAC-SHA256 of timestamp+rawBody using the webhook/secret key).
  // NOTE: this route must receive the RAW request body for signature
  // verification — see the express.raw() wiring where this router is mounted.
  router.post("/webhook", async (req, res) => {
    try {
      const signature = req.headers["x-webhook-signature"];
      const timestamp = req.headers["x-webhook-timestamp"];
      const rawBody = req.body; // Buffer, thanks to express.raw() on this route

      const secret = process.env.CASHFREE_WEBHOOK_SECRET || process.env.CASHFREE_SECRET_KEY;
      if (secret && signature) {
        const expected = crypto
          .createHmac("sha256", secret)
          .update(timestamp + rawBody.toString())
          .digest("base64");
        if (expected !== signature) {
          console.warn("Cashfree webhook signature mismatch — rejecting");
          return res.status(401).json({ error: "Invalid signature" });
        }
      } else {
        console.warn("Cashfree webhook received without signature verification configured — set CASHFREE_WEBHOOK_SECRET");
      }

      const event = JSON.parse(rawBody.toString());
      const cfOrderId = event?.data?.order?.order_id;
      const status = mapCashfreeStatus(event?.data?.order?.order_status || event?.type);

      if (cfOrderId) {
        const local = await Payment.findOne({ id: cfOrderId });
        if (local) {
          if (status) local.status = status;
          local.cfPaymentId = event?.data?.payment?.cf_payment_id || local.cfPaymentId;
          local.raw = event;
          await local.save();
          emitChange && emitChange("payments", "updated", safePayment(local));
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error("POST /payments/webhook", err);
      // Still 200 — Cashfree retries aggressively on non-2xx, and a parse
      // error here isn't something retrying will fix.
      res.status(200).json({ received: false, error: err.message });
    }
  });

  return router;
}

function mapCashfreeStatus(cfStatus) {
  const s = (cfStatus || "").toUpperCase();
  if (["PAID", "SUCCESS"].includes(s)) return "PAID";
  if (["EXPIRED"].includes(s)) return "EXPIRED";
  if (["FAILED", "CANCELLED", "USER_DROPPED", "PAYMENT_FAILED"].includes(s)) return "FAILED";
  if (["ACTIVE", "PENDING"].includes(s)) return "PENDING";
  return null;
}

module.exports = { buildRouter, Payment, safePayment, cashfreeConfigured };