require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const session = require("express-session");
const PgStore = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("./db");

const PORT = Number(process.env.PORT || 3000);
const CATEGORIES = ["Wedding", "Birthday", "Corporate", "School", "Community", "Other"];

const ON_VERCEL = !!process.env.VERCEL;

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("⚠  SESSION_SECRET not set; using a temporary one (everyone gets logged out on restart)." +
    (ON_VERCEL ? " Set SESSION_SECRET in Vercel → Settings → Environment Variables." : ""));
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Vercel/most hosts sit behind a proxy (needed for secure cookies + rate limiting)

// Make sure the tables exist before handling any request (runs once per server/function instance).
app.use(async (req, res, next) => {
  try {
    await db.init();
    next();
  } catch (err) {
    console.error("✖ Could not connect to the database:", err.message);
    const msg = "The server can't reach its database. Check the DATABASE_URL setting.";
    if (req.path.startsWith("/api/")) return res.status(503).json({ error: msg });
    res.status(503).type("text").send(msg);
  }
});

app.use(session({
  name: "eventious.sid",
  secret: SESSION_SECRET,
  store: new PgStore({
    pool: db.getPool(),
    tableName: "session",
    createTableIfMissing: false, // created by schema.sql
    pruneSessionInterval: ON_VERCEL ? false : 15 * 60, // no background timers in serverless
  }),
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: ON_VERCEL || process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

app.use(express.json({ limit: "100kb" }));

/* ---------- Helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const query = (sql, params) => db.getPool().query(sql, params);

/** Parses a numeric route id; anything invalid is treated as "not found". */
function toId(value, what = "Item") {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw new HttpError(404, `${what} not found.`);
  return id;
}

/** Loads the logged-in user (fresh from the DB, so role changes apply immediately) into req.user. */
async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in." });
  const { rows: [user] } = await query(
    "SELECT id, name, email, role FROM users WHERE id = $1", [req.session.userId]
  );
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Please log in." });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admins only." });
  next();
}

const isAdmin = (user) => user.role === "admin";

/**
 * SQL condition limiting events (alias e) to the ones this user may access.
 * Appends its parameter to `params` so placeholder numbers stay correct.
 */
function eventScope(user, params) {
  if (isAdmin(user)) return "TRUE";
  params.push(user.id);
  return `e.user_id = $${params.length}`;
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

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
      ready: !!n?.ready,
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
    status: row.status,
    reviewNote: row.review_note || "",
    reviewedBy: row.reviewer_name || "",
    reviewedAt: row.reviewed_at,
    needs: needs.map((n) => ({ id: String(n.id), name: n.name, qty: n.qty, ready: !!n.ready })),
  };
}

/** Admins see every event; clients see only their own. */
async function loadEvents(user, eventId = null) {
  const params = [];
  let sql = `SELECT e.*, u.name AS creator_name, r.name AS reviewer_name
             FROM events e
             LEFT JOIN users u ON u.id = e.user_id
             LEFT JOIN users r ON r.id = e.reviewed_by
             WHERE ${eventScope(user, params)}`;
  if (eventId) {
    params.push(eventId);
    sql += ` AND e.id = $${params.length}`;
  }
  const { rows } = await query(`${sql} ORDER BY e.event_date, e.event_time NULLS FIRST`, params);
  if (!rows.length) return [];
  const { rows: needs } = await query(
    "SELECT * FROM event_needs WHERE event_id = ANY($1::int[]) ORDER BY position, id",
    [rows.map((r) => r.id)]
  );
  return rows.map((r) => toClient(r, needs.filter((n) => n.event_id === r.id)));
}

async function saveNeeds(client, eventId, needs) {
  await client.query("DELETE FROM event_needs WHERE event_id = $1", [eventId]);
  if (needs.length) {
    await client.query(
      `INSERT INTO event_needs (event_id, name, qty, ready, position)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::bool[], $5::int[])`,
      [eventId, needs.map((n) => n.name), needs.map((n) => n.qty), needs.map((n) => n.ready), needs.map((_, i) => i)]
    );
  }
}

