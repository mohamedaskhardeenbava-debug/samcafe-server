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

// The customer's phone gets redirected to order_meta.return_url after
// finishing in their UPI app — that must be a real, resolvable HTTPS URL
// or Cashfree's own redirect dead-ends (this is what caused the earlier
// DNS_PROBE_FINISHED_NXDOMAIN — a placeholder domain that didn't exist).
// PUBLIC_APP_URL must be set in .env to the admin panel's real deployed
// URL (e.g. https://sam-cafe-admin-testing.vercel.app) for the mobile
// "Transaction Completed" page (/payment-complete) to be reachable. If
// it's missing or still http://, fall back to Cashfree's own generic
// success page rather than risk another dead placeholder domain.
const rawPublicAppUrl = (process.env.PUBLIC_APP_URL || "").trim().replace(/\/$/, "");
const PUBLIC_APP_URL = rawPublicAppUrl.startsWith("https://") ? rawPublicAppUrl : null;
if (!PUBLIC_APP_URL) {
  console.warn(
    "PUBLIC_APP_URL is not set to a valid https:// URL — customers will land on Cashfree's " +
    "own generic result page after paying instead of this app's Transaction Completed page. " +
    "Set PUBLIC_APP_URL in .env (e.g. https://your-admin-panel-domain.com) to fix this."
  );
}

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
      enum: ["PENDING", "PAID", "EXPIRED", "FAILED", "USER_DROPPED", "CANCELLED"],
      default: "PENDING",
    },
    paymentSessionId: { type: String, default: "" },
    paymentLink: { type: String, default: "" },
    cfPaymentId: { type: String, default: "" }, // set once paid
    // Human-readable reason for a FAILED/USER_DROPPED/CANCELLED/EXPIRED
    // outcome, shown to staff in the admin panel's Payment Status modal
    // (and the inline outcome card under the QR). Populated from either
    // the Cashfree UPI simulator's own decline-reason text (relayed by
    // the customer's browser via PATCH /orders/:id/client-status) or a
    // generic fallback if that's ever unavailable — never left blank for
    // a terminal non-success status.
    lastErrorMessage: { type: String, default: "" },
    lastErrorCode: { type: String, default: "" },
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
// Marks the linked restaurant order's paymentStatus as "completed" once a
// Cashfree payment for it resolves to PAID. Best-effort: a failure here
// never blocks the payment-status response itself, since the Payment doc
// (the source of truth for the QR/poll flow) is already saved by the time
// this runs.
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

