const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const { logAuditEvent } = require('../lib/auditLog');

router.get('/api/machines', async (req, res) => {
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

router.get('/api/technicians', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT technician_name, inisial, role, detail_technician_role, technician_main_sub, technician_child_sub
      FROM technicians
      ORDER BY technician_main_sub, technician_name
    `);

    res.json(rows);
  } catch (error) {
    console.error('Fetch technicians failed:', error);
    res.status(500).json({ message: 'Failed to fetch technicians' });
  }
});

router.get('/api/preventive-types', async (req, res) => {
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

router.get('/api/machine-parameters', async (req, res) => {
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

router.post('/api/machine-parameters', async (req, res) => {
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

router.post('/api/machine-parameters/bulk', async (req, res) => {
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

router.patch('/api/machine-parameters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { part_master, part_checklist, action, standard, sort_order } = req.body;

    const [[existing]] = await pool.query(
      'SELECT machine_no, part_master, part_checklist, action, standard FROM machine_parameters WHERE id = ?',
      [Number(id)],
    );
    if (!existing) {
      return res.status(404).json({ message: 'Machine parameter not found' });
    }

    const fields = [];
    const values = [];
    const changes = {};
    if (part_master !== undefined && part_master !== existing.part_master) {
      fields.push('part_master = ?'); values.push(part_master);
      changes.part_master = { from: existing.part_master, to: part_master };
    }
    if (part_checklist !== undefined && part_checklist !== existing.part_checklist) {
      fields.push('part_checklist = ?'); values.push(part_checklist);
      changes.part_checklist = { from: existing.part_checklist, to: part_checklist };
    }
    if (action !== undefined && action !== existing.action) {
      fields.push('action = ?'); values.push(action);
      changes.action = { from: existing.action, to: action };
    }
    if (standard !== undefined && standard !== existing.standard) {
      fields.push('standard = ?'); values.push(standard);
      changes.standard = { from: existing.standard, to: standard };
    }
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

    await logAuditEvent(req, {
      eventType: 'MACHINE_PARAMETER_UPDATED',
      entityType: 'machine_parameters',
      entityId: id,
      metadata: {
        machineNo: existing.machine_no,
        // Identifies WHICH checklist row this was, using its name as of
        // before the edit (so it still reads sensibly even when part_master
        // itself is one of the changed fields).
        partMaster: existing.part_master,
        partChecklist: existing.part_checklist,
        changes,
      },
    });

    res.json({ success: true, id: Number(id) });
  } catch (error) {
    console.error('Update machine parameter failed:', error);
    res.status(500).json({ message: 'Failed to update machine parameter' });
  }
});

router.delete('/api/machine-parameters/:id', async (req, res) => {
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

module.exports = router;