async function inTransaction(fn) {
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
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
    // The very first account becomes the admin; everyone else signs up as a client.
    const { rows: [user] } = await query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'client' ELSE 'admin' END)
       RETURNING id, name, email, role`,
      [name, email, hash]
    );
    await startSession(req, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    if (err.code === "23505") throw new HttpError(409, "An account with that email already exists.");
    throw err;
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  const email = str(req.body.email, 190).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const { rows: [user] } = await query("SELECT * FROM users WHERE email = $1", [email]);

  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) throw new HttpError(401, "Incorrect email or password.");

  await startSession(req, user);
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("eventious.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

/* ---------- Admin: user management ---------- */
app.get("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { rows: users } = await query(
    `SELECT u.id, u.name, u.email, u.role, u.created_at, COUNT(e.id) AS event_count
     FROM users u LEFT JOIN events e ON e.user_id = u.id
     GROUP BY u.id ORDER BY u.role, u.name`
  );
  res.json({ users: users.map((u) => ({ ...publicUser(u), createdAt: u.created_at, eventCount: Number(u.event_count) })) });
});

app.patch("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = toId(req.params.id, "User");
  const role = req.body.role;
  if (!["admin", "client"].includes(role)) throw new HttpError(400, "Role must be admin or client.");
  if (id === req.user.id && role !== "admin") throw new HttpError(400, "You can't remove your own admin role.");
  const { rowCount } = await query("UPDATE users SET role = $1 WHERE id = $2", [role, id]);
  if (!rowCount) throw new HttpError(404, "User not found.");
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = toId(req.params.id, "User");
  if (id === req.user.id) throw new HttpError(400, "You can't delete your own account.");
  const { rowCount } = await query("DELETE FROM users WHERE id = $1", [id]);
  if (!rowCount) throw new HttpError(404, "User not found.");
  res.json({ ok: true });
});

/* ---------- Event routes ---------- */
app.get("/api/events", requireAuth, async (req, res) => {
  res.json({ events: await loadEvents(req.user) });
});

app.post("/api/events", requireAuth, async (req, res) => {
  const ev = parseEvent(req.body);
  const id = await inTransaction(async (client) => {
    // Admins' own events need no review; clients' events wait for an admin to approve them.
    const admin = isAdmin(req.user);
    const { rows: [row] } = await client.query(
      `INSERT INTO events (user_id, name, event_date, event_time, venue, client, category, remind_days, notes,
                           status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $11::int IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [req.user.id, ev.name, ev.date, ev.time, ev.venue, ev.client, ev.category, ev.remindDays, ev.notes,
       admin ? "approved" : "pending", admin ? req.user.id : null]
    );
    await saveNeeds(client, row.id, ev.needs);
    return row.id;
  });
  const [saved] = await loadEvents(req.user, id);
  res.status(201).json({ event: saved });
});

app.put("/api/events/:id", requireAuth, async (req, res) => {
  const ev = parseEvent(req.body);
  const id = toId(req.params.id, "Event");
  await inTransaction(async (client) => {
    const params = [id];
    const { rows: [found] } = await client.query(
      `SELECT e.id FROM events e WHERE e.id = $1 AND ${eventScope(req.user, params)} FOR UPDATE`, params
    );
    if (!found) throw new HttpError(404, "Event not found.");
    // When a client changes an event, it goes back to the admin for review.
    const resetReview = isAdmin(req.user) ? ""
      : ", status = 'pending', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL";
    await client.query(
      `UPDATE events SET name = $1, event_date = $2, event_time = $3, venue = $4, client = $5, category = $6,
              remind_days = $7, notes = $8, updated_at = now()${resetReview} WHERE id = $9`,
      [ev.name, ev.date, ev.time, ev.venue, ev.client, ev.category, ev.remindDays, ev.notes, id]
    );
    await saveNeeds(client, id, ev.needs);
  });
  const [saved] = await loadEvents(req.user, id);
  res.json({ event: saved });
});

/** Admin approves or declines an event, optionally with a note (a reason is required to decline). */
app.post("/api/events/:id/review", requireAuth, requireAdmin, async (req, res) => {
  const id = toId(req.params.id, "Event");
  const decision = req.body.decision;
  const note = str(req.body.note, 1000) || null;
  if (!["approved", "declined"].includes(decision)) throw new HttpError(400, "Decision must be approved or declined.");
  if (decision === "declined" && !note) throw new HttpError(400, "Please add a note explaining why the event is declined.");
  const { rowCount } = await query(
    `UPDATE events SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $4`,
    [decision, note, req.user.id, id]
  );
  if (!rowCount) throw new HttpError(404, "Event not found.");
  const [saved] = await loadEvents(req.user, id);
  res.json({ event: saved });
});

app.patch("/api/events/:id/needs/:needId", requireAuth, async (req, res) => {
  const eventId = toId(req.params.id);
  const params = [!!req.body.ready, toId(req.params.needId), eventId];
  const { rowCount } = await query(
    `UPDATE event_needs n SET ready = $1 FROM events e
     WHERE e.id = n.event_id AND n.id = $2 AND e.id = $3 AND ${eventScope(req.user, params)}`,
    params
  );
  if (!rowCount) throw new HttpError(404, "Item not found.");
  const [saved] = await loadEvents(req.user, eventId);
  res.json({ event: saved });
});

app.delete("/api/events/:id", requireAuth, async (req, res) => {
  const params = [toId(req.params.id, "Event")];
  const { rowCount } = await query(
    `DELETE FROM events e WHERE e.id = $1 AND ${eventScope(req.user, params)}`, params
  );
  if (!rowCount) throw new HttpError(404, "Event not found.");
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

/* ---------- Start ---------- */
// On Vercel the app is imported by api/index.js; locally we start a normal server.
module.exports = app;

if (require.main === module) {
  db.init()
    .then(() => app.listen(PORT, () => console.log(`✔ Eventious running at http://localhost:${PORT}`)))
    .catch((err) => {
      console.error("✖ Could not connect to the database:", err.message);
      console.error("  Set DATABASE_URL in .env to your PostgreSQL connection string.");
      process.exit(1);
    });
}
