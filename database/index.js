require("dotenv").config(); // ambil data dari file .env
const mysql = require("mysql2");
const util = require("util");

// Konfigurasi pool tetap aktif, namun nilainya diambil dari process.env
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT) || 3306, // Mengonversi teks port menjadi angka
  waitForConnections: true,
  connectionLimit: 10, // Tetap aktif sesuai kode awal Anda
  queueLimit: 0,       // Tetap aktif sesuai kode awal Anda
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

// Fitur PING_INTERVAL (keepalive) Anda tetap berjalan otomatis setiap 1 jam
const PING_INTERVAL = 60 * 60 * 1000;

setInterval(() => {
  db.query("SELECT 1", (err) => {
    if (err) console.error("[DB1 keepalive error]", err.message);
    else console.log("[DB1 keepalive] OK");
  });
}, PING_INTERVAL);

// Cek koneksi awal saat server backend menyala
db.query("SELECT 1", (err) => {
  if (err) return console.error("DB1 error:", err.message);
  console.log(`DB1 (${process.env.DB_NAME}) pool connected`);
});

const query = util.promisify(db.query).bind(db);
module.exports = { db, query };
