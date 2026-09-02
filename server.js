const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
});

// MySQL DATETIME columns reject ISO strings like '...T...Z'; normalize to 'YYYY-MM-DD HH:MM:SS'
function toMySQLDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toMySQLDate(value) {
  if (!value) return null;
  const text = String(value);
  const datePart = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePart) return datePart[1];

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

async function logAuditEvent(req, {
  userId = null,
  eventType,
  entityType = null,
  entityId = null,
  pagePath = null,
  actionLabel = null,
  metadata = null,
}) {
  try {
    const effectiveUserId = userId || Number(req.get('x-audit-user-id')) || null;
    await pool.query(
      `INSERT INTO audit_logs
       (user_id, session_id, event_type, entity_type, entity_id, page_path, action_label, metadata, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        effectiveUserId,
        req.get('x-audit-session-id') || null,
        eventType,
        entityType,
        entityId === null ? null : String(entityId),
        pagePath,
        actionLabel,
        metadata ? JSON.stringify(metadata) : null,
        req.ip || null,
        req.get('user-agent') || null,
      ],
    );
  } catch (error) {
    console.error('Write audit log failed:', error);
  }
}

app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    console.error('Database health check failed:', error);
    res.status(500).json({ ok: false, message: 'MariaDB connection failed' });
  }
});

app.post('/api/audit-events', async (req, res) => {
  const { user_id, event_type, page_path, action_label } = req.body;
  const allowedEventTypes = ['PAGE_VIEW'];

  if (!Number(user_id) || !allowedEventTypes.includes(event_type)) {
    return res.status(400).json({ message: 'A user_id and valid event_type are required.' });
  }

  await logAuditEvent(req, {
    userId: Number(user_id),
    eventType: event_type,
    pagePath: typeof page_path === 'string' ? page_path.slice(0, 512) : null,
    actionLabel: typeof action_label === 'string' ? action_label.slice(0, 255) : null,
  });
  res.status(204).end();
});

app.get('/api/audit-logs', async (req, res) => {
  if (String(req.query.role || '').toLowerCase() !== 'manager') {
    return res.status(403).json({ message: 'Only managers can view audit logs.' });
  }

  const pageSize = 50;
  const requestedPage = Number(req.query.page);
  const page = Number.isFinite(requestedPage) ? Math.max(Math.floor(requestedPage), 1) : 1;
  const search = String(req.query.search || '').trim();
  const activity = String(req.query.activity || '').trim();
  const startAt = String(req.query.start_at || '').trim();
  const endAt = String(req.query.end_at || '').trim();
  const filters = [];
  const values = [];

  if (search) {
    filters.push(`(a.event_type LIKE ? OR a.page_path LIKE ? OR a.action_label LIKE ?
      OR a.entity_type LIKE ? OR a.entity_id LIKE ? OR u.nickname LIKE ? OR u.name LIKE ?)`);
    values.push(...Array(7).fill(`%${search}%`));
  }
  if (activity) {
    filters.push('a.event_type LIKE ?');
    values.push(`%${activity}%`);
  }
  if (startAt) {
    filters.push('a.created_at >= ?');
    values.push(startAt);
  }
  if (endAt) {
    filters.push('a.created_at <= ?');
    values.push(endAt);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${whereClause}`,
      values,
    );
    const total = Number(countRow.total);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const [rows] = await pool.query(
      `SELECT a.id, a.user_id, u.nickname, u.name AS user_name, a.session_id,
              a.event_type, a.entity_type, a.entity_id, a.page_path,
              a.action_label, a.metadata, a.ip_address, a.user_agent, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${whereClause}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`,
      [...values, pageSize, (currentPage - 1) * pageSize],
    );
    res.json({ rows, page: currentPage, pageSize, total, totalPages });
  } catch (error) {
    console.error('Fetch audit logs failed:', error);
    res.status(500).json({ message: 'Failed to fetch audit logs.' });
  }
});

