const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const { logAuditEvent } = require('../lib/auditLog');
const { toMySQLDateTime } = require('../lib/dates');

router.get('/api/schedules', async (req, res) => {
  try {
    const year = Number(req.query.year) || null;
    const filters = [];
    const values = [];
    if (year) {
      filters.push('tahun = ?');
      values.push(year);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT *
       FROM preventive_schedule
       ${whereClause}
       ORDER BY tahun DESC, bulan ASC, minggu ASC`,
      values,
    );

    res.json(rows);
  } catch (error) {
    console.error('Fetch schedules failed:', error);
    res.status(500).json({ message: 'Failed to fetch schedules' });
  }
});

router.post('/api/schedules', async (req, res) => {
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

router.patch('/api/schedules/:id/status', async (req, res) => {
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

router.delete('/api/schedules/:id', async (req, res) => {
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

module.exports = router;
