const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const { logAuditEvent } = require('../lib/auditLog');
const { toMySQLDateTime, toMySQLDate } = require('../lib/dates');

router.get('/api/approved-orders', async (req, res) => {
  try {
    const year = Number(req.query.year) || null;
    const filters = [];
    const values = [];
    if (year) {
      filters.push('year = ?');
      values.push(year);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT *
       FROM maintenance_orders
       ${whereClause}
       ORDER BY created_at DESC`,
      values,
    );

    res.json(rows);
  } catch (error) {
    console.error('Fetch approved orders failed:', error);
    res.status(500).json({ message: 'Failed to fetch approved orders' });
  }
});

router.post('/api/approved-orders', async (req, res) => {
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

router.patch('/api/approved-orders/:id', async (req, res) => {
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

router.get('/api/approved-orders/:id/results', async (req, res) => {
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

router.patch('/api/approved-orders/:id/results', async (req, res) => {
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

module.exports = router;
