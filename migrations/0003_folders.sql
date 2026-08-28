-- 채널 폴더(카테고리) 트리 구조 지원
-- 예: 스포츠 > 축구, 스포츠 > 야구 처럼 다단계 폴더로 채널을 분류하고
-- 대시보드에서 특정 폴더만 골라 "오늘의 체크"를 실행할 수 있게 함.

CREATE TABLE IF NOT EXISTS channel_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channel_folders_parent ON channel_folders(parent_id);

ALTER TABLE channels ADD COLUMN folder_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_channels_folder ON channels(folder_id);

ALTER TABLE runs ADD COLUMN scope_folder_ids TEXT;
ALTER TABLE runs ADD COLUMN scope_label TEXT;
