CREATE TABLE project_public_pages (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_project_public_pages_public_id
ON project_public_pages(public_id);

CREATE INDEX idx_project_public_pages_enabled
ON project_public_pages(is_enabled, public_id);

CREATE TABLE public_page_sessions (
  project_id TEXT NOT NULL REFERENCES project_public_pages(project_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  public_replay_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, session_id),
  FOREIGN KEY (project_id, session_id)
    REFERENCES sessions(project_id, session_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_public_page_sessions_replay_id
ON public_page_sessions(public_replay_id);

CREATE UNIQUE INDEX idx_public_page_sessions_position
ON public_page_sessions(project_id, position);
