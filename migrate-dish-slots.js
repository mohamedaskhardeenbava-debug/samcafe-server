/**
 * migrate-dish-slots.js
 * ────────────────────────────────────────────────────────────────
 * One-time, non-destructive migration: adds a `slots` array to every
 * existing dish (inside categories[].dishes[] and
 * categories[].subCategories[].dishes[]) that doesn't already have one.
 *
 * Unlike seed.js, this does NOT delete/replace the categories collection —
 * it only patches the `dishes` arrays in place, so every other field on
 * every category/subCategory/dish is left untouched.
 *
 * Usage:
 *   node migrate-dish-slots.js                          ← all dishes get all slots
 *   node migrate-dish-slots.js --slots=breakfast,lunch   ← all dishes get this fixed set
 *   node migrate-dish-slots.js --random                  ← each dish gets a random subset
 *
 * Requires MONGO_URI in .env (same folder as this script, same as server.js).
 */

require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const VALID_SLOTS = ["breakfast", "brunch", "lunch", "hi-tea", "dinner"];

const RANDOM_MODE = process.argv.includes("--random");

// Default slots applied to any dish that has no `slots` field yet (ignored
// when --random is passed). Override via: --slots=breakfast,lunch,dinner
const argSlots = process.argv.find((a) => a.startsWith("--slots="));
const DEFAULT_SLOTS = argSlots
  ? argSlots
      .replace("--slots=", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => VALID_SLOTS.includes(s))
  : [...VALID_SLOTS]; // default: every dish available in all slots until edited

// Picks a random non-empty subset of VALID_SLOTS (1 to all 5 slots),
// so every dish ends up available in at least one slot.
function randomSlots() {
  const shuffled = [...VALID_SLOTS].sort(() => Math.random() - 0.5);
  const count = 1 + Math.floor(Math.random() * VALID_SLOTS.length); // 1..5
  return shuffled.slice(0, count).sort(
    (a, b) => VALID_SLOTS.indexOf(a) - VALID_SLOTS.indexOf(b)
  );
}

async function migrate() {
  if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI not set. Make sure .env is present.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");
  console.log(
    RANDOM_MODE
      ? "ℹ️  Assigning a random subset of slots to each dish missing the field"
      : `ℹ️  Default slots for dishes missing the field: [${DEFAULT_SLOTS.join(", ")}]`
  );

  const db = mongoose.connection.db;
  const categoriesCol = db.collection("categories");

  const categories = await categoriesCol.find({}).toArray();

  let dishesUpdated = 0;
  let categoriesUpdated = 0;

  function patchDishes(dishes) {
    if (!Array.isArray(dishes)) return { changed: false, dishes };
    let changed = false;
    const patched = dishes.map((dish) => {
      if (Array.isArray(dish.slots)) return dish; // already migrated, leave as-is
      changed = true;
      dishesUpdated += 1;
      const slots = RANDOM_MODE ? randomSlots() : [...DEFAULT_SLOTS];
      return { ...dish, slots };
    });
    return { changed, dishes: patched };
  }

  for (const cat of categories) {
    let categoryChanged = false;
    const update = {};

    const { changed: topChanged, dishes: topDishes } = patchDishes(cat.dishes);
    if (topChanged) {
      update.dishes = topDishes;
      categoryChanged = true;
    }

    if (Array.isArray(cat.subCategories)) {
      let subChanged = false;
      const newSubs = cat.subCategories.map((sub) => {
        const { changed, dishes } = patchDishes(sub.dishes);
        if (changed) subChanged = true;
        return changed ? { ...sub, dishes } : sub;
      });
      if (subChanged) {
        update.subCategories = newSubs;
        categoryChanged = true;
      }
    }

    if (categoryChanged) {
      await categoriesCol.updateOne({ _id: cat._id }, { $set: update });
      categoriesUpdated += 1;
      console.log(`✅ Updated category "${cat.name || cat.id}"`);
    }
  }

  console.log(
    `\n🎉 Migration complete! ${dishesUpdated} dish(es) across ${categoriesUpdated} categor${
      categoriesUpdated === 1 ? "y" : "ies"
    } given a \`slots\` field.`
  );
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});

