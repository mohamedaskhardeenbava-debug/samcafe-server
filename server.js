const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const JSON_SERVER = process.env.JSON_SERVER_URL || "http://localhost:10000";
const PORT = process.env.PORT || 4000;

/* ─────────────────────────────────────────
   BELL STATE (in-memory)
───────────────────────────────────────── */
let activeBells = {};

/* ─────────────────────────────────────────
   SOCKET CONNECTION
───────────────────────────────────────── */
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.emit("bell-sync", activeBells);

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

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
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
   📦 GET ALL ORDERS (FLATTENED)
   ⚠️  Must be defined BEFORE generic /:resource
───────────────────────────────────────── */
app.get("/orders", async (req, res) => {
  try {
    const users = await getUsers();
    const orders = users.flatMap((u) =>
      (u.orders || []).map((o) => ({ ...o, userId: u.id }))
    );
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/* ─────────────────────────────────────────
   ➕ CREATE ORDER
   ⚠️  Must be defined BEFORE generic /:resource
───────────────────────────────────────── */
app.post("/orders", async (req, res) => {
  try {
    const newOrder = req.body;
    const users = await getUsers();
    const user = users.find((u) => u.id === newOrder.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.orders = user.orders || [];
    user.orders.push(newOrder);
    await updateUser(user);
    broadcast("ordersUpdated");
    res.json(newOrder);
  } catch (err) {
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
    const users = await getUsers();
    for (const user of users) {
      const order = user.orders?.find((o) => o.id === orderId);
      if (order) {
        if (!order.items[itemIndex])
          return res.status(400).json({ error: "Invalid item index" });
        order.items[itemIndex].status = status;
        const allDone = order.items.every((i) => i.status === "completed");
        if (allDone) order.status = "completed";
        order.updatedAt = new Date().toISOString();
        await updateUser(user);
        io.emit("data-change", { resource: "orders", action: "updated" });
        return res.json({ success: true, order });
      }
    }
    res.status(404).json({ error: "Order not found" });
  } catch (err) {
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
    const users = await getUsers();
    for (const user of users) {
      const order = user.orders?.find((o) => o.id === orderId);
      if (order) {
        order.status = status;
        order.items = order.items.map((i) => ({ ...i, status }));
        order.updatedAt = new Date().toISOString();
        await updateUser(user);
        broadcast("ordersUpdated");
        return res.json(order);
      }
    }
    res.status(404).json({ error: "Order not found" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update order" });
  }
});

/* ─────────────────────────────────────────
   🔁 GENERIC JSON SERVER PROXY
   ⚠️  These must come AFTER all specific routes
───────────────────────────────────────── */

// GET all
app.get("/:resource", async (req, res) => {
  try {
    const r = await axios.get(`${JSON_SERVER}/${req.params.resource}`);
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

// DELETE by id
app.delete("/:resource/:id", async (req, res) => {
  const { resource, id } = req.params;
  try {
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
});

/* ─────────────────────────────────────────
   🏓 KEEP-ALIVE SELF-PING
   Prevents Render free tier from spinning
   down after 15 min of inactivity.
   Set SELF_URL env var on Render to your
   Express server's public URL.
   Set DATA_URL env var to your data
   service's public URL.
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