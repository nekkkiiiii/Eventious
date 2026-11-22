const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");

// Return DATE columns as plain "YYYY-MM-DD" strings, avoiding timezone shifts.
types.setTypeParser(1082, (v) => v);

/**
 * Connection: set DATABASE_URL (or POSTGRES_URL, which Vercel/Neon add automatically)
 * to your provider's connection string, e.g.
 *   postgresql://user:password@host/dbname?sslmode=require
 */
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

const pool = new Pool({
  connectionString,
  max: process.env.VERCEL ? 3 : 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});
pool.on("error", (err) => console.error("Postgres pool error:", err.message));

let initPromise;

/** Creates the tables if they don't exist. Runs once per process (and retries after a failure). */
function init() {
  initPromise ||= setup().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

async function setup() {
  if (!connectionString && !process.env.PGHOST) {
    throw new Error("DATABASE_URL is not set.");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Stop two server instances from creating the tables at the same moment.
    await client.query("SELECT pg_advisory_xact_lock(4207531)");
    await client.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const getPool = () => pool;

module.exports = { init, getPool };