app.get('/api/audit-logs/export', async (req, res) => {
  if (String(req.query.role || '').toLowerCase() !== 'manager') {
    return res.status(403).json({ message: 'Only managers can export audit logs.' });
  }

  const format = req.query.format === 'pdf' ? 'pdf' : 'csv';
  const userId = Number(req.query.user_id) || null;
  const activity = String(req.query.activity || '').trim();
  const startAt = String(req.query.start_at || '').trim();
  const endAt = String(req.query.end_at || '').trim();
  const filters = [];
  const values = [];

  if (activity) {
    filters.push('a.event_type LIKE ?');
    values.push(`%${activity}%`);
  }
  if (startAt) {
    filters.push('a.created_at >= ?');
    values.push(startAt);
  }
  if (endAt) {
    filters.push('a.created_at <= ?');
    values.push(endAt);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const [rows] = await pool.query(
          `SELECT a.id, a.user_id, u.nickname, u.name AS user_name, a.session_id,
            a.event_type, a.entity_type, a.entity_id, a.page_path,
            a.action_label, a.metadata, a.ip_address, a.user_agent, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${whereClause}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 10000`,
      values,
    );
    await logAuditEvent(req, {
      userId,
      eventType: 'AUDIT_LOG_EXPORT',
      entityType: 'audit_logs',
      actionLabel: `${format.toUpperCase()} export`,
      metadata: { format, activity: activity || null, startAt: startAt || null, endAt: endAt || null, rowCount: rows.length },
    });

    if (format === 'pdf') {
      return res.json(rows);
    }

    const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const columns = ['Time', 'Activity', 'Account', 'User ID', 'Page', 'Action', 'Entity Type', 'Entity ID', 'IP Address', 'Browser'];
    const lines = rows.map((row) => [
      row.created_at,
      row.event_type,
      row.user_name || row.nickname || 'System',
      row.user_id,
      row.page_path,
      row.action_label,
      row.entity_type,
      row.entity_id,
      row.ip_address,
      row.user_agent,
    ].map(escapeCsv).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pmo-audit-logs.csv"');
    res.send(`\uFEFF${columns.map(escapeCsv).join(',')}\n${lines.join('\n')}`);
  } catch (error) {
    console.error('Export audit logs failed:', error);
    res.status(500).json({ message: 'Failed to export audit logs.' });
  }
});

app.get('/api/machines', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT no, kode_mesin, nama_mesin, lokasi, departemen, kategori, sub_child
      FROM machines
      ORDER BY kategori, sub_child, nama_mesin
    `);

    res.json(rows);
  } catch (error) {
    console.error('Fetch machines failed:', error);
    res.status(500).json({ message: 'Failed to fetch machines' });
  }
});

// Shared WHERE-clause builder for both /api/history-logs and its CSV export,
// so filtering logic never drifts between the two.
function buildHistoryLogFilters(req) {
  const search = String(req.query.search || '').trim();
  const mainSub = String(req.query.main_sub || '').trim();       // MTC / UTY / BLD
  const childSub = String(req.query.child_sub || '').trim();     // e.g. 'UTY 1'
  const machineNo = Number(req.query.machine_no) || null;
  const machineName = String(req.query.machine_name || '').trim();
  const machineId = String(req.query.machine_id || '').trim();   // kode_mesin / asset code
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

// GET /api/history-logs
// Flat list of every preventive-maintenance record ever run on a machine,
// oldest-first, with the machine's main/child sub attached. The frontend
// groups this by main sub -> machine -> chronological entries.
app.get('/api/history-logs', async (req, res) => {
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

// GET /api/history-logs/export
// Same filters as above, flattened to CSV. Logs an audit event, same
// pattern as /api/audit-logs/export.
app.get('/api/history-logs/export', async (req, res) => {
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

// POST /api/history-logs/import
// Bulk-imports LEGACY completed preventive records (from before this
// system existed) directly into maintenance_orders, so they show up in
// the History Log timeline for their machine. Each item is matched to a
// machine by its Asset_Code (kode_mesin). Rows that don't match a known
// machine, or are missing a preventive type / execution date, are skipped.
//
// NOTE: imported rows won't have a matching order_checklist_results
// checklist (there was no digital form for them) - "View Form" on the
// frontend handles that gracefully and says no checklist is on file.
app.post('/api/history-logs/import', async (req, res) => {
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

app.get('/api/technicians', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT technician_name, role, detail_technician_role, technician_main_sub, technician_child_sub
      FROM technicians
      ORDER BY technician_main_sub, technician_name
    `);

    res.json(rows);
  } catch (error) {
    console.error('Fetch technicians failed:', error);
    res.status(500).json({ message: 'Failed to fetch technicians' });
  }
});