function buildRouter({ requireAuth, logAudit, emitChange, getModel }) {
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
          // See PUBLIC_APP_URL note above. {order_id} is a Cashfree
          // template token it substitutes with this Cashfree order's own
          // id — the public-status endpoint below is keyed by exactly
          // that id, and takes no restaurant/admin data at all.
          return_url: PUBLIC_APP_URL
            ? `${PUBLIC_APP_URL}/payment-complete?order_id={order_id}`
            : "https://www.google.com",
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

  // PATCH /payments/orders/:id/client-status — the browser embedding the
  // Cashfree SDK reports a payment attempt's own terminal outcome here.
  // This exists because Cashfree's ORDER-level status (what GET /orders/:id
  // re-checks against Cashfree's API) can legitimately stay ACTIVE/PENDING
  // even after ONE payment attempt on it fails or is dropped — the order
  // itself is still open for a retry — so the failure/drop/decline the
  // customer just saw in the UPI app would otherwise never reach our DB at
  // all, and GET /orders/:id's own poll would just keep reporting PENDING
  // forever (silently reverting any client-side-only state back to
  // PENDING on its very next poll). This route is the one authoritative
  // place that outcome gets persisted, with its reason, so it's visible
  // to staff even after this admin panel session ends/refreshes.
  router.patch("/orders/:id/client-status", requireAuth, async (req, res) => {
    try {
      const local = await Payment.findOne({ id: req.params.id });
      if (!local) return res.status(404).json({ error: "Payment order not found" });

      // PAID must only ever be set from a Cashfree-verified source (the
      // webhook, or GET /orders/:id's own re-check against Cashfree's
      // order-status API) — never trust the client's word alone that a
      // payment succeeded. This route is for reporting a FAILURE the
      // client observed, so anything but a real terminal-failure status
      // is rejected outright.
      const ALLOWED = ["FAILED", "USER_DROPPED", "EXPIRED", "CANCELLED"];
      const status = String(req.body?.status || "").toUpperCase();
      if (!ALLOWED.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${ALLOWED.join(", ")}` });
      }

      // Never downgrade a payment that's already resolved — PAID stands
      // no matter what a stale/late client report says, and once one
      // terminal-failure reason is recorded, a second one (e.g. from a
      // delayed duplicate report) shouldn't overwrite the first.
      if (local.status === "PAID" || (local.status !== "PENDING" && local.status !== "ACTIVE")) {
        return res.json(safePayment(local));
      }

      local.status = status;
      local.lastErrorMessage = String(req.body?.message || "").slice(0, 500) || "No reason provided by the payment gateway.";
      local.lastErrorCode = String(req.body?.code || "").slice(0, 100);
      await local.save();
      emitChange && emitChange("payments", "updated", safePayment(local));

      res.json(safePayment(local));
    } catch (err) {
      console.error("PATCH /payments/orders/:id/client-status", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /payments/orders/:id — poll status (admin panel calls this after showing the QR)
  router.get("/orders/:id", requireAuth, async (req, res) => {
    try {
      const local = await Payment.findOne({ id: req.params.id });
      if (!local) return res.status(404).json({ error: "Payment order not found" });

      // Re-check with Cashfree in case the webhook hasn't landed yet. Only
      // when we're still PENDING/ACTIVE — once client-status (above) or
      // the webhook has recorded a terminal outcome, this must NOT poll
      // Cashfree's order-level status and overwrite it: the order can
      // stay ACTIVE there even after this specific attempt failed, which
      // is exactly the bug this whole route was added to fix (the failure
      // message flashing then reverting back to the QR/PENDING a few
      // seconds later).
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
              if (mapped === "PAID") await markOrderPaid(getModel, emitChange, local.orderId);
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

  // GET /payments/public-status/:id — no admin session. This is the ONLY
  // payments endpoint a customer's own phone can reach (after Cashfree
  // redirects it to our return_url with ?order_id=<this id>), so it
  // deliberately returns nothing beyond status + amount — no cfPaymentId,
  // venueId, createdBy, or the restaurant's internal orderId — unlike
  // safePayment() which is fine to expose to authenticated staff.
  router.get("/public-status/:id", async (req, res) => {
    try {
      const local = await Payment.findOne({ id: req.params.id });
      if (!local) return res.status(404).json({ error: "Payment not found" });

      // Same re-check-with-Cashfree fallback as the authenticated route,
      // so a customer landing here right after paying doesn't see a stale
      // PENDING if the webhook hasn't landed yet.
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
              if (mapped === "PAID") await markOrderPaid(getModel, emitChange, local.orderId);
            }
          }
        } catch (pollErr) {
          console.warn("Cashfree status poll failed (public-status), returning last-known status", pollErr.message);
        }
      }

      res.json({
        status: local.status,
        amount: local.amount,
        currency: local.currency,
        message: local.lastErrorMessage || "",
      });
    } catch (err) {
      console.error("GET /payments/public-status/:id", err);
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
      } else if (process.env.NODE_ENV === "production") {
        // In production, an unsigned/unverifiable webhook is refused outright
        // rather than trusted — a missing secret or signature here would
        // otherwise let a forged request mark any order as paid with zero
        // authentication. Fail closed: this is a payment-integrity boundary,
        // not a convenience check.
        console.error(
          "Cashfree webhook rejected: signature verification unavailable " +
          "(secret configured: " + !!secret + ", signature header present: " + !!signature + "). " +
          "Set CASHFREE_WEBHOOK_SECRET (or CASHFREE_SECRET_KEY) to accept webhooks in production."
        );
        return res.status(401).json({ error: "Webhook signature verification is not configured" });
      } else {
        // Non-production (local/sandbox testing without a configured secret):
        // log and proceed, since blocking local development entirely would be
        // a worse default than a clearly-logged, non-production-only trust gap.
        console.warn("Cashfree webhook received without signature verification configured — set CASHFREE_WEBHOOK_SECRET (allowed only because NODE_ENV is not \"production\")");
      }

      const event = JSON.parse(rawBody.toString());
      const cfOrderId = event?.data?.order?.order_id;
      const status = mapCashfreeStatus(event?.data?.order?.order_status || event?.type);

      if (cfOrderId) {
        const local = await Payment.findOne({ id: cfOrderId });
        if (local) {
          const becamePaid = status === "PAID" && local.status !== "PAID";
          if (status) local.status = status;
          local.cfPaymentId = event?.data?.payment?.cf_payment_id || local.cfPaymentId;
          local.raw = event;
          await local.save();
          emitChange && emitChange("payments", "updated", safePayment(local));
          if (becamePaid) await markOrderPaid(getModel, emitChange, local.orderId);
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
  // USER_DROPPED is its own outcome (customer backed out of the UPI app
  // mid-flow) — kept distinct from FAILED (bank/gateway declined it) and
  // CANCELLED, so the four possible outcomes shown in the admin panel's
  // Payment Status modal match Cashfree's own UPI simulator buttons
  // (SUCCESS / PENDING / USER_DROPPED / FAILED) one-to-one.
  if (["USER_DROPPED"].includes(s)) return "USER_DROPPED";
  if (["CANCELLED"].includes(s)) return "CANCELLED";
  if (["FAILED", "PAYMENT_FAILED"].includes(s)) return "FAILED";
  if (["ACTIVE", "PENDING"].includes(s)) return "PENDING";
  return null;
}

module.exports = { buildRouter, Payment, safePayment, cashfreeConfigured };