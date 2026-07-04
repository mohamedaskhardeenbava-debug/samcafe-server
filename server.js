require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const JSON_SERVER = process.env.JSON_SERVER_URL || "http://localhost:5000";
const PORT = process.env.PORT || 4000;

/* ─────────────────────────────────────────
   BELL STATE (in-memory)
───────────────────────────────────────── */
let activeBells = {};

/* ─────────────────────────────────────────
   PRINTER BRIDGE RELAY STATE
   The local print-bridge (running next to the physical Epson
   printer) connects out to this server as a normal socket.io
   client and registers itself. Admin/user panels never talk to
   it directly — everything is relayed through here, so no public
   IP/port/tunnel is ever needed on the cafe's local network.
───────────────────────────────────────── */
let printerSocketId = null;

// jobId -> { requesterSocketId, timeout }
const pendingPrintJobs = new Map();
const PRINT_JOB_TIMEOUT_MS = 15000;

function isPrinterOnline() {
  return !!(printerSocketId && io.sockets.sockets.get(printerSocketId));
}

/* ─────────────────────────────────────────
   SOCKET CONNECTION
───────────────────────────────────────── */
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.emit("bell-sync", activeBells);

  // Tell the newly connected client current printer status right away
  socket.emit("printer:status", { online: isPrinterOnline() });

  socket.on("bell-ring", (payload) => {
    const { tableNo } = payload || {};
    if (!tableNo) {
      console.warn("bell-ring received with no tableNo, ignoring");
      return;
    }
    activeBells[tableNo] = true;
    console.log(`🔔 Bell ring from table ${tableNo}`);
    io.emit("bell-ring", { tableNo });
  });

  socket.on("bell-off", (payload) => {
    const { tableNo } = payload || {};
    if (!tableNo) return;
    delete activeBells[tableNo];
    console.log(`🔕 Bell off for table ${tableNo}`);
    io.emit("bell-off", { tableNo });
  });

  socket.on("theme-update", (payload) => {
    console.log("📡 Theme update broadcast from admin");
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
    console.log(`🖨️  Printer bridge registered: ${socket.id}`);
    socket.emit("printer:register-ack", { ok: true });
    io.emit("printer:status", { online: true });
  });

  // Any client (admin/user panel) asking for current printer status
  socket.on("printer:status-check", () => {
    socket.emit("printer:status", { online: isPrinterOnline() });
  });

  /* ── Panel requests a print job ──
     Payload: { jobId, jobType: "kot" | "bill" | "test", order }
     jobId is generated client-side (e.g. crypto.randomUUID()) so the
     requester can match the eventual result. */
  socket.on("printer:print", (payload) => {
    const { jobId, jobType, order } = payload || {};
    if (!jobId || !jobType) {
      socket.emit("printer:result", { jobId, success: false, error: "Missing jobId or jobType" });
      return;
    }
    if (!isPrinterOnline()) {
      socket.emit("printer:result", { jobId, success: false, error: "Printer bridge is offline" });
      return;
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
    console.log("Client disconnected:", socket.id);
    if (socket.id === printerSocketId) {
      printerSocketId = null;
      console.log("🖨️  Printer bridge disconnected");
      io.emit("printer:status", { online: false });
    }
  });
});

/* ─────────────────────────────────────────
   HELPER: GET ALL USERS
───────────────────────────────────────── */
async function getUsers() {
  const res = await axios.get(`${JSON_SERVER}/users`);
  return res.data;
}

/* ─────────────────────────────────────────
   HELPER: UPDATE USER
───────────────────────────────────────── */
async function updateUser(user) {
  await axios.put(`${JSON_SERVER}/users/${user.id}`, user);
}

/* ─────────────────────────────────────────
   HELPER: GENERATE NEXT ORDER ID
   Fetches the top 10 orders sorted by id desc,
   finds the true max number, increments by 1.
   Retries once if the generated id already exists.
───────────────────────────────────────── */
async function generateOrderId() {
  const res = await axios.get(
    `${JSON_SERVER}/orders?_sort=id&_order=desc&_limit=10`
  );
  const orders = res.data || [];

  const maxNum =
    orders.length > 0
      ? Math.max(
        ...orders
          .map((o) => parseInt(o.id?.replace("order_", "")) || 0)
          .filter((n) => !isNaN(n))
      )
      : 0;

  const candidate = `order_${String(maxNum + 1).padStart(5, "0")}`;

  // Safety check: if this ID already exists, go one higher
  try {
    await axios.get(`${JSON_SERVER}/orders/${candidate}`);
    // If we reach here, it exists — go one higher
    return `order_${String(maxNum + 2).padStart(5, "0")}`;
  } catch {
    // 404 means it doesn't exist — safe to use
    return candidate;
  }
}

