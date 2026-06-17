require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

// Force Node to use public DNS resolvers instead of your system/router default.
// This fixes "querySrv ECONNREFUSED _mongodb._tcp...." errors, which happen when
// your local DNS server can't resolve the SRV/TXT records that mongodb+srv://
// connection strings depend on (common with home routers, some ISPs, VPNs, or AV software).
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// ✅ Change this path to where your db.json is
const DB_PATH = "D:\\Sam Cafe\\data\\db.json";

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const data = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
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
      // Singleton object resource (e.g. grooming, mise, assign, profile, theme).
      // Stored as a single fixed-id document so it's easy to fetch back as one object.
      await db.collection(collection).deleteMany({});
      await db.collection(collection).insertOne({ _id: "singleton", ...value });
      console.log(`✅ Imported singleton object → ${collection}`);
    } else {
      // Plain string/number/boolean value (e.g. $schema) — not meaningful to store as a doc.
      console.log(`⏭  Skipped (not array/object): ${collection}`);
    }
  }

  console.log("🎉 All done!");
  mongoose.disconnect();
}

seed().catch(console.error);