app.get('/api/preventive-types', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT id, abbreviation, parameter
      FROM preventive_types
      ORDER BY abbreviation ASC
    `);

    res.json(rows);
  } catch (error) {
    console.error('Fetch preventive types failed:', error);
    res.status(500).json({ message: 'Failed to fetch preventive types' });
  }
});

app.get('/api/machine-parameters', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT mp.*, m.nama_mesin AS machine_name, m.kode_mesin AS machine_asset
      FROM machine_parameters mp
      JOIN machines m ON mp.machine_no = m.no
      ORDER BY mp.machine_no, mp.sort_order, mp.id
    `);

    res.json(rows);
  } catch (error) {
    console.error('Fetch machine parameters failed:', error);
    res.status(500).json({ message: 'Failed to fetch machine parameters' });
  }
});

app.post('/api/machine-parameters', async (req, res) => {
  try {
    const { machine_no, part_master, part_checklist, action, standard, sort_order } = req.body;

    if (!machine_no || !part_master || !part_checklist) {
      return res.status(400).json({ message: 'machine_no, part_master, and part_checklist are required' });
    }

    const [result] = await pool.query(
      `INSERT INTO machine_parameters (machine_no, part_master, part_checklist, action, standard, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [machine_no, part_master, part_checklist, action || null, standard || null, Number(sort_order) || 0]
    );

    await logAuditEvent(req, { eventType: 'MACHINE_PARAMETER_CREATED', entityType: 'machine_parameters', entityId: result.insertId, metadata: { machineNo: machine_no } });

    res.status(201).json({ id: result.insertId, success: true });
  } catch (error) {
    console.error('Create machine parameter failed:', error);
    res.status(500).json({ message: 'Failed to create machine parameter' });
  }
});

app.post('/api/machine-parameters/bulk', async (req, res) => {
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ message: 'items array is required' });
    }

    const values = items
      .filter((item) => item.machine_no && item.part_master && item.part_checklist)
      .map((item) => [
        item.machine_no,
        item.part_master,
        item.part_checklist,
        item.action || null,
        item.standard || null,
        Number(item.sort_order) || 0,
      ]);

    if (!values.length) {
      return res.status(400).json({ message: 'No valid items to import' });
    }

    const [result] = await pool.query(
      `INSERT INTO machine_parameters (machine_no, part_master, part_checklist, action, standard, sort_order) VALUES ?`,
      [values]
    );

    await logAuditEvent(req, { eventType: 'MACHINE_PARAMETERS_IMPORTED', entityType: 'machine_parameters', metadata: { inserted: result.affectedRows } });

    res.status(201).json({ success: true, inserted: result.affectedRows });
  } catch (error) {
    console.error('Bulk create machine parameters failed:', error);
    res.status(500).json({ message: 'Failed to import machine parameters' });
  }
});

app.patch('/api/machine-parameters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { part_master, part_checklist, action, standard, sort_order } = req.body;

    const fields = [];
    const values = [];
    if (part_master !== undefined) { fields.push('part_master = ?'); values.push(part_master); }
    if (part_checklist !== undefined) { fields.push('part_checklist = ?'); values.push(part_checklist); }
    if (action !== undefined) { fields.push('action = ?'); values.push(action); }
    if (standard !== undefined) { fields.push('standard = ?'); values.push(standard); }
    if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(Number(sort_order) || 0); }

    if (!fields.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(Number(id));
    const [result] = await pool.query(
      `UPDATE machine_parameters SET ${fields.join(', ')} WHERE id = ?`,
      values,
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Machine parameter not found' });
    }

    await logAuditEvent(req, { eventType: 'MACHINE_PARAMETER_UPDATED', entityType: 'machine_parameters', entityId: id, metadata: { fields: fields.map((field) => field.split(' ')[0]) } });

    res.json({ success: true, id: Number(id) });
  } catch (error) {
    console.error('Update machine parameter failed:', error);
    res.status(500).json({ message: 'Failed to update machine parameter' });
  }
});

app.delete('/api/machine-parameters/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM machine_parameters WHERE id = ?', [Number(req.params.id)]);
    if (result.affectedRows) {
      await logAuditEvent(req, { eventType: 'MACHINE_PARAMETER_DELETED', entityType: 'machine_parameters', entityId: req.params.id });
    }
    res.json({ success: true, id: Number(req.params.id) });
  } catch (error) {
    console.error('Delete machine parameter failed:', error);
    res.status(500).json({ message: 'Failed to delete machine parameter' });
  }
});

app.get('/api/schedules', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT *
      FROM preventive_schedule
      ORDER BY tahun DESC, bulan ASC, minggu ASC
    `);

    res.json(rows);
  } catch (error) {
    console.error('Fetch schedules failed:', error);
    res.status(500).json({ message: 'Failed to fetch schedules' });
  }
});

