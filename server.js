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

app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, data: rows[0] });
  } catch (error) {
    console.error('Database health check failed:', error);
    res.status(500).json({ ok: false, message: 'MariaDB connection failed' });
  }
});

app.get('/api/machines', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT no, kode_mesin, nama_mesin, lokasi, departemen, kategori
      FROM machines
      ORDER BY kategori, nama_mesin
    `);

    res.json(rows);
  } catch (error) {
    console.error('Fetch machines failed:', error);
    res.status(500).json({ message: 'Failed to fetch machines' });
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

    res.json({ success: true, id: Number(id) });
  } catch (error) {
    console.error('Update machine parameter failed:', error);
    res.status(500).json({ message: 'Failed to update machine parameter' });
  }
});

app.delete('/api/machine-parameters/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM machine_parameters WHERE id = ?', [Number(req.params.id)]);
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
      preventive_date,
      execution_date,
      start_clock,
      end_clock,
      technician_name,
      status,
    } = req.body;

    const validStatuses = ['In Progress', 'Approval', 'Completed'];
    if (status !== undefined && !validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status value' });
    }

    const fields = [];
    const values = [];
    if (preventive_date !== undefined) { fields.push('preventive_date = ?'); values.push(toMySQLDate(preventive_date)); }
    if (execution_date !== undefined) { fields.push('execution_date = ?'); values.push(toMySQLDate(execution_date)); }
    if (start_clock !== undefined) { fields.push('start_clock = ?'); values.push(start_clock); }
    if (end_clock !== undefined) { fields.push('end_clock = ?'); values.push(end_clock); }
    if (technician_name !== undefined) { fields.push('technician_name = ?'); values.push(technician_name); }
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }

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

    await pool.query('DELETE FROM preventive_schedule WHERE id = ?', [id]);
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
