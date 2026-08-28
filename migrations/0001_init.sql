-- YouTube 채널 조회수 모니터링 스키마

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT UNIQUE NOT NULL,
  title TEXT,
  handle TEXT,
  thumbnail TEXT,
  uploads_playlist_id TEXT,
  input_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,           -- YYYY-MM-DD (Asia/Seoul 기준, 표시/그룹용)
  since_at TEXT NOT NULL,           -- 이 시각(UTC ISO) 이후 업로드만 집계
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',  -- running / completed / failed
  total_channels INTEGER NOT NULL DEFAULT 0,
  channels_checked INTEGER NOT NULL DEFAULT 0,
  channels_failed INTEGER NOT NULL DEFAULT 0,
  videos_found INTEGER NOT NULL DEFAULT 0,
  api_calls_used INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS run_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / done / failed
  error TEXT
);

CREATE TABLE IF NOT EXISTS run_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  channel_id TEXT,
  channel_title TEXT,
  channel_thumbnail TEXT,
  video_id TEXT NOT NULL,
  title TEXT,
  published_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  duration TEXT,
  thumbnail TEXT,
  video_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS run_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  channel_id TEXT,
  channel_title TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_run_videos_run_id ON run_videos(run_id);
CREATE INDEX IF NOT EXISTS idx_run_videos_view_count ON run_videos(view_count);
CREATE INDEX IF NOT EXISTS idx_runs_run_date ON runs(run_date);
CREATE INDEX IF NOT EXISTS idx_run_errors_run_id ON run_errors(run_id);
CREATE INDEX IF NOT EXISTS idx_run_queue_run_id_status ON run_queue(run_id, status);
CREATE INDEX IF NOT EXISTS idx_channels_active ON channels(active);
