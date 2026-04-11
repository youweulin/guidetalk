-- ════════════════════════════════════════════════════════════════
-- 009_create_analytics.sql
--
-- 簡易分析：DAU、在線人數、配對統計
-- 不額外裝分析服務，直接用 Turso 記
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kaitalk_daily_stats (
  date TEXT PRIMARY KEY,              -- YYYY-MM-DD
  unique_users INTEGER DEFAULT 0,     -- 當日不重複用戶數
  total_calls INTEGER DEFAULT 0,      -- 當日通話數
  total_call_seconds INTEGER DEFAULT 0, -- 當日通話總秒數
  peak_online INTEGER DEFAULT 0,      -- 當日最高同時在線
  new_users INTEGER DEFAULT 0,        -- 當日新用戶
  reports INTEGER DEFAULT 0           -- 當日檢舉數
);

CREATE TABLE IF NOT EXISTS kaitalk_hourly_online (
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  hour INTEGER NOT NULL,             -- 0-23
  online_count INTEGER DEFAULT 0,    -- 該小時平均在線人數
  call_count INTEGER DEFAULT 0,      -- 該小時通話數
  PRIMARY KEY (date, hour)
);
