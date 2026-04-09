/**
 * lib/geo.js — IP → 地理位置（含 cache）
 *
 * 流程：
 *   1. 拿 client IP
 *   2. sha256 → cache key
 *   3. 查 ip_geo_cache（30 天 TTL）
 *      ├ hit → 直接回
 *      └ miss → 打 ipinfo.io → 寫 cache → 回
 *
 * 永遠 silent fail：geo 查不到不影響配對。
 */

import { createHash } from 'crypto';
import { regionToBigRegion } from './regions.js';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const IPINFO_TIMEOUT_MS = 3000;

// In-memory micro-cache，避免短時間內同 IP 連續打 ipinfo.io
const memCache = new Map();
const MEM_CACHE_MAX = 500;

function hashIp(ip) {
  return createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

/**
 * 從 ipinfo.io 拿 geo data
 * 失敗回 null，永遠不 throw
 */
async function fetchFromIpinfo(ip) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), IPINFO_TIMEOUT_MS);
    const r = await fetch(`https://ipinfo.io/${ip}/json`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const data = await r.json();
    return {
      country: data.country || null,
      region: data.region || null,
      city: data.city || null,
    };
  } catch {
    return null;
  }
}

/**
 * 查 Turso cache
 * @param {object} db - libsql client (lazy init by caller)
 * @returns {Promise<{country, region, city, big_region} | null>}
 */
async function readFromTurso(db, ipHash) {
  if (!db) return null;
  try {
    const r = await db.execute({
      sql: `SELECT country, region, city, big_region, cached_at
              FROM ip_geo_cache
             WHERE ip_hash = ?
             LIMIT 1`,
      args: [ipHash],
    });
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    // 過期判斷
    const cachedAt = new Date(row.cached_at + 'Z').getTime();
    if (Date.now() - cachedAt > CACHE_TTL_MS) return null;
    return {
      country: row.country,
      region: row.region,
      city: row.city,
      bigRegion: row.big_region,
    };
  } catch {
    return null;
  }
}

async function writeToTurso(db, ipHash, geo) {
  if (!db || !geo) return;
  try {
    await db.execute({
      sql: `
        INSERT INTO ip_geo_cache (ip_hash, country, region, city, big_region, cached_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(ip_hash) DO UPDATE SET
          country = excluded.country,
          region = excluded.region,
          city = excluded.city,
          big_region = excluded.big_region,
          cached_at = CURRENT_TIMESTAMP
      `,
      args: [ipHash, geo.country, geo.region, geo.city, geo.bigRegion],
    });
  } catch {
    // silent
  }
}

function rememberMem(ipHash, result) {
  if (memCache.size >= MEM_CACHE_MAX) {
    // 簡單 FIFO
    const firstKey = memCache.keys().next().value;
    memCache.delete(firstKey);
  }
  memCache.set(ipHash, { result, ts: Date.now() });
}

/**
 * 主入口：給 IP 拿 geo data
 *
 * @param {string} ip
 * @param {object} dbClient - 已經 init 好的 libsql client（caller 給）
 * @returns {Promise<{country, region, city, bigRegion, source} | null>}
 *   source: 'mem' | 'cache' | 'ipinfo' | null
 */
export async function lookupIp(ip, dbClient) {
  if (!ip) return null;

  // 處理 ::ffff:1.2.3.4 之類的 IPv6-mapped IPv4
  const cleanIp = String(ip).replace(/^::ffff:/, '');

  // 處理 localhost / private IP
  if (
    cleanIp === '127.0.0.1' ||
    cleanIp === '::1' ||
    cleanIp.startsWith('192.168.') ||
    cleanIp.startsWith('10.') ||
    cleanIp.startsWith('172.16.')
  ) {
    return null;
  }

  const ipHash = hashIp(cleanIp);

  // 1. mem cache
  const mem = memCache.get(ipHash);
  if (mem && Date.now() - mem.ts < CACHE_TTL_MS) {
    return { ...mem.result, source: 'mem' };
  }

  // 2. Turso cache
  const cached = await readFromTurso(dbClient, ipHash);
  if (cached) {
    rememberMem(ipHash, cached);
    return { ...cached, source: 'cache' };
  }

  // 3. ipinfo.io
  const fetched = await fetchFromIpinfo(cleanIp);
  if (!fetched) return null;

  const result = {
    country: fetched.country,
    region: fetched.region,
    city: fetched.city,
    bigRegion: regionToBigRegion(fetched.country, fetched.region, fetched.city),
  };

  // 寫 cache（fire-and-forget）
  writeToTurso(dbClient, ipHash, result).catch(() => {});
  rememberMem(ipHash, result);

  return { ...result, source: 'ipinfo' };
}

/**
 * 從 socket / express request 拿 client IP
 * 處理 X-Forwarded-For (cloudflared / proxy 後面)
 */
export function extractClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    return String(xff).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.connection?.remoteAddress || null;
}
