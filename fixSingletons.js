/**
 * fixSingletons.js
 * ─────────────────────────────────────────────────────────────
 * ONE-TIME REPAIR SCRIPT — run once after upgrading to the fixed seed.js.
 *
 * WHY THIS EXISTS
 * ----------------
 * The old seed.js stored singleton collections (grooming, mise, kitchenAssign,
 * kitchenMise, serviceAssign, serviceGrooming, serviceMise, theme,
 * tablePreferences) using:
 *
 *   insertOne({ _id: "singleton", ...value })
 *
 * But the server queries for them using:
 *
 *   Model.findOne({ id: "singleton" })
 *
 * So every GET /grooming, GET /mise, etc. returned {} (empty object) because
 * the document existed in MongoDB but the query field didn't match.
 * Also, subsequent findOneAndReplace calls threw CastErrors because Mongoose
 * expects _id to be an ObjectId, not a string.
 *
 * WHAT IT DOES
 * ------------
 * For each singleton collection:
 * 1. Finds any document where _id is the string "singleton".
 * 2. Deletes it.
 * 3. Re-inserts the same data with id="singleton" (a normal app-level field)
 *    and a proper MongoDB-generated ObjectId as _id.
 *
 * This script is idempotent — running it again on already-fixed data is safe.
 *
 * USAGE
 * -----
 *   node fixSingletons.js
 */

require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const SINGLETON_COLLECTIONS = [
  "grooming",
  "mise",
  "kitchenAssign",
  "kitchenMise",
  "serviceAssign",
  "serviceGrooming",
  "serviceMise",
  "theme",
  "tablePreferences",
];

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI not found. Make sure your .env file is present.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB\n");

  const db = mongoose.connection.db;
  let fixed = 0;

  for (const colName of SINGLETON_COLLECTIONS) {
    // Look for a document where the _id is the string "singleton" (old broken format)
    const broken = await db
      .collection(colName)
      .findOne({ _id: "singleton" });

    if (!broken) {
      // Check if it's already correct (has id: "singleton" with a real ObjectId _id)
      const already = await db
        .collection(colName)
        .findOne({ id: "singleton" });
      if (already) {
        console.log(`✅ Already correct: ${colName}`);
      } else {
        console.log(`⏭  Not found (empty collection): ${colName}`);
      }
      continue;
    }

    // Extract data without the broken _id
    const { _id, ...data } = broken;

    await db.collection(colName).deleteOne({ _id: "singleton" });
    await db.collection(colName).insertOne({ id: "singleton", ...data });

    console.log(`🔧 Fixed singleton: ${colName}`);
    fixed += 1;
  }

  console.log(`\n✅ Done. ${fixed} singleton collection(s) repaired.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Fix failed:", err.message);
  process.exit(1);
});
