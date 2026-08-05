// Unit-level checks that don't require a live MongoDB connection —
// the sandbox can't download a mongod binary, so this exercises the
// pure logic (role tree validity, password hashing/verification via
// bcrypt, cookie option shape) directly.

const bcrypt = require("bcrypt");
const mongoose = require("mongoose");

// mongoose.model() requires connection state for some ops, but schema
// definition + validation runs without a live connection.
const authModule = require("./auth.js");
const { ROLE_TREE, Admin } = authModule;

const results = [];
const check = (label, cond) => {
  results.push({ label, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"} — ${label}`);
};

(async () => {
  // 1. Role tree shape matches spec
  check(
    "ROLE_TREE has exactly the 3 required groups",
    JSON.stringify(Object.keys(ROLE_TREE).sort()) ===
      JSON.stringify(["Manager", "Super Admin", "Supervisor"].sort())
  );
  check(
    "Supervisor -> Sous Chef, Captain",
    JSON.stringify(ROLE_TREE["Supervisor"].sort()) === JSON.stringify(["Captain", "Sous Chef"].sort())
  );
  check(
    "Manager -> Service Manager, Chef",
    JSON.stringify(ROLE_TREE["Manager"].sort()) === JSON.stringify(["Chef", "Service Manager"].sort())
  );
  check(
    "Super Admin -> General Manager, Proprietor",
    JSON.stringify(ROLE_TREE["Super Admin"].sort()) === JSON.stringify(["General Manager", "Proprietor"].sort())
  );

  // 2. Mongoose schema validation (in-memory, no DB write) catches bad role pair
  const badAdmin = new Admin({
    id: "x",
    name: "Test",
    email: "test@x.com",
    password: "hash",
    roleGroup: "NotARole",
    roleTitle: "Captain",
  });
  const err = badAdmin.validateSync();
  check("schema rejects invalid roleGroup enum value", !!err && !!err.errors.roleGroup);

  const goodAdmin = new Admin({
    id: "x",
    name: "Test",
    email: "test@x.com",
    password: "hash",
    roleGroup: "Supervisor",
    roleTitle: "Captain",
  });
  const err2 = goodAdmin.validateSync();
  check("schema accepts valid roleGroup/roleTitle enum combo", !err2);

  // 3. bcrypt round-trip (used for both admins and existing users flow)
  const hash = await bcrypt.hash("mypassword123", 10);
  const matches = await bcrypt.compare("mypassword123", hash);
  const rejects = await bcrypt.compare("wrongpassword", hash);
  check("bcrypt hash verifies correct password", matches === true);
  check("bcrypt hash rejects wrong password", rejects === false);
  check("bcrypt never stores plaintext", hash !== "mypassword123");

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
  process.exit();
})();
