const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const { logAuditEvent, describeAuditEvent, isLogViewerRole } = require('../lib/auditLog');
const { toMySQLDate } = require('../lib/dates');

// Shared WHERE-clause builder for both /api/history-logs and its CSV export,
// so filtering logic never drifts between the two.
function buildHistoryLogFilters(req) {
  const search = String(req.query.search || '').trim();
  const mainSub = String(req.query.main_sub || '').trim();       // MTC / UTY / BLD
  const childSub = String(req.query.child_sub || '').trim();     // e.g. 'UTY 1'
  const machineNo = Number(req.query.machine_no) || null;
  const machineName = String(req.query.machine_name || '').trim();
  const machineId = String(req.query.machine_id || '').trim();   // kode_mesin / asset code
  const technician = String(req.query.technician || '').trim();
  const status = String(req.query.status || '').trim();
  const startAt = String(req.query.start_at || '').trim();       // date, inclusive
  const endAt = String(req.query.end_at || '').trim();           // date, inclusive

  const filters = [];
  const values = [];

  if (search) {
    filters.push(`(o.machine_name LIKE ? OR o.machine_asset LIKE ? OR o.technician_name LIKE ?
      OR o.preventive_types LIKE ? OR o.department LIKE ? OR o.location LIKE ?)`);
    values.push(...Array(6).fill(`%${search}%`));
  }
  if (mainSub) {
    filters.push('o.sub = ?');
    values.push(mainSub);
  }
  if (childSub) {
    filters.push('m.sub_child = ?');
    values.push(childSub);
  }
  if (machineNo) {
    filters.push('o.machine_no = ?');
    values.push(machineNo);
  }
  if (machineName) {
    filters.push('o.machine_name LIKE ?');
    values.push(`%${machineName}%`);
  }
  if (machineId) {
    filters.push('o.machine_asset LIKE ?');
    values.push(`%${machineId}%`);
  }
  if (technician) {
    filters.push('o.technician_name LIKE ?');
    values.push(`%${technician}%`);
  }
  if (status) {
    filters.push('o.status = ?');
    values.push(status);
  }
  if (startAt) {
    filters.push('COALESCE(o.execution_date, o.preventive_date) >= ?');
    values.push(startAt);
  }
  if (endAt) {
    filters.push('COALESCE(o.execution_date, o.preventive_date) <= ?');
    values.push(endAt);
  }

  return { whereClause: filters.length ? `WHERE ${filters.join(' AND ')}` : '', values };
}

router.get('/api/history-logs', async (req, res) => {
  if (!isLogViewerRole(req.query.role)) {
    return res.status(403).json({ message: 'Only managers and engineering supervisors can view the history log.' });
  }

  try {
    const { whereClause, values } = buildHistoryLogFilters(req);

    const [rows] = await pool.query(
      `SELECT o.id, o.machine_no, o.machine_asset, o.machine_name, o.location, o.department,
              o.sub AS main_sub, m.sub_child,
              o.preventive_types, o.preventive_date, o.execution_date,
              o.start_clock, o.end_clock, o.technician_name, o.status,
              o.approved_by_manager_date, o.approved_by_manager_user,
              o.created_at, o.updated_at
       FROM maintenance_orders o
       JOIN machines m ON m.no = o.machine_no
       ${whereClause}
       ORDER BY COALESCE(o.execution_date, o.preventive_date) ASC, o.id ASC
       LIMIT 5000`,
      values,
    );

    res.json(rows);
  } catch (error) {
    console.error('Fetch history logs failed:', error);
    res.status(500).json({ message: 'Failed to fetch history logs' });
  }
});

