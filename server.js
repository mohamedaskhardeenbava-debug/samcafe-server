require("dotenv").config();
const dns = require("dns");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

dns.setServers(["8.8.8.8", "1.1.1.1"]);

/* ─────────────────────────────────────────
   APP + SOCKET SETUP
───────────────────────────────────────── */
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
  // Allow the default polling->websocket upgrade path instead of forcing
  // websocket-only. A pure-WS connection has no fallback, so any brief
  // network blip (flaky cafe wifi/router) kills it outright instead of
  // degrading gracefully — that was causing the frequent connect/
  // disconnect cycles for the printer bridge seen in the logs.
});

app.use(cors({
  origin: [
    "https://sam-cafe-admin.vercel.app",
    "https://samcafe.vercel.app"
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/* ─────────────────────────────────────────
   MONGOOSE — GENERIC SCHEMA
───────────────────────────────────────── */
const anySchema = new mongoose.Schema(
  {},
  { strict: false, timestamps: false, versionKey: false, id: false }
);

const modelCache = {};
function getModel(collectionName) {
  if (modelCache[collectionName]) return modelCache[collectionName];
  const model = mongoose.model(collectionName, anySchema, collectionName);
  modelCache[collectionName] = model;
  return model;
}

/* ─────────────────────────────────────────
   COLLECTION REGISTRY

   ARRAY collections   → normal REST CRUD
                          GET /col           list all
                          GET /col/:id       single doc by app "id" field
                          POST /col          create
                          PUT /col/:id       full replace
                          PATCH /col/:id     partial update
                          DELETE /col/:id    remove

   SINGLETON collections → one document per collection, stored with id="singleton"
                          GET /col           returns the object directly (or {})
                          PUT /col           full replace
                          PATCH /col         partial merge

   Source of truth: your MongoDB Atlas collections
───────────────────────────────────────── */
const ARRAY_COLLECTIONS = [
  "users",
  "categories",
  "ingredients",
  "favourites",
  "orders",
  "staff",
  "careers",
  "holidays",
  "recipes",
  "offers",
  "reservations",
  "celebrations",
  "preBookings",
  "cateringOrders",
  "events",
  "eventBookings",
  "tables",
  "serviceActivity",
  "serviceSchedules",
  "kitchenActivity",
  "kitchenSchedules",
  "tasks",
  "combo_offers",
  "combo",
  "callHistory",
  "theme",
  "tablePreferences",
];

// Plain objects in db.json — stored as one doc with id="singleton"
const SINGLETON_COLLECTIONS = [
  "grooming",
  "mise",
  "kitchenAssign",
  "kitchenMise",
  "serviceAssign",
  "serviceGrooming",
  "serviceMise",
];

/* ─────────────────────────────────────────
   HELPERS
───────────────────────────────────────── */

/** Strip MongoDB internal fields from a lean doc before sending to client. */
function stripMeta(doc) {
  if (!doc) return doc;
  const out = { ...doc };
  delete out._id;
  delete out.__v;
  return out;
}

/** Emit a data-change event with a unique eventId to prevent double-firing. */
function emitChange(resource, action, payload) {
  io.emit("data-change", {
    resource,
    action,
    payload,
    eventId: `${resource}_${action}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 7)}`,
  });
}

/** Resources that trigger an admin "new booking" toast on creation. */
const BOOKING_META = {
  eventBookings: { label: "New event booking", route: "/event-bookings" },
  reservations: { label: "New reservation", route: "/reservations" },
  celebrations: { label: "New celebration booking", route: "/celebrations" },
  cateringOrders: { label: "New catering order", route: "/catering" },
  preBookings: { label: "New pre-booking", route: "/pre-bookings" },
};

function notifyNewBooking(resource, body) {
  const meta = BOOKING_META[resource];
  if (!meta) return;
  const name = body.name || body.userName || "";
  io.emit("new-booking", {
    resource,
    message: name ? `${meta.label} — ${name}` : meta.label,
    route: meta.route,
  });
}

/**
 * Generate a safe, incrementing order id like "order_00001".
 * The user-panel sends id:"pending" as a placeholder; the server assigns the real id.
 */
async function generateOrderId() {
  const Model = getModel("orders");
  const docs = await Model.find(
    { id: { $regex: /^order_\d+$/ } },
    { id: 1 }
  ).lean();

  let maxNum = 0;
  for (const d of docs) {
    const n = parseInt(d.id.replace("order_", ""), 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }

  let candidateNum = maxNum + 1;
  let candidate = `order_${String(candidateNum).padStart(5, "0")}`;

  // Guard against rare concurrent-order race
  while (await Model.exists({ id: candidate })) {
    candidateNum += 1;
    candidate = `order_${String(candidateNum).padStart(5, "0")}`;
  }
  return candidate;
}

/* ─────────────────────────────────────────
   AUTH MIDDLEWARE
───────────────────────────────────────── */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* ─────────────────────────────────────────
   AUTH ROUTES
───────────────────────────────────────── */

// POST /auth/register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, ...rest } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "email and password are required" });

    const Model = getModel("users");
    const existing = await Model.findOne({ email }).lean();
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 10);
    const id = String(Date.now());
    const doc = await Model.create({ ...rest, email, password: hash, id });
    const result = stripMeta(doc.toObject());
    delete result.password;

    res.status(201).json(result);
  } catch (err) {
    console.error("POST /auth/register", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "email and password are required" });

    const Model = getModel("users");
    const user = await Model.findOne({ email }).lean();
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const payload = { id: user.id, email: user.email, role: user.role };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

    const { password: _pw, _id, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error("POST /auth/login", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   ORDERS — dedicated create route
   Registered BEFORE the generic loop so it
   takes priority for POST /orders.
   Assigns a real order id server-side and
   embeds the order into the user doc for
   per-user order history / revenue stats.
───────────────────────────────────────── */
app.post("/orders", async (req, res) => {
  try {
    const newOrder = { ...req.body };
    newOrder.id = await generateOrderId();

    const doc = await getModel("orders").create(newOrder);
    const result = stripMeta(doc.toObject());

    // Embed a copy into the user document for quick history lookups
    if (result.userId) {
      try {
        await getModel("users").updateOne(
          { id: result.userId },
          { $push: { orders: result } }
        );
      } catch (embedErr) {
        console.warn("Could not embed order in user doc:", embedErr.message);
      }
    }

    emitChange("orders", "created", result);
    res.status(201).json(result);
  } catch (err) {
    console.error("POST /orders", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────
   ARRAY COLLECTION ROUTES
───────────────────────────────────────── */
ARRAY_COLLECTIONS.forEach((name) => {
  const base = `/${name}`;

  // GET /collection — list all
  app.get(base, async (req, res) => {
    try {
      const docs = await getModel(name).find({}).lean();
      res.json(docs.map(stripMeta));
    } catch (err) {
      console.error(`GET /${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /collection/:id — single document by app "id" field
  app.get(`${base}/:id`, async (req, res) => {
    try {
      const Model = getModel(name);
      let doc = await Model.findOne({ id: req.params.id }).lean();
      // Fallback: allow querying by MongoDB _id
      if (!doc && mongoose.Types.ObjectId.isValid(req.params.id)) {
        doc = await Model.findById(req.params.id).lean();
      }
      if (!doc) return res.status(404).json({ error: "Not found" });
      res.json(stripMeta(doc));
    } catch (err) {
      console.error(`GET /${name}/:id`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /collection — create (orders has its own route above)
  if (name !== "orders") {
    app.post(base, async (req, res) => {
      try {
        const body = { ...req.body };
        if (!body.id) body.id = String(Date.now());
        const doc = await getModel(name).create(body);
        const result = stripMeta(doc.toObject());
        emitChange(name, "created", result);
        notifyNewBooking(name, result);
        res.status(201).json(result);
      } catch (err) {
        console.error(`POST /${name}`, err.message);
        res.status(500).json({ error: err.message });
      }
    });
  }

  // PUT /collection/:id — full replace (upsert so PUT on new id creates it)
  app.put(`${base}/:id`, async (req, res) => {
    try {
      const body = { ...req.body, id: req.params.id };
      const doc = await getModel(name)
        .findOneAndReplace({ id: req.params.id }, body, {
          returnDocument: "after",
          upsert: true,
        })
        .lean();
      const result = stripMeta(doc);
      emitChange(name, "updated", result);
      res.json(result);
    } catch (err) {
      console.error(`PUT /${name}/:id`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /collection/:id — partial update
  app.patch(`${base}/:id`, async (req, res) => {
    try {
      const doc = await getModel(name)
        .findOneAndUpdate(
          { id: req.params.id },
          { $set: req.body },
          { returnDocument: "after" }
        )
        .lean();
      if (!doc) return res.status(404).json({ error: "Not found" });
      const result = stripMeta(doc);
      emitChange(name, "updated", result);
      res.json(result);
    } catch (err) {
      console.error(`PATCH /${name}/:id`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /collection/:id — remove
  app.delete(`${base}/:id`, async (req, res) => {
    try {
      const doc = await getModel(name)
        .findOneAndDelete({ id: req.params.id })
        .lean();
      if (!doc) return res.status(404).json({ error: "Not found" });
      const result = stripMeta(doc);
      emitChange(name, "deleted", result);
      res.json(result);
    } catch (err) {
      console.error(`DELETE /${name}/:id`, err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

/* ─────────────────────────────────────────
   SINGLETON COLLECTION ROUTES
   GET    /collection   → returns the object directly (or {} if not yet seeded)
   PUT    /collection   → full replace (upsert)
   PATCH  /collection   → partial merge update (upsert)
───────────────────────────────────────── */
SINGLETON_COLLECTIONS.forEach((name) => {
  const base = `/${name}`;

  // GET /collection — return singleton object
  app.get(base, async (req, res) => {
    try {
      const doc = await getModel(name).findOne({ id: "singleton" }).lean();
      if (!doc) return res.json({});
      const { _id, __v, id, ...rest } = doc;
      res.json(rest);
    } catch (err) {
      console.error(`GET /${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /collection — full replace singleton
  app.put(base, async (req, res) => {
    try {
      const body = { ...req.body, id: "singleton" };
      const doc = await getModel(name)
        .findOneAndReplace({ id: "singleton" }, body, {
          returnDocument: "after",
          upsert: true,
        })
        .lean();
      const { _id, __v, id, ...result } = doc;
      emitChange(name, "updated", result);
      res.json(result);
    } catch (err) {
      console.error(`PUT /${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /collection — partial update singleton
  app.patch(base, async (req, res) => {
    try {
      const doc = await getModel(name)
        .findOneAndUpdate(
          { id: "singleton" },
          { $set: req.body },
          { returnDocument: "after", upsert: true }
        )
        .lean();
      const { _id, __v, id, ...result } = doc;
      emitChange(name, "updated", result);
      res.json(result);
    } catch (err) {
      console.error(`PATCH /${name}`, err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

/* ─────────────────────────────────────────
   SOCKET.IO
───────────────────────────────────────── */
// In-memory table bell state (ephemeral — acceptable to lose on restart)
let activeBells = {};

/* ── Printer bridge relay state ──
   The local print-bridge (running next to the physical Epson printer)
   connects out to this server as a normal socket.io client and
   registers itself. Admin/user panels never talk to it directly —
   everything is relayed through here, so no public IP/port/tunnel
   is ever needed on the cafe's local network. */
let printerSocketId = null;

// jobId -> { requesterSocketId, timeout }
const pendingPrintJobs = new Map();
const PRINT_JOB_TIMEOUT_MS = 15000;

// If the bridge just dropped, it's usually mid-reconnect a moment later
// (e.g. brief wifi blip). Give it a short grace window to re-register
// before telling the requester it's offline, instead of failing instantly.
const PRINTER_RECONNECT_GRACE_MS = 4000;
let printerOnlineWaiters = []; // resolve callbacks waiting on the bridge to (re)register

function isPrinterOnline() {
  return !!(printerSocketId && io.sockets.sockets.get(printerSocketId));
}

function waitForPrinterOnline(timeoutMs) {
  if (isPrinterOnline()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      printerOnlineWaiters = printerOnlineWaiters.filter((w) => w !== onOnline);
      resolve(false);
    }, timeoutMs);
    function onOnline() {
      clearTimeout(timer);
      resolve(true);
    }
    printerOnlineWaiters.push(onOnline);
  });
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Sync current bell state to the newly connected client
  socket.emit("bell-sync", activeBells);

  // Tell the newly connected client current printer status right away
  socket.emit("printer:status", { online: isPrinterOnline() });

  socket.on("bell-ring", (payload) => {
    const { tableNo } = payload || {};
    if (!tableNo) return;
    activeBells[tableNo] = true;
    io.emit("bell-ring", { tableNo });
  });

  socket.on("bell-off", (payload) => {
    const { tableNo } = payload || {};
    if (!tableNo) return;
    delete activeBells[tableNo];
    io.emit("bell-off", { tableNo });
  });

  socket.on("theme-update", (payload) => {
    socket.broadcast.emit("theme-update", payload);
  });

  /* ── Printer bridge registers itself ──
     Payload: { secret } — a shared secret so random clients can't
     claim to be the printer. Set PRINTER_BRIDGE_SECRET in .env on
     both this server and the local bridge machine. */
  socket.on("printer:register", (payload) => {
    const { secret } = payload || {};
    if (process.env.PRINTER_BRIDGE_SECRET && secret !== process.env.PRINTER_BRIDGE_SECRET) {
      console.warn(`Printer bridge auth failed from ${socket.id}`);
      socket.emit("printer:register-ack", { ok: false, error: "Invalid secret" });
      return;
    }
    printerSocketId = socket.id;
    socket.data.isPrinterBridge = true;
    console.log(`Printer bridge registered: ${socket.id}`);
    socket.emit("printer:register-ack", { ok: true });
    io.emit("printer:status", { online: true });

    // Wake up any print requests that were waiting out the grace period
    const waiters = printerOnlineWaiters;
    printerOnlineWaiters = [];
    waiters.forEach((w) => w());
  });

  // Any client (admin/user panel) asking for current printer status
  socket.on("printer:status-check", () => {
    socket.emit("printer:status", { online: isPrinterOnline() });
  });

  /* ── Panel requests a print job ──
     Payload: { jobId, jobType: "kot" | "bill" | "test", order }
     jobId is generated client-side (e.g. crypto.randomUUID()) so the
     requester can match the eventual result. */
  socket.on("printer:print", async (payload) => {
    const { jobId, jobType, order } = payload || {};
    if (!jobId || !jobType) {
      socket.emit("printer:result", { jobId, success: false, error: "Missing jobId or jobType" });
      return;
    }
    if (!isPrinterOnline()) {
      // Don't fail instantly — the bridge may be mid-reconnect after a
      // brief drop. Wait a short grace period for it to come back.
      const cameBackOnline = await waitForPrinterOnline(PRINTER_RECONNECT_GRACE_MS);
      if (!cameBackOnline) {
        socket.emit("printer:result", { jobId, success: false, error: "Printer bridge is offline" });
        return;
      }
    }

    pendingPrintJobs.set(jobId, { requesterSocketId: socket.id });

    // Safety timeout in case the bridge never responds
    const timer = setTimeout(() => {
      if (pendingPrintJobs.has(jobId)) {
        pendingPrintJobs.delete(jobId);
        io.to(socket.id).emit("printer:result", {
          jobId,
          success: false,
          error: "Print job timed out — printer may be offline or unreachable",
        });
      }
    }, PRINT_JOB_TIMEOUT_MS);
    pendingPrintJobs.get(jobId).timeout = timer;

    io.to(printerSocketId).emit("printer:print", { jobId, jobType, order });
  });

  /* ── Bridge reports the outcome of a job ──
     Payload: { jobId, success, message, error } */
  socket.on("printer:result", (payload) => {
    const { jobId } = payload || {};
    const job = pendingPrintJobs.get(jobId);
    if (!job) return; // already timed out or unknown job
    clearTimeout(job.timeout);
    pendingPrintJobs.delete(jobId);
    io.to(job.requesterSocketId).emit("printer:result", payload);
  });

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
    if (socket.id === printerSocketId) {
      printerSocketId = null;
      console.log("Printer bridge disconnected");
      io.emit("printer:status", { online: false });
    }
  });
});

/* ─────────────────────────────────────────
   HEALTH CHECK
───────────────────────────────────────── */
app.get("/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

/* ─────────────────────────────────────────
   404 FALLBACK
───────────────────────────────────────── */
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

/* ─────────────────────────────────────────
   KEEP-ALIVE SELF-PING
   Prevents Render free tier from spinning
   down after 15 min of inactivity.
   Set SELF_URL in .env to enable.
───────────────────────────────────────── */
const SELF_URL = process.env.SELF_URL || null;
if (SELF_URL) {
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/health`);
      console.log("Keep-alive: self-ping OK");
    } catch (err) {
      console.warn("Keep-alive ping failed:", err.message);
    }
  }, 10 * 60 * 1000); // every 10 minutes
}

/* ─────────────────────────────────────────
   START
───────────────────────────────────────── */
const PORT = process.env.PORT || 4000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("Connected to MongoDB");
    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });