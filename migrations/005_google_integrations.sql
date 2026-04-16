-- Google OAuth tokens
CREATE TABLE IF NOT EXISTS google_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Projects (Google Task Lists)
CREATE TABLE IF NOT EXISTS project_ref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL DEFAULT 'google_tasks',
  external_list_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_system, external_list_id)
);

-- Tasks (Google Tasks)
CREATE TABLE IF NOT EXISTS task_ref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL DEFAULT 'google_tasks',
  external_task_id TEXT NOT NULL,
  external_list_id TEXT NOT NULL,
  project_ref_id UUID REFERENCES project_ref(id),
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'needsAction',
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_system, external_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_ref_project ON task_ref (project_ref_id);
CREATE INDEX IF NOT EXISTS idx_task_ref_status ON task_ref (status);

-- People (Google Contacts)
CREATE TABLE IF NOT EXISTS person_ref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL DEFAULT 'google_contacts',
  external_person_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  primary_email TEXT,
  primary_phone TEXT,
  notes TEXT,
  tags TEXT[],
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_system, external_person_id)
);

CREATE INDEX IF NOT EXISTS idx_person_ref_name ON person_ref (user_id, full_name);

-- Calendar events
CREATE TABLE IF NOT EXISTS calendar_event_ref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL DEFAULT 'google_calendar',
  external_event_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  title TEXT NOT NULL,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  attendees JSONB,
  location TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_system, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_time ON calendar_event_ref (start_at, end_at);

-- Emails (Gmail — sent + starred)
CREATE TABLE IF NOT EXISTS email_ref (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL DEFAULT 'gmail',
  external_message_id TEXT NOT NULL,
  thread_id TEXT,
  subject TEXT,
  from_address TEXT NOT NULL,
  to_addresses TEXT[],
  snippet TEXT,
  body_text TEXT,
  label_ids TEXT[],
  is_starred BOOLEAN NOT NULL DEFAULT false,
  is_sent BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ,
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_system, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_email_ref_thread ON email_ref (thread_id);
CREATE INDEX IF NOT EXISTS idx_email_ref_sent_at ON email_ref (sent_at DESC);

-- Link edges (universal graph layer)
CREATE TABLE IF NOT EXISTS link_edge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  link_type TEXT NOT NULL,
  confidence REAL,
  explanation TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_edge_source ON link_edge (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_link_edge_target ON link_edge (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_link_edge_type ON link_edge (link_type);