/* ─────────────────────────────────────────
   📦 GET ALL ORDERS
   Reads directly from the orders collection.
   ⚠️  Must be defined BEFORE generic /:resource
───────────────────────────────────────── */
app.get("/orders", async (req, res) => {
  try {
    const r = await axios.get(`${JSON_SERVER}/orders`, { params: req.query });
    res.json(r.data);
  } catch (err) {
    console.error("GET /orders failed:", err.message);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* ─────────────────────────────────────────
   ➕ CREATE ORDER
   - Generates safe incremental ID server-side
   - Saves to global orders collection
   - Also embeds in user if userId is present
   - Handles guests (null userId) without error
   ⚠️  Must be defined BEFORE generic /:resource
───────────────────────────────────────── */
app.post("/orders", async (req, res) => {
  try {
    const newOrder = req.body;

    // 🔹 Always generate the ID server-side — never trust client ID
    newOrder.id = await generateOrderId();
    console.log(`🧾 Assigning order ID: ${newOrder.id}`);

    // 1. Save to the global orders collection
    const savedRes = await axios.post(`${JSON_SERVER}/orders`, newOrder);
    const savedOrder = savedRes.data;

    // 2. If logged-in user, also embed inside user record
    if (newOrder.userId) {
      try {
        const users = await getUsers();
        const user = users.find((u) => u.id === newOrder.userId);
        if (user) {
          user.orders = user.orders || [];
          user.orders.push(savedOrder);
          await updateUser(user);
        }
      } catch (embedErr) {
        // Don't fail the whole order if user embedding fails
        console.warn("Could not embed order in user:", embedErr.message);
      }
    }

    broadcast("ordersUpdated");
    io.emit("data-change", {
      resource: "orders",
      action: "created",
      payload: savedOrder
    });
    res.json(savedOrder);
  } catch (err) {
    console.error("POST /orders failed:", err.message);
    console.error("json-server response:", err.response?.status, err.response?.data);
    res.status(500).json({ error: "Failed to create order" });
  }
});

/* ─────────────────────────────────────────
   🔄 UPDATE ITEM STATUS
───────────────────────────────────────── */
app.patch("/orders/:orderId/item", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { itemIndex, status } = req.body;

    const orderRes = await axios.get(`${JSON_SERVER}/orders/${orderId}`);
    const order = orderRes.data;

    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.items[itemIndex])
      return res.status(400).json({ error: "Invalid item index" });

    order.items[itemIndex].status = status;
    const allDone = order.items.every((i) => i.status === "completed");
    if (allDone) order.status = "completed";
    order.updatedAt = new Date().toISOString();

    await axios.put(`${JSON_SERVER}/orders/${orderId}`, order);

    // Sync into user record if userId present
    if (order.userId) {
      try {
        const users = await getUsers();
        const user = users.find((u) => u.id === order.userId);
        if (user) {
          const userOrder = user.orders?.find((o) => o.id === orderId);
          if (userOrder) {
            userOrder.items[itemIndex].status = status;
            if (allDone) userOrder.status = "completed";
            userOrder.updatedAt = order.updatedAt;
            await updateUser(user);
          }
        }
      } catch (syncErr) {
        console.warn("Could not sync item status to user:", syncErr.message);
      }
    }

    io.emit("data-change", { resource: "orders", action: "updated" });
    return res.json({ success: true, order });
  } catch (err) {
    console.error("PATCH /orders/:orderId/item failed:", err.message);
    res.status(500).json({ error: "Failed to update item" });
  }
});

/* ─────────────────────────────────────────
   🔥 BULK ORDER STATUS UPDATE
───────────────────────────────────────── */
app.patch("/orders/:orderId/status", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const orderRes = await axios.get(`${JSON_SERVER}/orders/${orderId}`);
    const order = orderRes.data;

    if (!order) return res.status(404).json({ error: "Order not found" });

    order.status = status;
    order.items = order.items.map((i) => ({ ...i, status }));
    order.updatedAt = new Date().toISOString();

    await axios.put(`${JSON_SERVER}/orders/${orderId}`, order);

    // Sync into user record if userId present
    if (order.userId) {
      try {
        const users = await getUsers();
        const user = users.find((u) => u.id === order.userId);
        if (user) {
          const userOrder = user.orders?.find((o) => o.id === orderId);
          if (userOrder) {
            userOrder.status = status;
            userOrder.items = userOrder.items.map((i) => ({ ...i, status }));
            userOrder.updatedAt = order.updatedAt;
            await updateUser(user);
          }
        }
      } catch (syncErr) {
        console.warn("Could not sync status to user:", syncErr.message);
      }
    }

    broadcast("ordersUpdated");
    return res.json(order);
  } catch (err) {
    console.error("PATCH /orders/:orderId/status failed:", err.message);
    res.status(500).json({ error: "Failed to update order" });
  }
});

/* ─────────────────────────────────────────
   🔁 GENERIC JSON SERVER PROXY
   ⚠️  These must come AFTER all specific routes
───────────────────────────────────────── */

// GET all (supports query strings like ?_sort=id&_order=desc&_limit=1)
app.get("/:resource", async (req, res) => {
  try {
    const r = await axios.get(
      `${JSON_SERVER}/${req.params.resource}`,
      { params: req.query }
    );
    res.json(r.data);
  } catch (err) {
    console.error("GET ERROR:", err.message || err);
    res.status(500).json({ error: "Failed to fetch resource" });
  }
});

