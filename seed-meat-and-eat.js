/**
 * seed-meat-and-eat.js
 * ────────────────────────────────────────────────────────────────
 * Creates (or reuses) a "Meat and Eat" venue and populates it with
 * its own categories/dishes, ingredients/stocks, staff, and offers —
 * cloned from Main Branch's existing catalog with brand-new IDs and
 * venueId, so the two branches have fully independent data as the
 * venue-scoping model requires. Safe to re-run: it looks up the venue
 * by name first and, if data already exists for it, skips re-seeding
 * that collection rather than duplicating it.
 *
 * This does NOT touch Main Branch or any other venue's data — every
 * write here is either a brand-new venue document or documents
 * stamped with the new venue's id.
 *
 * Usage:
 *   node seed-meat-and-eat.js
 *
 * Requires MONGO_URI in .env (same folder as this script).
 */

require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");
const crypto = require("crypto");

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const VENUE_NAME = "Meat and Eat";
const VENUE_ADDRESS = "Update this address in the Venues page";
const VENUE_AREA = "Update this area in the Venues page";

// How much of Main Branch's catalog to clone into the new branch.
// Cloning everything keeps the new branch fully stocked from day one;
// staff is capped lower since a new branch typically starts with a
// smaller crew that gets built out over time.
const CLONE_LIMITS = {
  categories: Infinity, // clone the whole menu structure (dishes live nested inside)
  ingredients: Infinity, // clone the whole ingredient/stock list
  staff: 5, // seed a starter crew — adjust headcount via the Staff page afterward
  offers: Infinity,
};

function newId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

/** Deep-clone a dish/category tree, replacing every "id" field with a fresh one. */
function reIdCategory(category) {
  const cloned = JSON.parse(JSON.stringify(category));
  cloned.id = newId("cat");
  if (Array.isArray(cloned.subCategories)) {
    cloned.subCategories = cloned.subCategories.map((sub) => {
      const subClone = { ...sub, id: newId("subcat") };
      if (Array.isArray(sub.dishes)) {
        subClone.dishes = sub.dishes.map((dish) => ({ ...dish, id: newId("dish") }));
      }
      return subClone;
    });
  }
  return cloned;
}

