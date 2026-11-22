require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");
const MySQLStore = require("express-mysql-session")(session);
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("./db");

const PORT = Number(process.env.PORT || 3000);
const CATEGORIES = ["Wedding", "Birthday", "Corporate", "School", "Community", "Other"];

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("⚠  SESSION_SECRET not set in .env; using a temporary one (everyone gets logged out on restart).");
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

/* ---------- Helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in." });
  next();
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validates and normalises an event payload from the client. */
function parseEvent(body) {
  const name = str(body.name, 200);
  const date = str(body.date, 10);
  const time = str(body.time, 5);
  if (!name) throw new HttpError(400, "Event name is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) throw new HttpError(400, "A valid date is required.");
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "Time must be HH:MM.");

  const remindDays = [1, 3, 7, 14].includes(Number(body.remindDays)) ? Number(body.remindDays) : 3;
  const category = CATEGORIES.includes(body.category) ? body.category : "Other";

  const needs = (Array.isArray(body.needs) ? body.needs : [])
    .slice(0, 100)
    .map((n) => ({
      name: str(n?.name, 100),
      qty: Math.min(100000, Math.max(1, parseInt(n?.qty, 10) || 1)),
      ready: n?.ready ? 1 : 0,
    }))
    .filter((n) => n.name);

  return {
    name, date, time: time || null, category, remindDays, needs,
    venue: str(body.venue, 200) || null,
    client: str(body.client, 200) || null,
    notes: str(body.notes, 5000) || null,
  };
}

/** Converts DB rows into the shape the frontend uses. */
function toClient(row, needs) {
  return {
    id: String(row.id),
    name: row.name,
    date: row.event_date,
    time: row.event_time ? row.event_time.slice(0, 5) : "",
    venue: row.venue || "",
    client: row.client || "",
    category: row.category,
    remindDays: row.remind_days,
    notes: row.notes || "",
    createdBy: row.creator_name || "",
    needs: needs.map((n) => ({ id: String(n.id), name: n.name, qty: n.qty, ready: !!n.ready })),
  };
}

/** Events are shared: every logged-in user sees all of them. */
async function loadEvents(eventId = null) {
  const pool = db.getPool();
  const base = "SELECT e.*, u.name AS creator_name FROM events e LEFT JOIN users u ON u.id = e.user_id";
  const [rows] = eventId
    ? await pool.query(`${base} WHERE e.id = ?`, [eventId])
    : await pool.query(`${base} ORDER BY e.event_date, e.event_time`);
  if (!rows.length) return [];
  const [needs] = await pool.query(
    "SELECT * FROM event_needs WHERE event_id IN (?) ORDER BY position, id",
    [rows.map((r) => r.id)]
  );
  return rows.map((r) => toClient(r, needs.filter((n) => n.event_id === r.id)));
}

async function saveNeeds(conn, eventId, needs) {
  await conn.query("DELETE FROM event_needs WHERE event_id = ?", [eventId]);
  if (needs.length) {
    await conn.query(
      "INSERT INTO event_needs (event_id, name, qty, ready, position) VALUES ?",
      [needs.map((n, i) => [eventId, n.name, n.qty, n.ready, i])]
    );
  }
}

