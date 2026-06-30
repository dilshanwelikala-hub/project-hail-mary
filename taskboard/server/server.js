require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { pool } = require('./db');
const { router: authRouter, requireAuth, requireLead } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

app.use('/api/auth', authRouter);
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── Helpers ───────────────────────────────────────────────────
async function logActivity(task_id, user_id, action, detail) {
  await pool.query(
    'INSERT INTO activity_log (task_id, user_id, action, detail) VALUES ($1, $2, $3, $4)',
    [task_id, user_id, action, detail || null]
  );
}

// ── GET tasks ─────────────────────────────────────────────────
app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { status, assignee, priority } = req.query;
    const conditions = [];
    const params     = [];
    let   i          = 1;

    if (req.user.role !== 'lead') {
      conditions.push(`t.assigned_to = $${i++}`);
      params.push(req.user.id);
    } else if (assignee) {
      conditions.push(`t.assigned_to = $${i++}`);
      params.push(assignee);
    }

    if (status)   { conditions.push(`t.status = $${i++}`);   params.push(status); }
    if (priority) { conditions.push(`t.priority = $${i++}`); params.push(priority); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT t.*, u.name AS assignee_name
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      ${where}
      ORDER BY
        CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        t.created_at DESC
    `, params);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// ── GET single task ───────────────────────────────────────────
app.get('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, u.name AS assignee_name
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = $1
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = result.rows[0];
    if (req.user.role === 'member' && task.assigned_to !== req.user.id)
      return res.status(403).json({ error: 'Access denied' });

    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// ── POST create task (lead only) ──────────────────────────────
app.post('/api/tasks', requireAuth, requireLead, async (req, res) => {
  try {
    const { title, description, status = 'todo', assigned_to, due_date, priority = 'medium' } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    const result = await pool.query(
      `INSERT INTO tasks (title, description, status, assigned_to, created_by, due_date, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, description, status, assigned_to || null, req.user.id, due_date || null, priority]
    );

    const task = result.rows[0];
    await logActivity(task.id, req.user.id, 'created', `Task created with status "${status}"`);
    if (assigned_to) {
      const u = await pool.query('SELECT name FROM users WHERE id=$1', [assigned_to]);
      await logActivity(task.id, req.user.id, 'assigned', `Assigned to ${u.rows[0]?.name}`);
    }

    res.status(201).json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// ── PATCH update task ─────────────────────────────────────────
app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const current = await pool.query('SELECT * FROM tasks WHERE id=$1', [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = current.rows[0];

    if (req.user.role === 'member') {
      if (task.assigned_to !== req.user.id) return res.status(403).json({ error: 'Access denied' });
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: 'Members can only update status' });
      const result = await pool.query('UPDATE tasks SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
      await logActivity(task.id, req.user.id, 'status_changed', `${task.status} → ${status}`);
      return res.json(result.rows[0]);
    }

    // Lead update
    const { title, description, status, assigned_to, due_date, priority } = req.body;
    const fields = [], values = [];
    let i = 1;
    if (title       !== undefined) { fields.push(`title=$${i++}`);       values.push(title); }
    if (description !== undefined) { fields.push(`description=$${i++}`); values.push(description); }
    if (status      !== undefined) { fields.push(`status=$${i++}`);      values.push(status); }
    if (assigned_to !== undefined) { fields.push(`assigned_to=$${i++}`); values.push(assigned_to); }
    if (due_date    !== undefined) { fields.push(`due_date=$${i++}`);    values.push(due_date); }
    if (priority    !== undefined) { fields.push(`priority=$${i++}`);    values.push(priority); }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(',')} WHERE id=$${i} RETURNING *`, values
    );

    // Log meaningful changes
    if (status && status !== task.status)
      await logActivity(task.id, req.user.id, 'status_changed', `${task.status} → ${status}`);
    if (assigned_to !== undefined && assigned_to !== task.assigned_to) {
      const u = assigned_to ? await pool.query('SELECT name FROM users WHERE id=$1', [assigned_to]) : null;
      await logActivity(task.id, req.user.id, 'reassigned', assigned_to ? `Assigned to ${u.rows[0]?.name}` : 'Unassigned');
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// ── DELETE task (lead only) ───────────────────────────────────
app.delete('/api/tasks/:id', requireAuth, requireLead, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id=$1 RETURNING *', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json({ message: 'Task deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ── GET comments ──────────────────────────────────────────────
app.get('/api/tasks/:id/comments', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, u.name AS author_name
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.task_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// ── POST comment ──────────────────────────────────────────────
app.post('/api/tasks/:id/comments', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const result = await pool.query(
      'INSERT INTO comments (task_id, user_id, content) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, req.user.id, content]
    );
    await logActivity(req.params.id, req.user.id, 'commented', content.slice(0, 80));
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// ── GET activity log ──────────────────────────────────────────
app.get('/api/tasks/:id/activity', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*, u.name AS actor_name
      FROM activity_log a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.task_id = $1
      ORDER BY a.created_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ── GET member stats (lead only) ──────────────────────────────
app.get('/api/stats/members', requireAuth, requireLead, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.name,
        COUNT(t.id)                                          AS total,
        COUNT(t.id) FILTER (WHERE t.status = 'todo')        AS todo,
        COUNT(t.id) FILTER (WHERE t.status = 'in-progress') AS in_progress,
        COUNT(t.id) FILTER (WHERE t.status = 'done')        AS done
      FROM users u
      LEFT JOIN tasks t ON t.assigned_to = u.id
      WHERE u.role = 'member'
      GROUP BY u.id, u.name
      ORDER BY u.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch member stats' });
  }
});

app.listen(PORT, () => console.log(`TaskBoard API running on port ${PORT}`));
