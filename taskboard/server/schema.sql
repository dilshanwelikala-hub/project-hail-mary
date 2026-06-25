-- TaskBoard DB Schema

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  title       TEXT        NOT NULL,
  description TEXT,
  status      TEXT        NOT NULL DEFAULT 'todo'
                          CHECK (status IN ('todo', 'in-progress', 'done')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed some sample tasks
INSERT INTO tasks (title, description, status) VALUES
  ('Set up the project',    'Create folder structure and schema', 'done'),
  ('Build the API',         'CRUD endpoints with Express',        'todo'),
  ('Build the frontend',    'HTML/CSS/JS task board UI',          'todo'),
  ('Deploy to Render',      'Push API and DB to Render',          'todo'),
  ('Deploy to Vercel',      'Push frontend to Vercel',            'todo')
ON CONFLICT DO NOTHING;
