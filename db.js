const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "eventious",
};

let pool;

/** Creates the database and tables if they don't exist, then opens a connection pool. */
async function init() {
  const conn = await mysql.createConnection({
    host: config.host, port: config.port, user: config.user, password: config.password,
    multipleStatements: true,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.changeUser({ database: config.database });
  await conn.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  await conn.end();

  pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true, // return DATE/TIME as plain strings, avoiding timezone shifts
  });
  return pool;
}

const getPool = () => pool;

module.exports = { init, getPool, config };
