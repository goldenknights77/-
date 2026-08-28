-- 채널 대량 등록을 배치 처리하기 위한 잡 큐

CREATE TABLE IF NOT EXISTS channel_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'running', -- running / completed
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  duplicated INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_import_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES channel_imports(id) ON DELETE CASCADE,
  raw_input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / added / duplicated / failed
  result_channel_id TEXT,
  result_title TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_items_import_id_status ON channel_import_items(import_id, status);
