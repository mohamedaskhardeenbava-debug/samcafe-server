/**
 * bankAccount.js — Sam Cafe Bank Account settings
 *
 * Stores the restaurant's own bank account details (where customer
 * payments settle) — account holder name, account number, IFSC, bank/
 * branch name, and optionally a UPI VPA. Global singleton (one record
 * for the restaurant, not per-venue) — same "always Super Admin, always
 * global" treatment as documents.js/theme, following the GLOBAL_SINGLETONS
 * convention already used in server.js for `theme`/`categoryCards`, but
 * kept as its own hardcoded-role module (not folded into that generic
 * loop) because bank details are more sensitive than the generic
 * permission-matrix gate covers — Super Admin only, no exceptions,
 * mirroring documents.js.
 *
 * Account number is masked in every response except immediately after a
 * write and on the dedicated GET /bank-account/reveal route, so the full
 * number isn't sitting in every list/detail fetch by default.
 */

const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const SINGLETON_ID = "singleton";

/* ─────────────────────────────────────────
   SCHEMA
───────────────────────────────────────── */
const bankAccountSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, default: SINGLETON_ID },
    accountHolderName: { type: String, default: "", trim: true },
    accountNumber: { type: String, default: "" },
    ifscCode: { type: String, default: "", uppercase: true, trim: true },
    bankName: { type: String, default: "", trim: true },
    branchName: { type: String, default: "", trim: true },
    upiVpa: { type: String, default: "", trim: true }, // required — the UPI QR payment system (payments.js) reads this to build every order's payment QR
    updatedBy: { type: String, default: null }, // admin id
  },
  { timestamps: true, versionKey: false }
);

const BankAccount = mongoose.model("BankAccount", bankAccountSchema, "bankAccount");

function maskAccountNumber(num) {
  if (!num) return "";
  const s = String(num);
  if (s.length <= 4) return "*".repeat(s.length);
  return "*".repeat(s.length - 4) + s.slice(-4);
}

function safeBankAccount(doc, { reveal = false } = {}) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  delete obj.id;
  if (!reveal) {
    obj.accountNumber = maskAccountNumber(obj.accountNumber);
  }
  return obj;
}

/**
 * Loose but real validation for a UPI VPA (Virtual Payment Address),
 * e.g. "samcafe@okhdfcbank" or "9876543210@ybl". Every UPI handle
 * follows <name>@<bank/PSP handle>; this intentionally does not
 * maintain a hardcoded list of valid bank/PSP handles (new ones are
 * added by NPCI over time and this app has no way to stay in sync with
 * that list) — it just checks the shape is plausible, so a payment QR
 * is never generated against an obviously-wrong value like a stray
 * email address or empty string.
 */
function isValidUpiVpa(vpa) {
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(String(vpa || "").trim());
}

/* ─────────────────────────────────────────
   ROUTES — Super Admin only. Mounted at /bank-account.
───────────────────────────────────────── */
function buildRouter({ requireAuth, requireRole, logAudit }) {
  // GET /bank-account — masked account number
  router.get("/", requireAuth, requireRole("Super Admin"), async (_req, res) => {
    try {
      const doc = await BankAccount.findOne({ id: SINGLETON_ID }).lean();
      res.json(doc ? safeBankAccount(doc) : {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /bank-account/reveal — full account number, for the edit form only
  router.get("/reveal", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const doc = await BankAccount.findOne({ id: SINGLETON_ID }).lean();
      const result = doc ? safeBankAccount(doc, { reveal: true }) : {};
      logAudit(req, { action: "read", resource: "bankAccount", targetId: SINGLETON_ID });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /bank-account — full replace (upsert)
  router.put("/", requireAuth, requireRole("Super Admin"), async (req, res) => {
    try {
      const { accountHolderName, accountNumber, ifscCode, bankName, branchName, upiVpa } = req.body;
      if (!accountHolderName || !accountNumber || !ifscCode || !bankName) {
        return res.status(400).json({ error: "accountHolderName, accountNumber, ifscCode, and bankName are required" });
      }
      // upiVpa is required (not merely "recommended") — the Direct UPI
      // QR Payment System (payments.js) has no other source for the
      // payee address every order's payment QR is built against, so a
      // missing/malformed value here would silently block every order
      // page's "Generate QR" action later instead of failing clearly,
      // right here, at the one place it's actually being set.
      if (!upiVpa || !isValidUpiVpa(upiVpa)) {
        return res.status(400).json({ error: "A valid UPI ID is required, e.g. yourname@okhdfcbank" });
      }

      const before = await BankAccount.findOne({ id: SINGLETON_ID }).lean();
      const doc = await BankAccount.findOneAndUpdate(
        { id: SINGLETON_ID },
        {
          $set: {
            accountHolderName,
            accountNumber,
            ifscCode: String(ifscCode).toUpperCase(),
            bankName,
            branchName: branchName || "",
            upiVpa: String(upiVpa).trim(),
            updatedBy: req.admin.id,
          },
        },
        { returnDocument: "after", upsert: true }
      ).lean();

      const result = safeBankAccount(doc);
      logAudit(req, {
        action: "update",
        resource: "bankAccount",
        targetId: SINGLETON_ID,
        before: before ? safeBankAccount(before) : null,
        after: result,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { buildRouter, BankAccount, safeBankAccount };