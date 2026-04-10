-- ════════════════════════════════════════════════════════════════
-- 007_add_karma_and_penalties.sql
--
-- Karma 信用評分 + 自動懲罰系統
--
-- karma 分數（預設 100）：
--   被檢舉 -10、被封鎖 -5、被快速掛斷(<15秒) -2
--   完成通話(>60秒) +1、被按想再遇 +3
--
-- 懲罰等級：
--   karma < 50 → 配對延遲 5 秒
--   karma < 20 → 只配低分用戶
--   karma < 0  → 自動封禁 7 天
-- ════════════════════════════════════════════════════════════════

-- users 表加 karma 欄位
ALTER TABLE users ADD COLUMN karma INTEGER NOT NULL DEFAULT 100;

-- 自動懲罰紀錄
CREATE TABLE IF NOT EXISTS kaitalk_penalties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,              -- → users.id
  action TEXT NOT NULL,               -- 'warning' | 'slow_match' | 'isolate' | 'temp_ban' | 'perm_ban'
  reason TEXT NOT NULL,               -- 'auto_report_threshold' | 'auto_karma_low' | 'manual'
  details TEXT,                       -- JSON 補充（觸發條件、當時 karma 等）
  duration_hours INTEGER,             -- 暫封時長（小時），永封 = NULL
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,               -- 何時解除，永封 = NULL
  revoked_at TIMESTAMP                -- 管理員撤銷時間
);

CREATE INDEX IF NOT EXISTS idx_penalties_user ON kaitalk_penalties(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_penalties_active ON kaitalk_penalties(action, expires_at);