router.get('/api/history-logs/export', async (req, res) => {
  if (!isLogViewerRole(req.query.role)) {
    return res.status(403).json({ message: 'Only managers and engineering supervisors can export the history log.' });
  }

  try {
    const { whereClause, values } = buildHistoryLogFilters(req);
    const userId = Number(req.query.user_id) || null;

    const [rows] = await pool.query(
      `SELECT o.id, o.machine_asset, o.machine_name, o.location, o.department,
              o.sub AS main_sub, m.sub_child,
              o.preventive_types, o.preventive_date, o.execution_date,
              o.start_clock, o.end_clock, o.technician_name, o.status
       FROM maintenance_orders o
       JOIN machines m ON m.no = o.machine_no
       ${whereClause}
       ORDER BY COALESCE(o.execution_date, o.preventive_date) ASC, o.id ASC
       LIMIT 20000`,
      values,
    );

    await logAuditEvent(req, {
      userId,
      eventType: 'HISTORY_LOG_EXPORT',
      entityType: 'maintenance_orders',
      actionLabel: 'CSV export',
      metadata: { rowCount: rows.length },
    });

    const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const columns = [
      'Main Sub', 'Child Sub', 'Machine Asset', 'Machine Name', 'Department', 'Location',
      'Preventive Type', 'Scheduled Date', 'Execution Date', 'Start', 'End', 'Technician', 'Status',
    ];
    const lines = rows.map((row) => [
      row.main_sub,
      row.sub_child,
      row.machine_asset,
      row.machine_name,
      row.department,
      row.location,
      row.preventive_types,
      row.preventive_date,
      row.execution_date,
      row.start_clock,
      row.end_clock,
      row.technician_name,
      row.status,
    ].map(escapeCsv).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pmo-history-logs.csv"');
    res.send(`\uFEFF${columns.map(escapeCsv).join(',')}\n${lines.join('\n')}`);
  } catch (error) {
    console.error('Export history logs failed:', error);
    res.status(500).json({ message: 'Failed to export history logs' });
  }
});

router.post('/api/history-logs/import', async (req, res) => {
  if (!isLogViewerRole(req.body.role)) {
    return res.status(403).json({ message: 'Only managers and engineering supervisors can import history log records.' });
  }

  try {
    const items = req.body.items;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: 'items array is required' });
    }

    const [machines] = await pool.query(
      'SELECT no, kode_mesin, nama_mesin, lokasi, departemen, kategori FROM machines',
    );
    const machineByAsset = new Map(machines.map((m) => [String(m.kode_mesin).trim().toLowerCase(), m]));

    const validStatuses = ['In Progress', 'Approval', 'Completed'];
    const values = [];
    const skipped = [];

    items.forEach((item, index) => {
      const assetCode = String(item.machine_asset || '').trim();
      const machine = machineByAsset.get(assetCode.toLowerCase());
      const executionDate = toMySQLDate(item.execution_date);

      if (!machine || !item.preventive_types || !executionDate) {
        skipped.push(`row ${index + 2}`); // +2: 1-based, plus header row
        return;
      }

      const execDate = new Date(executionDate);
      const status = validStatuses.includes(item.status) ? item.status : 'Completed';

      values.push([
        machine.no,
        machine.kode_mesin,
        machine.nama_mesin,
        machine.lokasi || null,
        machine.departemen || null,
        machine.kategori,
        execDate.getFullYear(),
        execDate.getMonth() + 1, // maintenance_orders.month is 1-based (see existing rows)
        Math.min(5, Math.ceil(execDate.getDate() / 7)), // rough week-of-month for legacy rows
        item.preventive_types,
        executionDate,
        executionDate,
        item.start_clock || null,
        item.end_clock || null,
        item.technician_name || null,
        status,
      ]);
    });

    if (!values.length) {
      return res.status(400).json({
        message: 'No valid rows to import. Check Asset_Code, Preventive_Type, and Execution_Date.',
        skipped,
      });
    }

    const [result] = await pool.query(
      `INSERT INTO maintenance_orders
       (machine_no, machine_asset, machine_name, location, department, sub, year, month, week,
        preventive_types, preventive_date, execution_date, start_clock, end_clock, technician_name, status)
       VALUES ?`,
      [values],
    );

    await logAuditEvent(req, {
      eventType: 'HISTORY_LOG_IMPORTED',
      entityType: 'maintenance_orders',
      metadata: { inserted: result.affectedRows, skipped: skipped.length },
    });

    res.status(201).json({ success: true, inserted: result.affectedRows, skipped });
  } catch (error) {
    console.error('Import history logs failed:', error);
    res.status(500).json({ message: 'Failed to import history logs' });
  }
});

module.exports = router;