app.post('/api/schedules', async (req, res) => {
  try {
    const {
      machine_no,
      machine_asset,
      machine_name,
      department,
      location,
      sub,
      tahun,
      bulan,
      minggu,
      tanggal_jadwal,
      execution_date,
      start_clock,
      end_clock,
      preventive_types,
      technician_name,
      draft_date,
      approved_by_engineering_date,
      approved_by_manager_date,
      status = 'Draft',
      current_role,
    } = req.body;

    if (!machine_no || !sub || !tahun || !bulan || !minggu || !preventive_types) {
      return res.status(400).json({ message: 'Missing required schedule fields' });
    }

    // Only a manager may plan a schedule in a month/year that has already passed
    const now = new Date();
    const isBackdated = Number(tahun) < now.getFullYear()
      || (Number(tahun) === now.getFullYear() && Number(bulan) < now.getMonth());
    if (isBackdated && current_role !== 'manager') {
      return res.status(403).json({ message: 'Only the manager can create a backdated (past month) schedule.' });
    }

    const [result] = await pool.query(
      `
        INSERT INTO preventive_schedule
        (machine_no, machine_asset, machine_name, department, location, sub, tahun, bulan, minggu, tanggal_jadwal, execution_date, start_clock, end_clock, preventive_types, technician_name, draft_date, approved_by_engineering_date, approved_by_manager_date, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        machine_no,
        machine_asset || null,
        machine_name || null,
        department || null,
        location || null,
        sub,
        tahun,
        bulan,
        minggu,
        tanggal_jadwal || null,
        execution_date || null,
        start_clock || null,
        end_clock || null,
        preventive_types,
        technician_name || null,
        toMySQLDateTime(draft_date),
        toMySQLDateTime(approved_by_engineering_date),
        toMySQLDateTime(approved_by_manager_date),
        status,
      ]
    );

    await logAuditEvent(req, { eventType: 'SCHEDULE_PLAN_CREATED', entityType: 'preventive_schedule', entityId: result.insertId, metadata: { machineNo: machine_no, year: tahun, month: bulan, week: minggu } });

    res.status(201).json({ id: result.insertId, success: true });
  } catch (error) {
    console.error('Create schedule failed:', error);
    res.status(500).json({ message: 'Failed to create schedule' });
  }
});

app.patch('/api/schedules/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      machine_name,
      machine_asset,
      department,
      location,
      technician_name,
      execution_date,
      start_clock,
      end_clock,
      approved_by_manager_date,
      approved_by_engineering_date,
      approved_by_engineering_user,
      approved_by_manager_user,
      current_role,
      actor_user_id,
    } = req.body;

    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }

    const [existingRows] = await pool.query(
      'SELECT status FROM preventive_schedule WHERE id = ?',
      [Number(id)],
    );

    if (!existingRows.length) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    const previousStatus = existingRows[0].status;
    if (status === 'Approved by Engineering') {
      if (!['engineering supervisor', 'engineering officer'].includes(current_role)) {
        return res.status(403).json({ message: 'Engineering approval requires an engineering supervisor or officer' });
      }
      if (previousStatus !== 'Draft') {
        return res.status(409).json({ message: 'Only draft schedules can be approved by engineering' });
      }
    }

    if (status === 'Approved by Manager') {
      if (current_role !== 'manager') {
        return res.status(403).json({ message: 'Manager approval requires the manager role' });
      }
      if (previousStatus !== 'Approved by Engineering') {
        return res.status(409).json({ message: 'Engineering approval is required before manager approval' });
      }
    }

    const fields = [
      machine_name !== undefined ? 'machine_name = ?' : null,
      machine_asset !== undefined ? 'machine_asset = ?' : null,
      department !== undefined ? 'department = ?' : null,
      location !== undefined ? 'location = ?' : null,
      technician_name !== undefined ? 'technician_name = ?' : null,
      execution_date !== undefined ? 'execution_date = ?' : null,
      start_clock !== undefined ? 'start_clock = ?' : null,
      end_clock !== undefined ? 'end_clock = ?' : null,
      approved_by_manager_date !== undefined ? 'approved_by_manager_date = ?' : null,
      approved_by_engineering_date !== undefined ? 'approved_by_engineering_date = ?' : null,
      approved_by_engineering_user !== undefined ? 'approved_by_engineering_user = ?' : null,
      approved_by_manager_user !== undefined ? 'approved_by_manager_user = ?' : null,
      'status = ?',
    ].filter(Boolean);

    const values = [];
    if (machine_name !== undefined) values.push(machine_name);
    if (machine_asset !== undefined) values.push(machine_asset);
    if (department !== undefined) values.push(department);
    if (location !== undefined) values.push(location);
    if (technician_name !== undefined) values.push(technician_name);
    if (execution_date !== undefined) values.push(execution_date);
    if (start_clock !== undefined) values.push(start_clock);
    if (end_clock !== undefined) values.push(end_clock);
    if (approved_by_manager_date !== undefined) values.push(toMySQLDateTime(approved_by_manager_date));
    if (approved_by_engineering_date !== undefined) values.push(toMySQLDateTime(approved_by_engineering_date));
    if (approved_by_engineering_user !== undefined) values.push(approved_by_engineering_user);
    if (approved_by_manager_user !== undefined) values.push(approved_by_manager_user);
    values.push(status);
    values.push(Number(id));

    await pool.query(
      `UPDATE preventive_schedule SET ${fields.join(', ')} WHERE id = ?`,
      values,
    );

    if (status === 'Approved by Engineering' || status === 'Approved by Manager') {
      await logAuditEvent(req, {
        userId: Number(actor_user_id) || null,
        eventType: status === 'Approved by Engineering' ? 'SCHEDULE_APPROVED_ENGINEERING' : 'SCHEDULE_APPROVED_MANAGER',
        entityType: 'preventive_schedule',
        entityId: id,
        metadata: { previousStatus, status },
      });
    }

    res.json({ success: true, id: Number(id), status });
  } catch (error) {
    console.error('Update schedule status failed:', error);
    res.status(500).json({ message: 'Failed to update schedule status' });
  }
});

app.get('/api/approved-orders', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT *
      FROM maintenance_orders
      ORDER BY created_at DESC
    `);

    res.json(rows);
  } catch (error) {
    console.error('Fetch approved orders failed:', error);
    res.status(500).json({ message: 'Failed to fetch approved orders' });
  }
});

