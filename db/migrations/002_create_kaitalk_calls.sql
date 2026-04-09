-- ════════════════════════════════════════════════════════════════
-- 002_create_kaitalk_calls.sql
--
-- kaitalk 通話 metadata。
--
-- 重要原則：絕對不存對話內容。
-- - 不存音訊
-- - 不存字幕文字
-- - 不存翻譯結果
-- 只存「誰跟誰、聊多久、地理 metadata」這種匿名統計資料。
--
-- 隱私承諾：
-- - IP 只存 sha256 prefix（找不回原 IP，但能偵測同 IP 重複行為）
-- - country/city 是給數據分析跟未來「在地配對池」用
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS kaitalk_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- ─── 房號 ───
  -- server 產生的 6 碼，方便人工 trace
  room_code TEXT NOT NULL,

  -- ─── 兩位參與者 ───
  -- 通話開始時排序好（user_a < user_b lexicographically），方便查詢
  user_a TEXT NOT NULL,                 -- → users.id
  user_b TEXT NOT NULL,                 -- → users.id

  -- ─── 時間 ───
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP,
  duration_sec INTEGER,

  -- ─── 通話發生時的「實際所在位置」(IP geo 自動偵測) ───
  -- 跟 users.home_country 不一定相同（旅遊、移居、VPN）
  -- 用 ipinfo.io 或 MaxMind GeoLite2 偵測
  a_country TEXT,                       -- 'TW' | 'JP' | 'US' | ...
  a_city TEXT,                          -- 之後做行政區池會用
  a_ip_hash TEXT,                       -- sha256(ip)[:16]，不是原 IP
  b_country TEXT,
  b_city TEXT,
  b_ip_hash TEXT,

  -- ─── 通話用的語言 ───
  -- 給數據分析、翻譯品質追蹤用
  a_lang TEXT,                          -- 'zh-TW' | 'ja-JP' | ...
  b_lang TEXT,

  -- ─── 跨語言旗標 ───
  -- 是 kaitalk 的核心差異化指標。
  -- 用來分析：
  --   "跨語言通話的用戶有多少人按了想再遇？"
  --   "同語言 vs 跨語言，哪種更黏？"
  --   "台日跨語言通話佔總通話的幾 %？"
  cross_language BOOLEAN NOT NULL DEFAULT FALSE,

  -- ─── 「想再遇」標記 ───
  -- 兩人各自能按一次，都按了才會在 connections 表變 matched
  a_marked_meet_again BOOLEAN NOT NULL DEFAULT FALSE,
  b_marked_meet_again BOOLEAN NOT NULL DEFAULT FALSE,

  -- ─── 結束原因 ───
  end_reason TEXT                       -- 'a_hangup' | 'b_hangup' | 'disconnect' | 'timeout'
);

-- ─── Indexes ───
CREATE INDEX IF NOT EXISTS idx_kaitalk_calls_user_a ON kaitalk_calls(user_a);
CREATE INDEX IF NOT EXISTS idx_kaitalk_calls_user_b ON kaitalk_calls(user_b);
CREATE INDEX IF NOT EXISTS idx_kaitalk_calls_started ON kaitalk_calls(started_at);
CREATE INDEX IF NOT EXISTS idx_kaitalk_calls_countries ON kaitalk_calls(a_country, b_country);
CREATE INDEX IF NOT EXISTS idx_kaitalk_calls_cross_lang ON kaitalk_calls(cross_language);
