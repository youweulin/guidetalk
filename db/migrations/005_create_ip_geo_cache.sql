-- ════════════════════════════════════════════════════════════════
-- 005_create_ip_geo_cache.sql
--
-- IP → 國家/地區/城市 的快取表。
--
-- 為什麼要 cache：
--   ipinfo.io 免費版有 1000 req/天 (不註冊) / 50000 req/月 (註冊)。
--   1 個 IP 永遠對應同一個地理位置，所以查過一次就快取。
--   下次同 IP 來不再打 ipinfo.io，省 quota 10-30 倍。
--
-- 隱私：
--   只存 sha256(ip)[:16]，找不回原 IP。
--   但 hash 仍能 dedup（同 IP 永遠 hash 出同字串）。
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ip_geo_cache (
  ip_hash TEXT PRIMARY KEY,             -- sha256(ip)[:16]，不是原 IP
  country TEXT,                         -- 'TW' | 'JP' | 'US' ...
  region TEXT,                          -- ipinfo 的 region 欄位（'Taipei' 'Saitama' 等）
  city TEXT,                            -- ipinfo 的 city 欄位
  big_region TEXT,                      -- 我們對應的大區（'tw-north' 'jp-kanto' 等）
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_geo_cache_country ON ip_geo_cache(country);
CREATE INDEX IF NOT EXISTS idx_geo_cache_cached_at ON ip_geo_cache(cached_at);
