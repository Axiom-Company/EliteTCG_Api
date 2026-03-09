-- Page Access table for controlling user access to specific pages
CREATE TABLE IF NOT EXISTS page_access (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  page_path TEXT NOT NULL,
  user_email TEXT NOT NULL,
  granted_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(page_path, user_email)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_page_access_path ON page_access(page_path);
CREATE INDEX IF NOT EXISTS idx_page_access_email ON page_access(page_path, user_email);
