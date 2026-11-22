const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

/**
 * Hosted MySQL (Aiven, TiDB Cloud, Railway…) needs SSL. Set DB_SSL=true, and if your
 * provider gives you a CA certificate, paste its contents into DB_SSL_CA.
 */
function sslOptions() {
  if (String(process.env.DB_SSL || "").toLowerCase() !== "true") return undefined;
  const ca = process.env.DB_SSL_CA;
  return ca ? { ca: ca.replace(/\\n/g, "\n"), rejectUnauthorized: true } : { rejectUnauthorized: true };
}

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "eventious",
  ssl: sslOptions(),
};

// Connections are opened lazily, so creating the pool here is cheap and never fails.
const pool = mysql.createPool({
  ...config,
  waitForConnections: true,
  connectionLimit: process.env.VERCEL ? 3 : 10,
  dateStrings: true, // return DATE/TIME as plain strings, avoiding timezone shifts
});

let initPromise;

/** Creates the database (if allowed) and tables if they don't exist. Runs once per process. */
function init() {
  initPromise ||= setup().catch((err) => {
    initPromise = null; // let the next request retry
    throw err;
  });
  return initPromise;
}

async function setup() {
  const conn = await mysql.createConnection({
    host: config.host, port: config.port, user: config.user, password: config.password,
    ssl: config.ssl, multipleStatements: true,
  });
  try {
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch (err) {
      // Some hosted providers don't allow CREATE DATABASE; the database must already exist there.
      if (err.code !== "ER_DBACCESS_DENIED_ERROR" && err.code !== "ER_ACCESS_DENIED_ERROR") throw err;
    }
    await conn.changeUser({ database: config.database });
    await conn.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    await migrate(conn);
  } finally {
    await conn.end();
  }
}

/** Upgrades databases created before roles existed. */
async function migrate(conn) {
  const [cols] = await conn.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'",
    [config.database]
  );
  if (!cols.length) {
    await conn.query("ALTER TABLE users ADD COLUMN role ENUM('admin','client') NOT NULL DEFAULT 'client' AFTER password_hash");
  }
  // Make sure there is always an admin: promote the oldest account if none exists.
  const [[{ admins }]] = await conn.query("SELECT COUNT(*) AS admins FROM users WHERE role = 'admin'");
  if (!admins) await conn.query("UPDATE users SET role = 'admin' ORDER BY id LIMIT 1");
}

const getPool = () => pool;

module.exports = { init, getPool, config };
