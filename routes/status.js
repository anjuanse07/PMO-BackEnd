const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const pool = require('../lib/db');

// ---------------------------------------------------------------------
// EDIT THESE to match your actual Ubuntu server setup.
// ---------------------------------------------------------------------
// Services managed by systemd (check with: systemctl list-units --type=service)
const SYSTEMD_SERVICES = ['nginx', 'mariadb'];
// Processes managed by PM2 (check with: pm2 list) - use the exact "name" column
const PM2_PROCESSES = ['pmo-backend'];
// ---------------------------------------------------------------------

async function checkSystemdService(name) {
  try {
    const { stdout } = await execAsync(`systemctl is-active ${name}`);
    const status = stdout.trim();
    return { name, type: 'systemd', status, up: status === 'active' };
  } catch (error) {
    // systemctl is-active exits non-zero (and rejects) whenever the service
    // isn't active - the real status ("inactive", "failed", etc.) is still
    // on stdout even though the promise rejected.
    const status = (error.stdout || '').trim() || 'unknown';
    return { name, type: 'systemd', status, up: false };
  }
}

async function checkPm2Processes() {
  try {
    const { stdout } = await execAsync('pm2 jlist');
    const list = JSON.parse(stdout);
    return PM2_PROCESSES.map((name) => {
      const proc = list.find((p) => p.name === name);
      if (!proc) return { name, type: 'pm2', status: 'not found', up: false };
      const status = proc.pm2_env?.status || 'unknown';
      return { name, type: 'pm2', status, up: status === 'online' };
    });
  } catch (error) {
    // pm2 not installed / not on PATH / no processes running under it
    return PM2_PROCESSES.map((name) => ({ name, type: 'pm2', status: 'pm2 unavailable', up: false }));
  }
}

// GET /api/status
// Single-page view of whether everything is actually running: this backend
// process, the database connection, and whatever systemd/PM2 services are
// listed above. No authentication - only add sensitive service names here
// if that's genuinely fine to expose to anyone who can reach this server.
router.get('/api/status', async (req, res) => {
  const startedAt = Date.now();

  let database = { up: false, latencyMs: null, error: null };
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    database = { up: true, latencyMs: Date.now() - dbStart, error: null };
  } catch (error) {
    database = { up: false, latencyMs: null, error: error.message };
  }

  const [systemdResults, pm2Results] = await Promise.all([
    Promise.all(SYSTEMD_SERVICES.map(checkSystemdService)),
    checkPm2Processes(),
  ]);

  const services = [...systemdResults, ...pm2Results];
  const allUp = database.up && services.every((s) => s.up);

  res.json({
    ok: allUp,
    checkedAt: new Date().toISOString(),
    backend: {
      up: true, // if this code is executing at all, the backend is obviously up
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    database,
    services,
    responseTimeMs: Date.now() - startedAt,
  });
});

module.exports = router;
