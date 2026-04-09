-- ════════════════════════════════════════════════════════════════
-- 004_create_kaitalk_reports.sql
--
-- 用戶檢舉系統。
-- 法律合規 + 後台處理流程的基礎。
--
-- 隱私設計：
-- 平常 server 完全不存對話內容（音訊、字幕、翻譯）。
-- 但用戶按下「檢舉」這個動作 = 主動授權上傳該段對話 snapshot
-- 作為證據。這個 snapshot 是：
--   - 從用戶手機 in-memory subtitle buffer 打包過來的 JSON
--   - 包含對話最近 ~50 行字幕
--   - 由用戶主動 emit 給 server
--   - 不是 server 偷存的，是用戶交給 server 的
-- 法律上完全乾淨。
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kaitalk_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- ─── 誰檢舉誰 ───
  reporter_id TEXT NOT NULL,            -- → users.id（檢舉人）
  reported_id TEXT NOT NULL,            -- → users.id（被檢舉人）

  -- ─── 哪一通電話 ───
  call_id INTEGER,                      -- → kaitalk_calls.id

  -- ─── 檢舉內容 ───
  reason TEXT NOT NULL,                 -- 'harassment' | 'inappropriate' | 'spam' | 'underage' | 'other'
  notes TEXT,                           -- 用戶可選填補充

  -- ─── 證據 ───
  -- 用戶授權上傳的字幕 snapshot（in-memory buffer 的 JSON）
  -- 格式：[{ speaker, text, lang, ts }, ...]
  -- 大小限制 ~10KB（夠存 ~50 行字幕）
  evidence_snapshot TEXT,

  -- ─── 時間 ───
  reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- ─── 處理狀態 ───
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'reviewing' | 'resolved' | 'dismissed'
  reviewed_by TEXT,                        -- → users.id（管理員）
  reviewed_at TIMESTAMP,
  resolution TEXT                          -- 'warning' | 'temp_ban' | 'perm_ban' | 'no_action'
);

-- ─── Indexes ───
-- 後台撈待處理檢舉用
CREATE INDEX IF NOT EXISTS idx_reports_status ON kaitalk_reports(status, reported_at);

-- 查某用戶被檢舉幾次（自動 ban 觸發用）
CREATE INDEX IF NOT EXISTS idx_reports_reported ON kaitalk_reports(reported_id);

-- 查某用戶送出了多少檢舉（防濫檢舉）
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON kaitalk_reports(reporter_id);
