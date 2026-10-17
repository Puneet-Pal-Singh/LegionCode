ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE sessions ADD CONSTRAINT sessions_title_status_check CHECK (title_status IN ('pending', 'ready', 'failed'));
