-- TaskBoard DB Schema v2 (user-based)

-- Users
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'member'
                            CHECK (role IN ('lead', 'member')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id            SERIAL PRIMARY KEY,
  title         TEXT        NOT NULL,
  description   TEXT,
  status        TEXT        NOT NULL DEFAULT 'todo'
                            CHECK (status IN ('todo', 'in-progress', 'done')),
  assigned_to   INT         REFERENCES users(id) ON DELETE SET NULL,
  created_by    INT         REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add new columns if upgrading from v1
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by  INT REFERENCES users(id) ON DELETE SET NULL;

-- v3: due date, priority
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date  TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority  TEXT NOT NULL DEFAULT 'medium'
  CHECK (priority IN ('low', 'medium', 'high'));

-- Comments
CREATE TABLE IF NOT EXISTS comments (
  id         SERIAL PRIMARY KEY,
  task_id    INT         NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
  id         SERIAL PRIMARY KEY,
  task_id    INT         NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INT         REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT        NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Teams
CREATE TABLE IF NOT EXISTS teams (
  id         SERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  created_by INT         REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Team members (role is per-team)
CREATE TABLE IF NOT EXISTS team_members (
  team_id    INT  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

-- Team invites
CREATE TABLE IF NOT EXISTS invites (
  id         SERIAL PRIMARY KEY,
  team_id    INT         NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email      TEXT        NOT NULL,
  token      TEXT        NOT NULL UNIQUE,
  invited_by INT         REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add team_id to tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_id INT REFERENCES teams(id) ON DELETE CASCADE;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