// GET by id
app.get("/:resource/:id", async (req, res) => {
  try {
    const r = await axios.get(
      `${JSON_SERVER}/${req.params.resource}/${req.params.id}`
    );
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch resource by id" });
  }
});

// POST
app.post("/:resource", async (req, res) => {
  try {
    const r = await axios.post(
      `${JSON_SERVER}/${req.params.resource}`,
      req.body
    );
    io.emit("data-change", {
      resource: req.params.resource,
      action: "created",
      payload: r.data
    });

    // 🔔 Notify admin panel for new bookings
    const BOOKING_META = {
      eventBookings: { label: "New event booking", route: "/event-bookings" },
      reservations: { label: "New reservation", route: "/reservations" },
      celebrations: { label: "New celebration booking", route: "/celebrations" },
      cateringOrders: { label: "New catering order", route: "/catering" },
      preBookings: { label: "New pre-booking", route: "/pre-bookings" },
    };
    const meta = BOOKING_META[req.params.resource];
    if (meta) {
      const name = req.body.name || req.body.userName || "";
      io.emit("new-booking", {
        resource: req.params.resource,
        message: name ? `${meta.label} — ${name}` : meta.label,
        route: meta.route,
      });
    }

    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Failed to create resource" });
  }
});

// PUT by id
app.put("/:resource/:id", async (req, res) => {
  try {
    const r = await axios.put(
      `${JSON_SERVER}/${req.params.resource}/${req.params.id}`,
      req.body
    );
    io.emit("data-change", {
      resource: req.params.resource,
      action: "updated",
      payload: r.data
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Failed to update resource" });
  }
});

// PUT all (bulk)
app.put("/:resource", async (req, res) => {
  try {
    const data = req.body;
    await axios.put(`${JSON_SERVER}/${req.params.resource}`, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Bulk update failed" });
  }
});

// HELPER: recursively strip all null values from any object/array
function stripNulls(value) {
  if (Array.isArray(value)) {
    return value.map(stripNulls);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNulls(v)])
    );
  }
  return value;
}

// HELPER: deep-check if an object contains any null anywhere
function hasNulls(value) {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(hasNulls);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasNulls);
  }
  return false;
}

// DELETE by id
// json-server scans ALL collections for FK references on every DELETE.
// Any null — even nested inside items[] — causes a cascade crash.
// Fix: deep-strip all nulls from every collection before issuing the DELETE.
app.delete("/:resource/:id", async (req, res) => {
  const { resource, id } = req.params;
  try {
    // Step 1 — get all collection names from json-server root
    const rootRes = await axios.get(`${JSON_SERVER}`);
    const collectionNames = Object.keys(rootRes.data || {});

    // Step 2 — deep-clean nulls from every array collection
    await Promise.allSettled(
      collectionNames.map(async (col) => {
        try {
          const colRes = await axios.get(`${JSON_SERVER}/${col}`);
          const items = colRes.data;
          if (!Array.isArray(items)) return;

          // Only update records that actually have nulls (shallow or nested)
          const dirtyItems = items.filter(hasNulls);

          await Promise.allSettled(
            dirtyItems.map((item) => {
              const cleaned = stripNulls(item);
              return axios.put(`${JSON_SERVER}/${col}/${item.id}`, cleaned);
            })
          );
        } catch {
          // skip non-array collections like grooming, mise, kitchenAssign
        }
      })
    );

    // Step 3 — now safe to delete
    await axios.delete(`${JSON_SERVER}/${resource}/${id}`);
    io.emit("data-change", { resource, action: "deleted", id, payload: { id } });
    res.json({ success: true, id });
  } catch (err) {
    console.error(`DELETE /${resource}/${id} failed:`, err.message);
    res.status(500).json({ error: "Failed to delete resource", id });
  }
});

/* ─────────────────────────────────────────
   📡 BROADCAST HELPER
───────────────────────────────────────── */
function broadcast(event) {
  console.log("📡 Broadcast:", event);
  io.emit(event);
}

/* ─────────────────────────────────────────
   🚀 START SERVER
───────────────────────────────────────── */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📦 Proxying to json-server at ${JSON_SERVER}`);
});

/* ─────────────────────────────────────────
   🏓 KEEP-ALIVE SELF-PING
   Prevents Render free tier from spinning
   down after 15 min of inactivity.
   Set SELF_URL env var on Render to your
   Express server's public URL.
───────────────────────────────────────── */
const SELF_URL = process.env.SELF_URL || null;
const DATA_URL = process.env.JSON_SERVER_URL || null;

if (SELF_URL) {
  setInterval(async () => {
    try {
      await axios.get(SELF_URL + "/categories");
      console.log("\u{1F3D3} Keep-alive: server pinged");
    } catch (err) {
      console.warn("\u{1F3D3} Keep-alive server ping failed:", err.message);
    }
  }, 10 * 60 * 1000);
}

if (DATA_URL) {
  setInterval(async () => {
    try {
      await axios.get(DATA_URL + "/categories");
      console.log("\u{1F3D3} Keep-alive: data service pinged");
    } catch (err) {
      console.warn("\u{1F3D3} Keep-alive data ping failed:", err.message);
    }
  }, 10 * 60 * 1000);
}