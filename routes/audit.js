const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const { logAuditEvent, describeAuditEvent, isLogViewerRole } = require('../lib/auditLog');

router.post('/api/audit-events', async (req, res) => {
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

router.get('/api/audit-logs', async (req, res) => {
  if (!isLogViewerRole(req.query.role)) {
    return res.status(403).json({ message: 'Only managers and engineering supervisors can view audit logs.' });
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
      `SELECT a.id, a.user_id, u.nickname, u.name AS user_name, u.role AS user_role, a.session_id,
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

router.get('/api/audit-logs/export', async (req, res) => {
  if (!isLogViewerRole(req.query.role)) {
    return res.status(403).json({ message: 'Only managers and engineering supervisors can export audit logs.' });
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
          `SELECT a.id, a.user_id, u.nickname, u.name AS user_name, u.role AS user_role, a.session_id,
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

    const [machineRows] = await pool.query('SELECT no, nama_mesin, kode_mesin FROM machines');
    const machinesByNo = new Map(machineRows.map((m) => [m.no, m]));

    const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const columns = ['Time', 'Action', 'Table', 'Account', 'Role', 'Description', 'IP Address', 'Status'];
    const lines = rows.map((row) => [
      row.created_at,
      row.event_type,
      row.entity_type,
      row.user_name || row.nickname || 'System',
      row.user_role,
      describeAuditEvent(row, machinesByNo),
      row.ip_address,
      'Success', // every persisted row represents a write that completed - see logAuditEvent
    ].map(escapeCsv).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pmo-audit-logs.csv"');
    res.send(`\uFEFF${columns.map(escapeCsv).join(',')}\n${lines.join('\n')}`);
  } catch (error) {
    console.error('Export audit logs failed:', error);
    res.status(500).json({ message: 'Failed to export audit logs.' });
  }
});

router.get('/api/notifications', async (req, res) => {
  try {
    const role = String(req.query.role || '').toLowerCase();
    const technician = String(req.query.technician || '').trim();
    const pending = [];

    if (role === 'engineering supervisor' || role === 'engineering officer' || role === 'manager') {
      const [[draftRow]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM preventive_schedule WHERE status = 'Draft'`,
      );
      if (draftRow.cnt > 0) {
        pending.push({
          id: 'pending-engineering-schedule',
          title: `${draftRow.cnt} schedule${draftRow.cnt === 1 ? '' : 's'} awaiting Engineering approval`,
          link: '/yearly-preventive-schedule',
          severity: 'warning',
        });
      }

      const [[orderEngRow]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM maintenance_orders
         WHERE approved_by_technician_date IS NOT NULL AND approved_by_pic_date IS NOT NULL
           AND approved_by_engineering_date IS NULL`,
      );
      if (orderEngRow.cnt > 0) {
        pending.push({
          id: 'pending-engineering-order',
          title: `${orderEngRow.cnt} order${orderEngRow.cnt === 1 ? '' : 's'} awaiting Engineering approval`,
          link: '/PreventiveMaintenanceOrder',
          severity: 'warning',
        });
      }
    }

    if (role === 'manager') {
      const [[managerScheduleRow]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM preventive_schedule WHERE status = 'Approved by Engineering'`,
      );
      if (managerScheduleRow.cnt > 0) {
        pending.push({
          id: 'pending-manager-schedule',
          title: `${managerScheduleRow.cnt} schedule${managerScheduleRow.cnt === 1 ? '' : 's'} awaiting Manager approval`,
          link: '/yearly-preventive-schedule',
          severity: 'error',
        });
      }

      const [[managerOrderRow]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM maintenance_orders
         WHERE approved_by_engineering_date IS NOT NULL AND approved_by_manager_date IS NULL`,
      );
      if (managerOrderRow.cnt > 0) {
        pending.push({
          id: 'pending-manager-order',
          title: `${managerOrderRow.cnt} order${managerOrderRow.cnt === 1 ? '' : 's'} awaiting Manager approval`,
          link: '/PreventiveMaintenanceOrder',
          severity: 'error',
        });
      }
    }

    if (role === 'technician' && technician) {
      const [[assignedRow]] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM maintenance_orders
         WHERE status = 'In Progress' AND technician_name LIKE ?`,
        [`%${technician}%`],
      );
      if (assignedRow.cnt > 0) {
        pending.push({
          id: 'pending-technician-orders',
          title: `${assignedRow.cnt} preventive task${assignedRow.cnt === 1 ? '' : 's'} assigned to you`,
          link: '/PreventiveMaintenanceOrder',
          severity: 'warning',
        });
      }
    }

    const [activityRows] = await pool.query(
      `SELECT a.id, a.event_type, a.entity_type, a.entity_id, a.metadata, a.page_path, a.action_label,
              u.name AS user_name, a.created_at
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.event_type IN (
         'SCHEDULE_PLAN_CREATED', 'SCHEDULE_APPROVED_ENGINEERING', 'SCHEDULE_APPROVED_MANAGER',
         'MAINTENANCE_ORDER_CREATED', 'ORDER_CHECKLIST_SAVED'
       )
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 15`,
    );

    const [machineRows] = await pool.query('SELECT no, nama_mesin, kode_mesin FROM machines');
    const machinesByNo = new Map(machineRows.map((m) => [m.no, m]));

    const activity = activityRows.map((row) => ({
      id: row.id,
      title: describeAuditEvent(row, machinesByNo),
      userName: row.user_name,
      createdAt: row.created_at,
      link:
        row.entity_type === 'maintenance_orders'
          ? '/PreventiveMaintenanceOrder'
          : row.entity_type === 'preventive_schedule'
            ? '/yearly-preventive-schedule'
            : null,
    }));

    res.json({ pending, activity });
  } catch (error) {
    console.error('Fetch notifications failed:', error);
    res.status(500).json({ message: 'Failed to fetch notifications' });
  }
});

module.exports = router;
