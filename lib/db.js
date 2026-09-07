const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

// Some managed MySQL/MariaDB hosts silently drop idle connections after a
// while - this hourly no-op query keeps the pool's connections alive so the
// first real request after a quiet period doesn't hit a stale connection.
const PING_INTERVAL_MS = 60 * 60 * 1000;
setInterval(() => {
  pool.query('SELECT 1').catch((error) => console.error('[DB keepalive error]', error.message));
}, PING_INTERVAL_MS);

// Confirm the pool can actually reach the database as soon as the server starts,
// rather than only finding out on the first real request.
pool
  .query('SELECT 1')
  .then(() => console.log(`DB (${process.env.DB_NAME}) pool connected`))
  .catch((error) => console.error('DB connection failed:', error.message));

module.exports = pool;
