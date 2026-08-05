/**
 * mailer.js — sends transactional emails (currently just password reset)
 * via Gmail SMTP through Nodemailer.
 *
 * Setup required in .env:
 *   SMTP_USER=youraddress@gmail.com
 *   SMTP_PASS=<16-char Gmail App Password>   (NOT your normal Gmail password —
 *              generate one at https://myaccount.google.com/apppasswords,
 *              requires 2-Step Verification to be turned on for the account)
 *   MAIL_FROM="Sam Cafe" <youraddress@gmail.com>   (optional, defaults to SMTP_USER)
 *   FRONTEND_URL=https://samcafe-admin.vercel.app  (used to build the reset link;
 *              falls back to http://localhost:3000 if unset)
 *
 * If SMTP_USER/SMTP_PASS aren't set, sendResetPasswordEmail() logs a warning
 * and resolves without throwing, so forgot-password never 500s just because
 * email isn't configured yet — the token still lands in the response in
 * dev mode (see auth.js) so the flow stays testable either way.
 */

const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

async function sendResetPasswordEmail(toEmail, token) {
  const t = getTransporter();
  if (!t) {
    console.warn(
      "[mailer] SMTP_USER/SMTP_PASS not set — skipping actual email send. " +
      "See mailer.js header for setup instructions."
    );
    return { sent: false };
  }

  const base = process.env.FRONTEND_URL || "http://localhost:3000";
  const resetLink = `${base.replace(/\/$/, "")}/forgot-password?token=${token}`;

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  await t.sendMail({
    from,
    to: toEmail,
    subject: "Reset your Sam Cafe password",
    text:
      `We received a request to reset your Sam Cafe admin password.\n\n` +
      `Reset link (valid for 30 minutes):\n${resetLink}\n\n` +
      `If you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#1f1f1f;">Reset your password</h2>
        <p style="color:#444;">We received a request to reset your Sam Cafe admin password. This link is valid for 30 minutes.</p>
        <p style="margin: 24px 0;">
          <a href="${resetLink}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">
            Reset Password
          </a>
        </p>
        <p style="color:#888;font-size:13px;">If the button doesn't work, copy this link into your browser:<br>${resetLink}</p>
        <p style="color:#888;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });

  return { sent: true };
}

module.exports = { sendResetPasswordEmail };