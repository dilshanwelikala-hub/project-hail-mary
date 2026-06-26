require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { pool } = require('./db');
const { router: authRouter, requireAuth, requireLead } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

// ── Auth routes ───────────────────────────────────────────────
app.use('/api/auth', authRouter);

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── GET tasks ─────────────────────────────────────────────────
// Lead → all tasks. Member → only their assigned tasks.
app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    let query, params = [];

    if (req.user.role === 'lead') {
      query = `
        SELECT t.*, u.name AS assignee_name
        FROM tasks t
        LEFT JOIN users u ON t.assigned_to = u.id
        ORDER BY t.created_at DESC
      `;
    } else {
      query = `
        SELECT t.*, u.name AS assignee_name
        FROM tasks t
        LEFT JOIN users u ON t.assigned_to = u.id
        WHERE t.assigned_to = $1
        ORDER BY t.created_at DESC
      `;
      params = [req.user.id];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// ── GET single task ───────────────────────────────────────────
app.get('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, u.name AS assignee_name
       FROM tasks t
       LEFT JOIN users u ON t.assigned_to = u.id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const task = result.rows[0];
    // Members can only see their own tasks
    if (req.user.role === 'member' && task.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// ── POST create task (lead only) ──────────────────────────────
app.post('/api/tasks', requireAuth, requireLead, async (req, res) => {
  try {
    const { title, description, status = 'todo', assigned_to } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const result = await pool.query(
      'INSERT INTO tasks (title, description, status, assigned_to, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, description, status, assigned_to || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// ── PATCH update task ─────────────────────────────────────────
// Lead → can update anything. Member → can only update status of own tasks.
app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const taskResult = await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id]);
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];

    // Members can only update their own tasks, and only the status
    if (req.user.role === 'member') {
      if (task.assigned_to !== req.user.id) return res.status(403).json({ error: 'Access denied' });
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: 'Members can only update status' });
      const result = await pool.query(
        'UPDATE tasks SET status = $1 WHERE id = $2 RETURNING *',
        [status, req.params.id]
      );
      return res.json(result.rows[0]);
    }

    // Lead can update anything
    const { title, description, status, assigned_to } = req.body;
    const fields = [], values = [];
    let i = 1;
    if (title       !== undefined) { fields.push(`title = $${i++}`);       values.push(title); }
    if (description !== undefined) { fields.push(`description = $${i++}`); values.push(description); }
    if (status      !== undefined) { fields.push(`status = $${i++}`);      values.push(status); }
    if (assigned_to !== undefined) { fields.push(`assigned_to = $${i++}`); values.push(assigned_to); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// ── DELETE task (lead only) ───────────────────────────────────
app.delete('/api/tasks/:id', requireAuth, requireLead, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => console.log(`TaskBoard API running on port ${PORT}`));
