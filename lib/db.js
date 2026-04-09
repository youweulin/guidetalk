/**
 * lib/db.js — Turso (libSQL) client + 寫入 helpers
 *
 * 設計原則：
 * - **Lazy init**：只有第一次 query 才連 Turso
 * - **永遠不 throw**：任何 DB 錯誤都 log + 回 null/false，不阻塞 caller
 * - **記憶體 fallback**：如果 Turso 連不上，server 一切照舊，只是不存任何東西
 *
 * Phase 2B Commit 1：只有 upsertUser（連線時呼叫）
 * Phase 2B Commit 3：再加 startCall / endCall
 */

import { createClient } from '@libsql/client';

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;

let db = null;
let dbReady = false;
let dbFailed = false;

function ensureDb() {
  if (dbReady) return db;
  if (dbFailed) return null;
  if (!TURSO_URL || !TURSO_TOKEN) {
    dbFailed = true;
    console.warn('[db] TURSO_URL or TURSO_TOKEN not set — DB writes disabled');
    return null;
  }
  try {
    db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
    dbReady = true;
    console.log(`[db] connected: ${TURSO_URL}`);
    return db;
  } catch (err) {
    dbFailed = true;
    console.warn(`[db] init failed: ${err.message}`);
    return null;
  }
}

export function dbConfigured() {
  return !!(TURSO_URL && TURSO_TOKEN);
}

/**
 * Get the raw libsql client (lazy init).
 * Returns null if DB not configured or init failed.
 * Use this when you need to run custom queries (e.g. lib/geo.js cache).
 */
export function getDbClient() {
  return ensureDb();
}

/**
 * Upsert a user record. Called when a socket connects with a verified JWT.
 *
 * Behavior:
 * - If user.id 已存在 → 更新 last_seen_at + nickname
 * - If 不存在 → 建新 row, auth_status='anonymous'
 *
 * 永遠不 throw，失敗就 log + 回 false。
 */
export async function upsertUser({ id, nickname, isAnonymous }) {
  const conn = ensureDb();
  if (!conn) return false;
  if (!id) return false;

  try {
    await conn.execute({
      sql: `
        INSERT INTO users (id, nickname, auth_status, created_at, last_seen_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          nickname = COALESCE(excluded.nickname, users.nickname),
          last_seen_at = CURRENT_TIMESTAMP
      `,
      args: [id, nickname || 'Anonymous', isAnonymous ? 'anonymous' : 'verified'],
    });
    return true;
  } catch (err) {
    console.warn(`[db] upsertUser failed: ${err.message}`);
    return false;
  }
}

/**
 * Health check. Used by server startup or /health endpoint.
 * Returns { ok: bool, tables?: string[], error?: string }
 */
export async function healthCheck() {
  const conn = ensureDb();
  if (!conn) return { ok: false, error: 'db not configured' };
  try {
    const r = await conn.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    return { ok: true, tables: r.rows.map(row => row.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── kaitalk_calls helpers ──────────────────────────
//
// 寫入時機：
//   startCall  → 配對成功瞬間（match_found 之後）
//   endCall    → 任一方掛斷或 disconnect 時
//
// 永遠 silent fail：DB 掛了不影響配對流程

/**
 * 配對成功 → 開一筆 in-progress 的 call
 * Returns the inserted call_id (number) or null if failed/skipped
 *
 * 需要兩個 user 都有 verified user.id，否則跳過（不寫沒 user 的紀錄）
 */
export async function startCall({ roomCode, userA, userB, langA, langB }) {
  const conn = ensureDb();
  if (!conn) return null;
  if (!userA || !userB || !roomCode) return null;

  // 對 user.id 排序保證 (a, b) 跟 (b, a) 在 connections 表是同一筆
  // 但 kaitalk_calls 不需要排序，因為每通電話是獨立紀錄
  const crossLanguage = !!(langA && langB && langA.split('-')[0] !== langB.split('-')[0]);

  try {
    const r = await conn.execute({
      sql: `
        INSERT INTO kaitalk_calls (
          room_code, user_a, user_b, started_at, a_lang, b_lang, cross_language
        ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
      `,
      args: [roomCode, userA, userB, langA || null, langB || null, crossLanguage ? 1 : 0],
    });
    // libsql returns lastInsertRowid as BigInt
    const id = r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null;
    return id;
  } catch (err) {
    console.warn(`[db] startCall failed: ${err.message}`);
    return null;
  }
}

/**
 * 通話結束 → 更新該筆 call 的 ended_at / duration_sec / end_reason
 *
 * Also updates connections table:
 *   - kaitalk_call_count += 1
 *   - kaitalk_total_sec += duration
 *   - last_interaction_at = now
 */
export async function endCall({ callId, userA, userB, durationSec, endReason }) {
  const conn = ensureDb();
  if (!conn) return false;
  if (!callId) return false;

  // 1. 更新 kaitalk_calls
  try {
    await conn.execute({
      sql: `
        UPDATE kaitalk_calls
           SET ended_at = CURRENT_TIMESTAMP,
               duration_sec = ?,
               end_reason = ?
         WHERE id = ?
      `,
      args: [durationSec || 0, endReason || 'unknown', callId],
    });
  } catch (err) {
    console.warn(`[db] endCall update failed: ${err.message}`);
    return false;
  }

  // 2. upsert connections（兩人之間的關係）
  if (userA && userB) {
    // 排序：保證 connections 表 PK 一致
    const [a, b] = [userA, userB].sort();
    try {
      await conn.execute({
        sql: `
          INSERT INTO connections (
            user_a, user_b, first_met_at, first_met_via,
            last_interaction_at, kaitalk_call_count, kaitalk_total_sec
          ) VALUES (?, ?, CURRENT_TIMESTAMP, 'kaitalk', CURRENT_TIMESTAMP, 1, ?)
          ON CONFLICT(user_a, user_b) DO UPDATE SET
            kaitalk_call_count = kaitalk_call_count + 1,
            kaitalk_total_sec = kaitalk_total_sec + excluded.kaitalk_total_sec,
            last_interaction_at = CURRENT_TIMESTAMP
        `,
        args: [a, b, durationSec || 0],
      });
    } catch (err) {
      console.warn(`[db] connections upsert failed: ${err.message}`);
    }
  }

  return true;
}