async function inTransaction(fn) {
  const conn = await db.getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function startSession(req, user) {
  return new Promise((resolve, reject) => {
    // New session ID on login prevents session fixation
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.userName = user.name;
      req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

/* ---------- Auth routes ---------- */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in a few minutes." },
});

function mountRoutes() {
  app.post("/api/register", authLimiter, async (req, res) => {
    const name = str(req.body.name, 100);
    const email = str(req.body.email, 190).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!name) throw new HttpError(400, "Name is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Please enter a valid email.");
    if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
    if (password.length > 72) throw new HttpError(400, "Password must be 72 characters or fewer.");

    const hash = await bcrypt.hash(password, 12);
    try {
      const [result] = await db.getPool().query(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)", [name, email, hash]
      );
      await startSession(req, { id: result.insertId, name });
      res.status(201).json({ user: { id: result.insertId, name, email } });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") throw new HttpError(409, "An account with that email already exists.");
      throw err;
    }
  });

  app.post("/api/login", authLimiter, async (req, res) => {
    const email = str(req.body.email, 190).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const [[user]] = await db.getPool().query("SELECT * FROM users WHERE email = ?", [email]);

    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) throw new HttpError(401, "Incorrect email or password.");

    await startSession(req, user);
    res.json({ user: { id: user.id, name: user.name, email: user.email } });
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("eventious.sid");
      res.json({ ok: true });
    });
  });

  app.get("/api/me", requireAuth, async (req, res) => {
    const [[user]] = await db.getPool().query("SELECT id, name, email FROM users WHERE id = ?", [req.session.userId]);
    if (!user) throw new HttpError(401, "Please log in.");
    res.json({ user });
  });

  /* ---------- Event routes ---------- */
  app.get("/api/events", requireAuth, async (req, res) => {
    res.json({ events: await loadEvents() });
  });

  app.post("/api/events", requireAuth, async (req, res) => {
    const ev = parseEvent(req.body);
    const id = await inTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO events (user_id, name, event_date, event_time, venue, client, category, remind_days, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.session.userId, ev.name, ev.date, ev.time, ev.venue, ev.client, ev.category, ev.remindDays, ev.notes]
      );
      await saveNeeds(conn, result.insertId, ev.needs);
      return result.insertId;
    });
    const [saved] = await loadEvents(id);
    res.status(201).json({ event: saved });
  });

  app.put("/api/events/:id", requireAuth, async (req, res) => {
    const ev = parseEvent(req.body);
    const id = Number(req.params.id);
    await inTransaction(async (conn) => {
      const [result] = await conn.query(
        `UPDATE events SET name = ?, event_date = ?, event_time = ?, venue = ?, client = ?, category = ?,
                remind_days = ?, notes = ? WHERE id = ?`,
        [ev.name, ev.date, ev.time, ev.venue, ev.client, ev.category, ev.remindDays, ev.notes, id]
      );
      if (!result.affectedRows) throw new HttpError(404, "Event not found.");
      await saveNeeds(conn, id, ev.needs);
    });
    const [saved] = await loadEvents(id);
    res.json({ event: saved });
  });

  app.patch("/api/events/:id/needs/:needId", requireAuth, async (req, res) => {
    const [result] = await db.getPool().query(
      `UPDATE event_needs n JOIN events e ON e.id = n.event_id
       SET n.ready = ? WHERE n.id = ? AND e.id = ?`,
      [req.body.ready ? 1 : 0, Number(req.params.needId), Number(req.params.id)]
    );
    if (!result.affectedRows) throw new HttpError(404, "Item not found.");
    const [saved] = await loadEvents(Number(req.params.id));
    res.json({ event: saved });
  });

  app.delete("/api/events/:id", requireAuth, async (req, res) => {
    const [result] = await db.getPool().query(
      "DELETE FROM events WHERE id = ?", [Number(req.params.id)]
    );
    if (!result.affectedRows) throw new HttpError(404, "Event not found.");
    res.json({ ok: true });
  });

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

  /* ---------- Pages ---------- */
  app.get(["/", "/index.html"], (req, res) => {
    if (!req.session.userId) return res.redirect("/login.html");
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });
  app.get("/login.html", (req, res, next) => {
    if (req.session.userId) return res.redirect("/");
    next();
  });
  app.use(express.static(path.join(__dirname, "public"), { index: false }));

  /* ---------- Errors ---------- */
  app.use((err, req, res, next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });
}

/* ---------- Start ---------- */
(async () => {
  try {
    await db.init();
  } catch (err) {
    console.error("✖ Could not connect to MySQL:", err.message);
    console.error("  Is MySQL running (XAMPP Control Panel → Start MySQL)? Check DB_* settings in .env.");
    process.exit(1);
  }

  const store = new MySQLStore({
    host: db.config.host, port: db.config.port, user: db.config.user,
    password: db.config.password, database: db.config.database,
    createDatabaseTable: true,
    clearExpired: true,
  });

  app.use(session({
    name: "eventious.sid",
    secret: SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }));

  mountRoutes();

  app.listen(PORT, () => console.log(`✔ Eventious running at http://localhost:${PORT}`));
})();