async function seed() {
  if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI not set. Make sure .env is present.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");
  const db = mongoose.connection.db;

  // ── 1. Create or find the venue ─────────────────────────────────────────
  const venues = db.collection("venues");
  let venue = await venues.findOne({ name: VENUE_NAME });
  if (!venue) {
    venue = {
      id: newId("venue"),
      name: VENUE_NAME,
      address: VENUE_ADDRESS,
      area: VENUE_AREA,
      status: "active",
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await venues.insertOne(venue);
    console.log(`✅ Created venue "${VENUE_NAME}" (${venue.id})`);
  } else {
    console.log(`ℹ️  Venue "${VENUE_NAME}" already exists (${venue.id}) — reusing it`);
  }
  const venueId = venue.id;

  // ── 2. Find Main Branch to clone catalog data from ──────────────────────
  const mainBranch = await venues.findOne({ name: "Main Branch" });
  if (!mainBranch) {
    console.error('❌ Could not find a venue named "Main Branch" to clone data from. Aborting.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`ℹ️  Cloning catalog data from "Main Branch" (${mainBranch.id})`);

  // ── 3. Categories & dishes ───────────────────────────────────────────────
  const categoriesColl = db.collection("categories");
  const existingCategories = await categoriesColl.countDocuments({ venueId });
  if (existingCategories > 0) {
    console.log(`⏭  Skipped categories — ${existingCategories} already exist for ${VENUE_NAME}`);
  } else {
    const sourceCategories = await categoriesColl.find({ venueId: mainBranch.id }).toArray();
    const cloned = sourceCategories.map((cat) => {
      const { _id, ...rest } = cat;
      const reIded = reIdCategory(rest);
      return { ...reIded, venueId };
    });
    if (cloned.length) {
      await categoriesColl.insertMany(cloned);
      const dishCount = cloned.reduce(
        (sum, c) => sum + (c.subCategories || []).reduce((s, sc) => s + (sc.dishes || []).length, 0),
        0
      );
      console.log(`✅ Cloned ${cloned.length} categories (${dishCount} dishes) → ${VENUE_NAME}`);
    } else {
      console.log("⚠️  Main Branch has no categories to clone");
    }
  }

  // ── 4. Ingredients / stocks ──────────────────────────────────────────────
  const ingredientsColl = db.collection("ingredients");
  const existingIngredients = await ingredientsColl.countDocuments({ venueId });
  if (existingIngredients > 0) {
    console.log(`⏭  Skipped ingredients — ${existingIngredients} already exist for ${VENUE_NAME}`);
  } else {
    const sourceIngredients = await ingredientsColl.find({ venueId: mainBranch.id }).toArray();
    const cloned = sourceIngredients.map((ing) => {
      const { _id, ...rest } = ing;
      return { ...rest, id: newId("ingredient"), venueId };
    });
    if (cloned.length) {
      await ingredientsColl.insertMany(cloned);
      console.log(`✅ Cloned ${cloned.length} ingredients/stocks → ${VENUE_NAME}`);
    } else {
      console.log("⚠️  Main Branch has no ingredients to clone");
    }
  }

  // ── 5. Staff (starter crew) ──────────────────────────────────────────────
  const staffColl = db.collection("staff");
  const existingStaff = await staffColl.countDocuments({ venueId });
  if (existingStaff > 0) {
    console.log(`⏭  Skipped staff — ${existingStaff} already exist for ${VENUE_NAME}`);
  } else {
    const sourceStaff = await staffColl.find({ venueId: mainBranch.id }).limit(CLONE_LIMITS.staff).toArray();
    const cloned = sourceStaff.map((s) => {
      const { _id, ...rest } = s;
      return {
        ...rest,
        id: newId("staff"),
        venueId,
        // Contact/bank details are cloned as placeholders, not the real
        // employee's data — these must be corrected via the Staff page
        // before this is a real person's record.
        contact: "",
        altContact: "",
        bank: { name: "", account: "", ifsc: "" },
      };
    });
    if (cloned.length) {
      await staffColl.insertMany(cloned);
      console.log(`✅ Cloned ${cloned.length} placeholder staff records → ${VENUE_NAME}`);
      console.log("   ⚠️  These are placeholder records (blank contact/bank info) — edit them with real employee details before use.");
    } else {
      console.log("⚠️  Main Branch has no staff to clone");
    }
  }

  // ── 6. Offers ─────────────────────────────────────────────────────────────
  const offersColl = db.collection("offers");
  const existingOffers = await offersColl.countDocuments({ venueId });
  if (existingOffers > 0) {
    console.log(`⏭  Skipped offers — ${existingOffers} already exist for ${VENUE_NAME}`);
  } else {
    const sourceOffers = await offersColl.find({ venueId: mainBranch.id }).toArray();
    const cloned = sourceOffers.map((o) => {
      const { _id, ...rest } = o;
      return { ...rest, id: newId("offer"), venueId };
    });
    if (cloned.length) {
      await offersColl.insertMany(cloned);
      console.log(`✅ Cloned ${cloned.length} offers → ${VENUE_NAME}`);
    } else {
      console.log("ℹ️  Main Branch has no offers yet — nothing to clone (this is fine, add offers directly for either branch anytime)");
    }
  }

  console.log("\n🎉 Done. Log in and switch to \"Meat and Eat\" (Super Admin venue switcher) to review the seeded data.");
  console.log(`   Update the venue's address/area on the Venues page — placeholders were used: "${VENUE_ADDRESS}" / "${VENUE_AREA}"`);

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("❌ Seeding failed:", err);
  process.exit(1);
});