app.post('/api/approved-orders', async (req, res) => {
  try {
    const {
      machine_no,
      machine_asset,
      machine_name,
      location,
      department,
      sub,
      year,
      month,
      week,
      preventive_types,
      preventive_date,
      execution_date,
      start_clock,
      end_clock,
      technician_name,
      status,
      approved_by_manager_date,
      approved_by_manager_user,
    } = req.body;

    // maintenance_orders.status only accepts these values; fall back when the caller sends the schedule's status instead
    const validStatuses = ['In Progress', 'Approval', 'Completed'];
    const orderStatus = validStatuses.includes(status) ? status : 'In Progress';

    const [existingOrders] = await pool.query(
      `
        SELECT id
        FROM maintenance_orders
        WHERE machine_no = ?
          AND year = ?
          AND month = ?
          AND week = ?
          AND preventive_types = ?
        LIMIT 1
      `,
      [machine_no, year, month, week, preventive_types],
    );

    if (existingOrders.length) {
      return res.status(200).json({
        id: existingOrders[0].id,
        success: true,
        alreadyExists: true,
      });
    }

    const [result] = await pool.query(
      `
        INSERT INTO maintenance_orders
        (machine_no, machine_asset, machine_name, location, department, sub, year, month, week, preventive_types, preventive_date, execution_date, start_clock, end_clock, technician_name, status, approved_by_manager_date, approved_by_manager_user)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        machine_no,
        machine_asset,
        machine_name,
        location || null,
        department || null,
        sub,
        year,
        month,
        week,
        preventive_types,
        toMySQLDate(preventive_date),
        toMySQLDate(execution_date),
        start_clock || null,
        end_clock || null,
        technician_name || null,
        orderStatus,
        toMySQLDateTime(approved_by_manager_date),
        approved_by_manager_user || null,
      ],
    );

    await logAuditEvent(req, { eventType: 'MAINTENANCE_ORDER_CREATED', entityType: 'maintenance_orders', entityId: result.insertId, metadata: { machineNo: machine_no, status: orderStatus } });

    res.status(201).json({ id: result.insertId, success: true });
  } catch (error) {
    console.error('Create approved order failed:', error);
    res.status(500).json({
      message: 'Failed to create approved order',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.patch('/api/approved-orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      machine_asset,
      preventive_date,
      execution_date,
      start_clock,
      end_clock,
      technician_name,
      status,
      approved_by_technician_date,
      approved_by_technician_user,
      approved_by_pic_date,
      approved_by_pic_user,
      approved_by_engineering_date,
      approved_by_engineering_user,
    } = req.body;

    const validStatuses = ['In Progress', 'Approval', 'Completed'];
    if (status !== undefined && !validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status value' });
    }

    const fields = [];
    const values = [];
    if (machine_asset !== undefined) { fields.push('machine_asset = ?'); values.push(machine_asset); }
    if (preventive_date !== undefined) { fields.push('preventive_date = ?'); values.push(toMySQLDate(preventive_date)); }
    if (execution_date !== undefined) { fields.push('execution_date = ?'); values.push(toMySQLDate(execution_date)); }
    if (start_clock !== undefined) { fields.push('start_clock = ?'); values.push(start_clock); }
    if (end_clock !== undefined) { fields.push('end_clock = ?'); values.push(end_clock); }
    if (technician_name !== undefined) { fields.push('technician_name = ?'); values.push(technician_name); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }
    if (approved_by_technician_date !== undefined) { fields.push('approved_by_technician_date = ?'); values.push(toMySQLDateTime(approved_by_technician_date)); }
    if (approved_by_technician_user !== undefined) { fields.push('approved_by_technician_user = ?'); values.push(approved_by_technician_user); }
    if (approved_by_pic_date !== undefined) { fields.push('approved_by_pic_date = ?'); values.push(toMySQLDateTime(approved_by_pic_date)); }
    if (approved_by_pic_user !== undefined) { fields.push('approved_by_pic_user = ?'); values.push(approved_by_pic_user); }
    if (approved_by_engineering_date !== undefined) { fields.push('approved_by_engineering_date = ?'); values.push(toMySQLDateTime(approved_by_engineering_date)); }
    if (approved_by_engineering_user !== undefined) { fields.push('approved_by_engineering_user = ?'); values.push(approved_by_engineering_user); }

    if (!fields.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    values.push(Number(id));
    const [result] = await pool.query(
      `UPDATE maintenance_orders SET ${fields.join(', ')} WHERE id = ?`,
      values,
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Approved order not found' });
    }

    await logAuditEvent(req, { eventType: 'MAINTENANCE_ORDER_UPDATED', entityType: 'maintenance_orders', entityId: id, metadata: { fields: fields.map((field) => field.split(' ')[0]) } });

    res.json({ success: true, id: Number(id), status });
  } catch (error) {
    console.error('Update approved order failed:', error);
    res.status(500).json({
      message: 'Failed to update approved order',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/api/approved-orders/:id/results', async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!orderId || Number.isNaN(orderId)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const [orderRows] = await pool.query(
      'SELECT machine_no FROM maintenance_orders WHERE id = ?',
      [orderId],
    );
    if (!orderRows.length) {
      return res.status(404).json({ message: 'Order not found' });
    }
    const machineNo = orderRows[0].machine_no;

    // Lazily seed result rows from the machine's parameter template with definition snapshots
    await pool.query(
      `INSERT INTO order_checklist_results (order_id, parameter_id, part_master, part_checklist, action, standard)
       SELECT ?, mp.id, mp.part_master, mp.part_checklist, mp.action, mp.standard
       FROM machine_parameters mp
       WHERE mp.machine_no = ?
       ON DUPLICATE KEY UPDATE parameter_id = parameter_id`,
      [orderId, machineNo],
    );

    const [rows] = await pool.query(
      `SELECT r.id, r.order_id, r.parameter_id, r.result, r.justification,
              r.part_master, r.part_checklist, r.action, r.standard,
              mp.sort_order
       FROM order_checklist_results r
       JOIN machine_parameters mp ON mp.id = r.parameter_id
       WHERE r.order_id = ?
       ORDER BY mp.sort_order, r.id`,
      [orderId],
    );

    res.json(rows);
  } catch (error) {
    console.error('Fetch order results failed:', error);
    res.status(500).json({
      message: 'Failed to fetch order results',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.patch('/api/approved-orders/:id/results', async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const items = req.body.items;

    if (!orderId || Number.isNaN(orderId) || !Array.isArray(items)) {
      return res.status(400).json({ message: 'items array is required' });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const item of items) {
        if (!item || !item.parameter_id) continue;
        await connection.query(
          `UPDATE order_checklist_results
           SET result = ?, justification = ?
           WHERE order_id = ? AND parameter_id = ?`,
          [
            item.result || null,
            item.justification === undefined || item.justification === null || item.justification === ''
              ? 'NA'
              : item.justification,
            orderId,
            Number(item.parameter_id),
          ],
        );
      }
      await connection.commit();
      await logAuditEvent(req, { eventType: 'ORDER_CHECKLIST_SAVED', entityType: 'maintenance_orders', entityId: orderId, metadata: { itemsUpdated: items.length } });
      res.json({ success: true, orderId, updated: items.length });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Update order results failed:', error);
    res.status(500).json({
      message: 'Failed to update order results',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

app.delete('/api/schedules/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await pool.query('DELETE FROM preventive_schedule WHERE id = ?', [id]);
    if (result.affectedRows) {
      await logAuditEvent(req, { eventType: 'SCHEDULE_PLAN_DELETED', entityType: 'preventive_schedule', entityId: id });
    }
    res.json({ success: true, id: Number(id) });
  } catch (error) {
    console.error('Delete schedule failed:', error);
    res.status(500).json({ message: 'Failed to delete schedule' });
  }
});

app.post('/api/users/login', async (req, res) => {
  try {
    const { nickname, password } = req.body;

    if (!nickname || !password) {
      return res.status(400).json({
        message: 'Nickname and password are required.',
      });
    }

    const [rows] = await pool.query(
      `
        SELECT id, nickname, name, first_name, last_name, email, phone, role
        FROM users
        WHERE LOWER(TRIM(nickname)) = LOWER(TRIM(?))
          AND password = ?
          AND is_active = 1
      `,
      [String(nickname), String(password)]
    );

    if (!rows.length) {
      return res.status(401).json({
        message: 'Invalid username or password.',
      });
    }

    const user = rows[0];
    await logAuditEvent(req, {
      userId: user.id,
      eventType: 'LOGIN',
      entityType: 'users',
      entityId: user.id,
    });
    res.json({
      user: {
        id: user.id,
        nickname: user.nickname,
        name: user.name,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('User login failed:', error);
    res.status(500).json({
      message: 'Failed to login user.',
    });
  }
});

app.post('/api/users/logout', async (req, res) => {
  const userId = Number(req.body.user_id);
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ message: 'A valid user_id is required.' });
  }

  await logAuditEvent(req, {
    userId,
    eventType: 'LOGOUT',
    entityType: 'users',
    entityId: userId,
  });
  res.status(204).end();
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!userId || Number.isNaN(userId)) {
      return res.status(400).json({ message: 'Invalid user id.' });
    }

    const [rows] = await pool.query(
      `
        SELECT id, nickname, name, first_name, last_name, email, phone, role
        FROM users
        WHERE id = ? AND is_active = 1
      `,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const user = rows[0];

    res.json({
      user: {
        id: user.id,
        nickname: user.nickname,
        name: user.name,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Fetch current user failed:', error);
    res.status(500).json({ message: 'Failed to fetch current user.' });
  }
});

app.patch('/api/users/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!userId || Number.isNaN(userId)) {
      return res.status(400).json({ message: 'Invalid user id.' });
    }

    const { name, nickname, firstName, lastName, email, phone } = req.body;

    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (nickname !== undefined) { fields.push('nickname = ?'); values.push(nickname); }
    if (firstName !== undefined) { fields.push('first_name = ?'); values.push(firstName); }
    if (lastName !== undefined) { fields.push('last_name = ?'); values.push(lastName); }
    if (email !== undefined) { fields.push('email = ?'); values.push(email); }
    if (phone !== undefined) { fields.push('phone = ?'); values.push(phone); }

    if (!fields.length) {
      return res.status(400).json({ message: 'No fields to update.' });
    }

    values.push(userId);
    const [result] = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ? AND is_active = 1`,
      values,
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'User not found.' });
    }

    await logAuditEvent(req, { userId, eventType: 'USER_PROFILE_UPDATED', entityType: 'users', entityId: userId, metadata: { fields: fields.map((field) => field.split(' ')[0]) } });

    const [rows] = await pool.query(
      `
        SELECT id, nickname, name, first_name, last_name, email, phone, role
        FROM users
        WHERE id = ? AND is_active = 1
      `,
      [userId]
    );

    const user = rows[0];

    res.json({
      user: {
        id: user.id,
        nickname: user.nickname,
        name: user.name,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Update user failed:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'That nickname is already taken.' });
    }
    res.status(500).json({ message: 'Failed to update user.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
