const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const express = require("express");
const cookieParser = require("cookie-parser");
const http = require("http");

process.env.NODE_ENV = "development"; // secure:false cookies for plain-http test

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  console.log("Connected to in-memory Mongo");

  const { router: authRouter, todoRouter, requireAuth } = require("./auth");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/staff-auth", authRouter);
  app.use("/todos", todoRouter);
  app.get("/protected-ping", requireAuth, (req, res) =>
    res.json({ ok: true, who: req.admin.email, role: req.admin.roleGroup })
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  let cookieJar = "";
  const fetchOpts = () => ({
    headers: { "Content-Type": "application/json", Cookie: cookieJar },
  });
  const captureCookie = (res) => {
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookieJar = setCookie.split(";")[0];
  };

  const results = [];
  const check = (label, cond) => {
    results.push({ label, pass: !!cond });
    console.log(`${cond ? "PASS" : "FAIL"} — ${label}`);
  };

  // 1. Signup with invalid role pair should fail
  let r = await fetch(`${base}/staff-auth/signup`, {
    method: "POST",
    ...fetchOpts(),
    body: JSON.stringify({
      name: "Bad Role",
      email: "bad@samcafe.com",
      password: "password123",
      roleGroup: "Manager",
      roleTitle: "Captain", // Captain belongs to Supervisor, not Manager
    }),
  });
  check("signup rejects mismatched roleGroup/roleTitle", r.status === 400);

  // 2. Valid signup (Chef under Manager)
  r = await fetch(`${base}/staff-auth/signup`, {
    method: "POST",
    ...fetchOpts(),
    body: JSON.stringify({
      name: "Chef Karthik",
      email: "chef@samcafe.com",
      password: "password123",
      roleGroup: "Manager",
      roleTitle: "Chef",
    }),
  });
  const signupData = await r.json();
  captureCookie(r);
  check("signup succeeds with valid role pair", r.status === 201 && signupData.admin.email === "chef@samcafe.com");
  check("signup sets session cookie", cookieJar.includes("samcafe_sid"));
  check("signup response never includes password hash", signupData.admin.password === undefined);

  // 3. GET /staff-auth/me with cookie should succeed (reload persistence)
  r = await fetch(`${base}/staff-auth/me`, fetchOpts());
  const meData = await r.json();
  check("GET /me works with session cookie (reload persistence)", r.status === 200 && meData.admin.email === "chef@samcafe.com");

  // 4. GET /staff-auth/me WITHOUT cookie should 401
  r = await fetch(`${base}/staff-auth/me`, { headers: { "Content-Type": "application/json" } });
  check("GET /me without cookie returns 401", r.status === 401);

  // 5. Duplicate email signup should 409
  r = await fetch(`${base}/staff-auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Dup",
      email: "chef@samcafe.com",
      password: "password123",
      roleGroup: "Supervisor",
      roleTitle: "Captain",
    }),
  });
  check("duplicate email signup returns 409", r.status === 409);

  // 6. Logout clears session
  r = await fetch(`${base}/staff-auth/logout`, { method: "POST", ...fetchOpts() });
  captureCookie(r); // cookie gets cleared/expired
  check("logout succeeds", r.status === 200);

  r = await fetch(`${base}/staff-auth/me`, fetchOpts());
  check("session invalid after logout", r.status === 401);

  // 7. Login flow
  r = await fetch(`${base}/staff-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "chef@samcafe.com", password: "password123" }),
  });
  const loginData = await r.json();
  captureCookie(r);
  check("login succeeds with correct password", r.status === 200 && loginData.admin.roleTitle === "Chef");

  // 8. Login with wrong password fails
  r = await fetch(`${base}/staff-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "chef@samcafe.com", password: "wrongpass" }),
  });
  check("login fails with wrong password", r.status === 401);

  // 9. Role gating: create a Supervisor account, confirm they can't hit Super-Admin-only route
  r = await fetch(`${base}/staff-auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Captain Ravi",
      email: "captain@samcafe.com",
      password: "password123",
      roleGroup: "Supervisor",
      roleTitle: "Captain",
    }),
  });
  let capCookie = (r.headers.get("set-cookie") || "").split(";")[0];

  r = await fetch(`${base}/staff-auth/admins`, {
    headers: { "Content-Type": "application/json", Cookie: capCookie },
  });
  check("Supervisor blocked from Super-Admin-only /admins list (403)", r.status === 403);

  // 10. Super Admin CAN hit it
  r = await fetch(`${base}/staff-auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Proprietor Sam",
      email: "owner@samcafe.com",
      password: "password123",
      roleGroup: "Super Admin",
      roleTitle: "Proprietor",
    }),
  });
  let ownerCookie = (r.headers.get("set-cookie") || "").split(";")[0];
  r = await fetch(`${base}/staff-auth/admins`, {
    headers: { "Content-Type": "application/json", Cookie: ownerCookie },
  });
  const adminsList = await r.json();
  check("Super Admin CAN list /admins", r.status === 200 && Array.isArray(adminsList));
  check("admins list has 3 accounts (chef, captain, owner)", adminsList.length === 3);

  // 11. Forgot password issues a token (dev mode)
  r = await fetch(`${base}/staff-auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "chef@samcafe.com" }),
  });
  const forgotData = await r.json();
  check("forgot-password returns a token in dev mode", !!forgotData.token);

  // 12. Reset password with that token
  r = await fetch(`${base}/staff-auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: forgotData.token, newPassword: "newpassword456" }),
  });
  check("reset-password succeeds", r.status === 200);

  // 13. Old password no longer works, new one does
  r = await fetch(`${base}/staff-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "chef@samcafe.com", password: "password123" }),
  });
  check("old password rejected after reset", r.status === 401);

  r = await fetch(`${base}/staff-auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "chef@samcafe.com", password: "newpassword456" }),
  });
  check("new password accepted after reset", r.status === 200);

  // 14. Todos — period filter
  let chefCookie = (r.headers.get("set-cookie") || "").split(";")[0];
  await fetch(`${base}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: chefCookie },
    body: JSON.stringify({ title: "Prep weekly menu", period: "weekly" }),
  });
  await fetch(`${base}/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: chefCookie },
    body: JSON.stringify({ title: "Check daily stock", period: "daily" }),
  });
  r = await fetch(`${base}/todos?period=weekly`, {
    headers: { "Content-Type": "application/json", Cookie: chefCookie },
  });
  const weeklyTodos = await r.json();
  check("todos filter by period works", weeklyTodos.length === 1 && weeklyTodos[0].period === "weekly");

  // Summary
  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:", failed.map((f) => f.label));
    process.exitCode = 1;
  }

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exitCode = 1;
});
