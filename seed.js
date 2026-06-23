/**
 * seed.js
 * ────────────────────────────────────────────────────────────────
 * One-time migration script: reads db.json and seeds MongoDB Atlas.
 *
 * Usage:
 *   node seed.js
 *   node seed.js path/to/custom-db.json   ← optional path override
 *
 * Requires MONGO_URI in .env (same folder as this script).
 */

require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

// Force public DNS resolvers — fixes SRV lookup failures on home routers / some ISPs
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// Accept an optional CLI path argument; fall back to db.json in the same directory
const DB_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "db.json");

async function seed() {
  if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI not set. Make sure .env is present.");
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ db.json not found at: ${DB_PATH}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch (err) {
    console.error("❌ Failed to parse db.json:", err.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  const db = mongoose.connection.db;

  for (const [collection, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        console.log(`⏭  Skipped (empty array): ${collection}`);
        continue;
      }
      await db.collection(collection).deleteMany({});
      await db.collection(collection).insertMany(value);
      console.log(`✅ Imported ${value.length} docs → ${collection}`);
    } else if (value && typeof value === "object") {
      // Singleton object resource (grooming, mise, kitchenAssign, theme, etc.)
      // Stored as a single document with id="singleton" so the server can
      // reliably fetch it with: Model.findOne({ id: "singleton" })
      //
      // NOTE: We store it as id="singleton" (the app-level id field), NOT as
      // _id="singleton". Using a string for _id breaks Mongoose's ObjectId
      // expectations and causes CastErrors on subsequent findOneAndReplace calls.
      await db.collection(collection).deleteMany({});
      await db.collection(collection).insertOne({ id: "singleton", ...value });
      console.log(`✅ Imported singleton object → ${collection}`);
    } else {
      // Plain scalar value (e.g. $schema) — not meaningful to store as a document
      console.log(`⏭  Skipped (not array/object): ${collection}`);
    }
  }

  console.log("\n🎉 Seed complete!");
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err.message);
  process.exit(1);
});
