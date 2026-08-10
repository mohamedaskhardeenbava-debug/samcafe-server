/**
 * seed-recipes.js
 * ────────────────────────────────────────────────────────────────
 * One-time migration script: clears the "recipes" collection and
 * inserts 10 fresh recipes in the new shape — { id, name,
 * ingredients: [{ name, quantity }], description (procedure,
 * newline-separated steps) } — matching the two-tab Ingredients /
 * Procedure modal on the admin Recipes page.
 *
 * Usage:
 *   node seed-recipes.js
 *
 * Requires MONGO_URI in .env (same folder as this script).
 */

require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");

// Force public DNS resolvers — fixes SRV lookup failures on home routers / some ISPs
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const anySchema = new mongoose.Schema({}, { strict: false, timestamps: false, versionKey: false, id: false });

const RECIPES = [
  {
    id: "recipe_paneer_butter_masala",
    name: "Paneer Butter Masala",
    ingredients: [
      { name: "Paneer", quantity: "250 g" },
      { name: "Butter", quantity: "50 g" },
      { name: "Tomato", quantity: "4 medium, pureed" },
      { name: "Cashew nuts", quantity: "10, soaked" },
      { name: "Fresh cream", quantity: "3 tbsp" },
      { name: "Ginger-garlic paste", quantity: "1 tbsp" },
      { name: "Kashmiri red chilli powder", quantity: "1 tsp" },
      { name: "Garam masala", quantity: "1/2 tsp" },
      { name: "Kasuri methi", quantity: "1 tsp, crushed" },
      { name: "Salt", quantity: "to taste" },
    ],
    description: [
      "Melt butter in a pan and sauté ginger-garlic paste until fragrant.",
      "Add tomato puree and soaked cashews, cook until the oil separates.",
      "Cool slightly and blend into a smooth paste.",
      "Return the paste to the pan, add chilli powder, garam masala, and salt.",
      "Simmer for 5 minutes, then add paneer cubes and cook for 3-4 minutes.",
      "Stir in fresh cream and crushed kasuri methi, simmer 2 more minutes.",
      "Serve hot garnished with a swirl of cream.",
    ].join("\n"),
  },
  {
    id: "recipe_chicken_biryani",
    name: "Chicken Biryani",
    ingredients: [
      { name: "Basmati rice", quantity: "500 g" },
      { name: "Chicken", quantity: "750 g, curry cut" },
      { name: "Yogurt", quantity: "1 cup" },
      { name: "Onion", quantity: "3 large, sliced & fried" },
      { name: "Biryani masala", quantity: "2 tbsp" },
      { name: "Mint leaves", quantity: "1/2 cup" },
      { name: "Coriander leaves", quantity: "1/2 cup" },
      { name: "Saffron", quantity: "a pinch, soaked in warm milk" },
      { name: "Ghee", quantity: "4 tbsp" },
      { name: "Whole spices (bay leaf, cinnamon, cloves)", quantity: "1 set" },
    ],
    description: [
      "Marinate chicken in yogurt, biryani masala, and half the fried onions for 1 hour.",
      "Par-boil basmati rice with whole spices until 70% cooked, then drain.",
      "Cook the marinated chicken in a heavy-bottomed pot until nearly done.",
      "Layer the par-boiled rice over the chicken.",
      "Top with remaining fried onions, mint, coriander, and saffron milk.",
      "Cover tightly and cook on dum (low heat) for 20-25 minutes.",
      "Rest for 10 minutes before gently fluffing and serving.",
    ].join("\n"),
  },
  {
    id: "recipe_veg_hakka_noodles",
    name: "Veg Hakka Noodles",
    ingredients: [
      { name: "Hakka noodles", quantity: "300 g" },
      { name: "Cabbage", quantity: "1 cup, shredded" },
      { name: "Carrot", quantity: "1 cup, julienned" },
      { name: "Capsicum", quantity: "1 cup, julienned" },
      { name: "Spring onion", quantity: "1/2 cup, chopped" },
      { name: "Soy sauce", quantity: "2 tbsp" },
      { name: "Vinegar", quantity: "1 tbsp" },
      { name: "Green chilli sauce", quantity: "1 tbsp" },
      { name: "Garlic", quantity: "1 tbsp, minced" },
      { name: "Oil", quantity: "3 tbsp" },
    ],
    description: [
      "Boil noodles until al dente, drain, and toss with a little oil to prevent sticking.",
      "Heat oil in a wok on high heat and sauté minced garlic until fragrant.",
      "Add all the vegetables and stir-fry on high heat for 2-3 minutes.",
      "Add soy sauce, vinegar, and green chilli sauce, mix well.",
      "Toss in the boiled noodles and combine everything on high heat.",
      "Garnish with spring onion greens and serve immediately.",
    ].join("\n"),
  },
  {
    id: "recipe_masala_dosa",
    name: "Masala Dosa",
    ingredients: [
      { name: "Dosa batter", quantity: "500 ml" },
      { name: "Potato", quantity: "4 medium, boiled" },
      { name: "Onion", quantity: "1 large, sliced" },
      { name: "Mustard seeds", quantity: "1 tsp" },
      { name: "Curry leaves", quantity: "1 sprig" },
      { name: "Turmeric powder", quantity: "1/2 tsp" },
      { name: "Green chilli", quantity: "2, slit" },
      { name: "Oil", quantity: "as needed" },
      { name: "Salt", quantity: "to taste" },
    ],
    description: [
      "For the filling: temper mustard seeds and curry leaves in oil.",
      "Add sliced onion and green chilli, sauté until translucent.",
      "Add turmeric, mashed boiled potatoes, and salt; mix well and set aside.",
      "Heat a dosa tawa and spread a ladle of batter into a thin circle.",
      "Drizzle oil around the edges and cook until golden and crisp.",
      "Place a portion of the potato filling in the center and fold.",
      "Serve hot with coconut chutney and sambar.",
    ].join("\n"),
  },
  {
    id: "recipe_mutton_rogan_josh",
    name: "Mutton Rogan Josh",
    ingredients: [
      { name: "Mutton", quantity: "1 kg, curry cut" },
      { name: "Yogurt", quantity: "1 cup" },
      { name: "Kashmiri red chilli powder", quantity: "3 tbsp" },
      { name: "Fennel powder", quantity: "2 tbsp" },
      { name: "Ginger powder (saunth)", quantity: "1 tbsp" },
      { name: "Asafoetida", quantity: "a pinch" },
      { name: "Mustard oil", quantity: "5 tbsp" },
      { name: "Whole spices (bay leaf, cardamom, cloves)", quantity: "1 set" },
      { name: "Salt", quantity: "to taste" },
    ],
    description: [
      "Heat mustard oil until smoking, then let it cool slightly.",
      "Add whole spices and asafoetida, sauté for 30 seconds.",
      "Add mutton pieces and sear on high heat until browned.",
      "Whisk yogurt with chilli powder and fennel powder, then stir into the pot.",
      "Add ginger powder and salt, cover, and cook on low heat until tender.",
      "Adjust the gravy consistency with warm water as needed.",
      "Simmer until the oil surfaces on top, then serve hot.",
    ].join("\n"),
  },
  {
    id: "recipe_margherita_pizza",
    name: "Margherita Pizza",
    ingredients: [
      { name: "Pizza dough", quantity: "1 ball (250 g)" },
      { name: "Tomato sauce", quantity: "1/2 cup" },
      { name: "Mozzarella cheese", quantity: "150 g, shredded" },
      { name: "Fresh basil leaves", quantity: "8-10" },
      { name: "Olive oil", quantity: "2 tbsp" },
      { name: "Salt", quantity: "to taste" },
    ],
    description: [
      "Preheat the oven (or pizza oven) to its highest setting.",
      "Roll out the pizza dough into a round base on a floured surface.",
      "Spread tomato sauce evenly, leaving a small border for the crust.",
      "Scatter shredded mozzarella evenly over the sauce.",
      "Bake until the crust is golden and the cheese is bubbling.",
      "Remove from the oven, top with fresh basil and a drizzle of olive oil.",
      "Slice and serve immediately.",
    ].join("\n"),
  },
  {
    id: "recipe_dal_makhani",
    name: "Dal Makhani",
    ingredients: [
      { name: "Whole black urad dal", quantity: "1 cup, soaked overnight" },
      { name: "Rajma (kidney beans)", quantity: "1/4 cup, soaked overnight" },
      { name: "Butter", quantity: "4 tbsp" },
      { name: "Fresh cream", quantity: "1/4 cup" },
      { name: "Tomato puree", quantity: "1 cup" },
      { name: "Ginger-garlic paste", quantity: "1 tbsp" },
      { name: "Kashmiri red chilli powder", quantity: "1 tsp" },
      { name: "Garam masala", quantity: "1/2 tsp" },
      { name: "Salt", quantity: "to taste" },
    ],
    description: [
      "Pressure cook the soaked dal and rajma with salt until soft, about 6-8 whistles.",
      "Heat butter in a pan and sauté ginger-garlic paste until golden.",
      "Add tomato puree and cook until the oil separates.",
      "Add chilli powder and garam masala, then stir in the cooked dal.",
      "Simmer on low heat for at least 30 minutes, mashing some dal for creaminess.",
      "Stir in fresh cream and a knob of butter just before serving.",
      "Serve hot with a swirl of cream and naan or rice.",
    ].join("\n"),
  },
  {
    id: "recipe_fish_amritsari",
    name: "Fish Amritsari",
    ingredients: [
      { name: "Fish fillets (basa/sole)", quantity: "500 g" },
      { name: "Gram flour (besan)", quantity: "1/2 cup" },
      { name: "Carom seeds (ajwain)", quantity: "1 tsp" },
      { name: "Ginger-garlic paste", quantity: "1 tbsp" },
      { name: "Turmeric powder", quantity: "1/2 tsp" },
      { name: "Red chilli powder", quantity: "1 tsp" },
      { name: "Lemon juice", quantity: "2 tbsp" },
      { name: "Oil", quantity: "for deep frying" },
      { name: "Salt", quantity: "to taste" },
    ],
    description: [
      "Cut fish fillets into finger-sized strips and pat dry.",
      "Marinate with ginger-garlic paste, turmeric, chilli powder, lemon juice, and salt for 20 minutes.",
      "Make a thick batter with gram flour, carom seeds, and a little water.",
      "Coat the marinated fish strips evenly in the batter.",
      "Heat oil and deep fry the fish until golden and crisp.",
      "Drain on paper towels and serve hot with mint chutney and lemon wedges.",
    ].join("\n"),
  },
  {
    id: "recipe_veg_manchurian",
    name: "Veg Manchurian",
    ingredients: [
      { name: "Cabbage", quantity: "2 cups, finely shredded" },
      { name: "Carrot", quantity: "1/2 cup, grated" },
      { name: "Corn flour", quantity: "4 tbsp" },
      { name: "All-purpose flour", quantity: "2 tbsp" },
      { name: "Garlic", quantity: "1 tbsp, minced" },
      { name: "Ginger", quantity: "1 tbsp, minced" },
      { name: "Soy sauce", quantity: "2 tbsp" },
      { name: "Tomato ketchup", quantity: "3 tbsp" },
      { name: "Green chilli sauce", quantity: "1 tbsp" },
      { name: "Spring onion", quantity: "1/2 cup, chopped" },
      { name: "Oil", quantity: "for frying" },
    ],
    description: [
      "Mix cabbage, carrot, corn flour, and all-purpose flour with a little salt to form a dough.",
      "Shape into small balls and deep fry until golden and crisp; set aside.",
      "In a separate wok, sauté minced garlic and ginger in oil.",
      "Add soy sauce, ketchup, and green chilli sauce with a splash of water; bring to a simmer.",
      "Thicken the sauce slightly with a corn flour slurry if needed.",
      "Toss the fried balls into the sauce just before serving so they stay crisp.",
      "Garnish with spring onion greens and serve hot.",
    ].join("\n"),
  },
  {
    id: "recipe_gulab_jamun",
    name: "Gulab Jamun",
    ingredients: [
      { name: "Khoya (mawa)", quantity: "250 g" },
      { name: "All-purpose flour", quantity: "2 tbsp" },
      { name: "Baking soda", quantity: "1/4 tsp" },
      { name: "Sugar", quantity: "2 cups (for syrup)" },
      { name: "Water", quantity: "2 cups (for syrup)" },
      { name: "Cardamom powder", quantity: "1/2 tsp" },
      { name: "Rose water", quantity: "1 tsp" },
      { name: "Ghee/oil", quantity: "for deep frying" },
    ],
    description: [
      "Prepare sugar syrup by boiling sugar and water with cardamom powder until slightly sticky; keep warm.",
      "Knead khoya, flour, and baking soda together into a smooth, crack-free dough.",
      "Divide into small balls, rolling gently to avoid cracks.",
      "Heat ghee/oil on low-medium heat and fry the balls slowly until evenly golden brown.",
      "Drain and immediately drop the hot jamuns into the warm sugar syrup.",
      "Let them soak for at least 1-2 hours before serving.",
      "Finish with a few drops of rose water before serving.",
    ].join("\n"),
  },
];

async function seedRecipes() {
  if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI not set. Make sure .env is present.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const Recipe = mongoose.models.recipes || mongoose.model("recipes", anySchema, "recipes");

  const del = await Recipe.deleteMany({});
  console.log(`Cleared ${del.deletedCount} existing recipe(s).`);

  const inserted = await Recipe.insertMany(RECIPES);
  console.log(`Inserted ${inserted.length} new recipe(s).`);

  await mongoose.disconnect();
  console.log("Done.");
}

seedRecipes().catch((err) => {
  console.error("❌ Failed to seed recipes:", err.message);
  process.exit(1);
});
