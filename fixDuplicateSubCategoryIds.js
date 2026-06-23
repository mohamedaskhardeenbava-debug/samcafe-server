/**
 * fixDuplicateSubCategoryIds.js
 * ─────────────────────────────────────────────────────────────
 * ONE-TIME REPAIR SCRIPT — run once manually from your machine.
 *
 * WHY THIS EXISTS
 * ----------------
 * Before the Categories.js fix, every new subcategory id was generated
 * purely from its name (e.g. "Starters" → "starters"), with no uniqueness
 * guarantee. Any two subcategories sharing a name ended up with the same id.
 * Every lookup in the app (Dishes.js, DishDetails.js, OfferDetails.js)
 * finds a subcategory by scanning `id` across ALL categories, so a collision
 * meant dish add/delete could silently apply to the wrong subcategory.
 *
 * The code-level fix (unique, timestamped ids going forward) only prevents
 * new collisions. This script finds every existing collision in Atlas and
 * gives each duplicate a new unique id — without touching any dish data.
 *
 * WHAT IT DOES
 * ------------
 * 1. Scans every category document's `subCategories` array.
 * 2. Groups subcategories by `id` across the ENTIRE collection.
 * 3. For any id used more than once, keeps the first occurrence as-is and
 *    assigns a new unique id to every subsequent occurrence, preserving its
 *    name, image, sizes, and `dishes` array untouched.
 * 4. Writes the corrected subCategories array back to each affected document.
 * 5. Prints a full report of what changed. Nothing is deleted.
 *
 * USAGE
 * -----
 *   1. Make sure your .env (with MONGO_URI) is in the same folder.
 *   2. Back up your database first (Atlas → Clusters → ··· → Back Up Now).
 *   3. Run once:  node fixDuplicateSubCategoryIds.js
 *       or:       npm run fix-ids
 *   4. Read the printed report. Reload the admin panel — duplicated
 *      subcategories should be gone, each with a unique id.
 *
 * This script is idempotent — running it again on already-clean data will
 * report "No duplicate subcategory ids found" and change nothing.
 */

require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");

dns.setServers(["8.8.8.8", "1.1.1.1"]);

function generateSubCategoryId(name, salt) {
  const base = (name || "item")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "_");
  return `sub_${base || "item"}_${Date.now()}_${salt}`;
}

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI not found. Make sure your .env file is present.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB\n");

  const db = mongoose.connection.db;
  const categories = await db.collection("categories").find({}).toArray();

  // First pass: find every subcategory id and where it lives
  const idLocations = {}; // id -> [{ categoryMongoId, categoryAppId, categoryName, subIndex, subName }]
  categories.forEach((cat) => {
    (cat.subCategories || []).forEach((sub, subIdx) => {
      if (!sub.id) return;
      if (!idLocations[sub.id]) idLocations[sub.id] = [];
      idLocations[sub.id].push({
        categoryMongoId: cat._id,
        categoryAppId: cat.id,
        categoryName: cat.name,
        subIndex: subIdx,
        subName: sub.name,
      });
    });
  });

  const duplicateIds = Object.entries(idLocations).filter(
    ([, locs]) => locs.length > 1
  );

  if (duplicateIds.length === 0) {
    console.log("✅ No duplicate subcategory ids found. Nothing to fix.");
    await mongoose.disconnect();
    return;
  }

  console.log(
    `Found ${duplicateIds.length} subcategory id(s) that are duplicated:\n`
  );

  // Build a map of categoryMongoId → list of { subIndex, newId } changes to apply
  const changesByCategory = {};

  duplicateIds.forEach(([dupId, locs]) => {
    console.log(`  id "${dupId}" is used by ${locs.length} subcategories:`);
    locs.forEach((loc, i) => {
      console.log(
        `    - category "${loc.categoryName}" (${loc.categoryAppId}) ` +
        `→ subcategory "${loc.subName}"` +
        (i === 0 ? "  [kept as-is]" : "  [will get a new id]")
      );
    });

    // Keep the first occurrence; reassign every subsequent one
    locs.slice(1).forEach((loc, i) => {
      const newId = generateSubCategoryId(
        loc.subName,
        `${i}${Math.random().toString(36).slice(2, 6)}`
      );
      const key = String(loc.categoryMongoId);
      if (!changesByCategory[key]) changesByCategory[key] = [];
      changesByCategory[key].push({ subIndex: loc.subIndex, newId, oldId: dupId });
    });
    console.log("");
  });

  // Apply changes one category document at a time
  let categoriesUpdated = 0;
  for (const cat of categories) {
    const key = String(cat._id);
    const changes = changesByCategory[key];
    if (!changes || changes.length === 0) continue;

    const updatedSubCategories = (cat.subCategories || []).map((sub, idx) => {
      const change = changes.find((c) => c.subIndex === idx);
      return change ? { ...sub, id: change.newId } : sub;
    });

    await db.collection("categories").updateOne(
      { _id: cat._id },
      { $set: { subCategories: updatedSubCategories } }
    );
    categoriesUpdated += 1;
    console.log(
      `Updated category "${cat.name}" (${cat.id}) — ${changes.length} subcategory id(s) reassigned.`
    );
  }

  console.log(`\n✅ Done. ${categoriesUpdated} category document(s) updated.`);
  console.log(
    "Dish data inside each subcategory was preserved — only ids changed."
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
