require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const { pool } = require('./db');
const { router: authRouter, requireAuth, requireLead } = require('./auth');
const { sendAssignmentEmail, sendInviteEmail } = require('./email');

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
      const u = await pool.query('SELECT name, email FROM users WHERE id=$1', [assigned_to]);
      if (u.rows.length) {
        await logActivity(task.id, req.user.id, 'assigned', `Assigned to ${u.rows[0].name}`);
        await sendAssignmentEmail({
          toEmail: u.rows[0].email, toName: u.rows[0].name,
          taskTitle: title, taskDescription: description,
          assignedBy: req.user.name || 'Team Lead',
        });
      }
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
    if (assigned_to !== undefined && assigned_to !== task.assigned_to && assigned_to) {
      const u = await pool.query('SELECT name, email FROM users WHERE id=$1', [assigned_to]);
      if (u.rows.length) {
        await logActivity(task.id, req.user.id, 'reassigned', `Assigned to ${u.rows[0].name}`);
        await sendAssignmentEmail({
          toEmail: u.rows[0].email, toName: u.rows[0].name,
          taskTitle: title || task.title, taskDescription: description || task.description,
          assignedBy: req.user.name || 'Team Lead',
        });
      }
    } else if (assigned_to !== undefined && !assigned_to) {
      await logActivity(task.id, req.user.id, 'reassigned', 'Unassigned');
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

// ── TEAMS ─────────────────────────────────────────────────────

// Create team
app.post('/api/teams', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const team = await pool.query(
      'INSERT INTO teams (name, created_by) VALUES ($1,$2) RETURNING *',
      [name, req.user.id]
    );
    // Creator becomes lead of the team
    await pool.query(
      'INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3)',
      [team.rows[0].id, req.user.id, 'lead']
    );
    res.status(201).json(team.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create team' });
  }
});

// Get my teams
app.get('/api/teams', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, tm.role AS my_role,
        (SELECT COUNT(*) FROM team_members WHERE team_id=t.id) AS member_count
      FROM teams t
      JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=$1
      ORDER BY t.created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Get team members
app.get('/api/teams/:id/members', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, tm.role, tm.joined_at
      FROM team_members tm
      JOIN users u ON u.id=tm.user_id
      WHERE tm.team_id=$1
      ORDER BY u.name
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// Invite member by email
app.post('/api/teams/:id/invite', requireAuth, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    // Check requester is lead of this team
    const membership = await pool.query(
      'SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!membership.rows.length || membership.rows[0].role !== 'lead')
      return res.status(403).json({ error: 'Only team leads can invite members' });

    // Check not already a member
    const existing = await pool.query(
      'SELECT u.id FROM users u JOIN team_members tm ON tm.user_id=u.id WHERE u.email=$1 AND tm.team_id=$2',
      [email, req.params.id]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'User is already a team member' });

    const team  = await pool.query('SELECT name FROM teams WHERE id=$1', [req.params.id]);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      'INSERT INTO invites (team_id,email,token,invited_by,expires_at) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, email, token, req.user.id, expires]
    );

    const inviter = await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id]);
    await sendInviteEmail({
      toEmail: email, teamName: team.rows[0].name,
      invitedBy: inviter.rows[0].name, inviteToken: token,
    });

    res.json({ message: `Invite sent to ${email}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// Validate invite token
app.get('/api/invite/:token', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.*, t.name AS team_name
      FROM invites i JOIN teams t ON t.id=i.team_id
      WHERE i.token=$1 AND i.used=FALSE AND i.expires_at > NOW()
    `, [req.params.token]);
    if (!result.rows.length) return res.status(400).json({ error: 'Invalid or expired invite' });
    const inv = result.rows[0];
    res.json({ email: inv.email, teamName: inv.team_name, teamId: inv.team_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to validate invite' });
  }
});

// Accept invite (register + join team)
app.post('/api/invite/:token/accept', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'name and password are required' });

    const invResult = await pool.query(`
      SELECT * FROM invites WHERE token=$1 AND used=FALSE AND expires_at > NOW()
    `, [req.params.token]);
    if (!invResult.rows.length) return res.status(400).json({ error: 'Invalid or expired invite' });
    const invite = invResult.rows[0];

    // Register or find user
    let user;
    const existing = await pool.query('SELECT * FROM users WHERE email=$1', [invite.email]);
    if (existing.rows.length) {
      user = existing.rows[0];
    } else {
      const password_hash = await bcrypt.hash(password, 10);
      const created = await pool.query(
        'INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING *',
        [name, invite.email, password_hash, 'member']
      );
      user = created.rows[0];
    }

    // Add to team
    await pool.query(
      'INSERT INTO team_members (team_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [invite.team_id, user.id, 'member']
    );

    // Mark invite used
    await pool.query('UPDATE invites SET used=TRUE WHERE id=$1', [invite.id]);

    const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

app.listen(PORT, () => console.log(`TaskBoard API running on port ${PORT}`));
