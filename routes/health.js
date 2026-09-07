const express = require('express');
const router = express.Router();
const pool = require('../lib/db');

router.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    console.error('Database health check failed:', error);
    res.status(500).json({ ok: false, message: 'MariaDB connection failed' });
  }
});

module.exports = router;
