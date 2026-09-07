const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const { logAuditEvent } = require('../lib/auditLog');

router.post('/api/users/login', async (req, res) => {
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

router.post('/api/users/logout', async (req, res) => {
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

router.get('/api/users/:id', async (req, res) => {
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

router.patch('/api/users/:id', async (req, res) => {
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

module.exports = router;
