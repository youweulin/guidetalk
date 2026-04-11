/**
 * kaitalk Phase 0 Signaling Server
 *
 * 唯一一台 server，做三件事：
 *   1. Socket.IO 訊令轉發（WebRTC offer/answer/ICE）
 *   2. 兩人隨機配對佇列
 *   3. 提供靜態前端
 *
 * 完全不碰 audio 資料 — 媒體永遠 P2P 直連，server 流量只有訊令幾 KB。
 *
 * 從 porkergame/server.js 抽出最小核心，砍掉：
 *   - Turso 分析（不需要）
 *   - GPS 附近房間（後期才用）
 *   - 卡牌遊戲訊息類型
 *   - 4 人房間邏輯（kaitalk 寫死 2 人）
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { verifySupabaseJwt, authConfigured } from './lib/auth.js';
import { upsertUser, dbConfigured, startCall, endCall, getDbClient } from './lib/db.js';
import { lookupIp, extractClientIp } from './lib/geo.js';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { readFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { onReport, onBlock, onCallEnd, isBanned } from './lib/karma.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 9001;
const MAX_PEERS = 2; // Phase 0 寫死兩人；未來改大就能多人

// 啟動時印 Auth/DB 是否設定（lazy connect，這裡只看環境變數）
console.log(`[init] Supabase Auth: ${authConfigured() ? 'configured' : 'NOT SET — falling back to anonymous'}`);
console.log(`[init] Turso DB:      ${dbConfigured() ? 'configured' : 'NOT SET — DB writes disabled'}`);

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 開發階段：禁止瀏覽器快取靜態檔，每次 refresh 都拿到最新版
// 正式上線改成 max-age 即可
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});
app.use(express.static(join(__dirname, 'public')));
// 解 trust proxy 讓 X-Forwarded-For 生效（cloudflared / nginx 後面用得到）
app.set('trust proxy', true);

// ─── Public client config ─────────────────────────────
// 讓 client 知道要連哪個 Supabase 專案 + anon key。
// 兩個都是 public 資訊（anon key 設計就是給瀏覽器用的）
// 不會洩漏 service_role key 或 JWT secret。
app.get('/config.json', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
});

// ─── Admin API ────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'kaitalk-admin-2026';

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/admin/api/overview', requireAdmin, async (req, res) => {
  try {
    const db = getDbClient();
    if (!db) return res.json({});
    const [users, calls, pending, bans, todayR, todayC] = await Promise.all([
      db.execute(`SELECT COUNT(*) as c FROM users`),
      db.execute(`SELECT COUNT(*) as c FROM kaitalk_calls`),
      db.execute(`SELECT COUNT(*) as c FROM kaitalk_reports WHERE status = 'pending'`),
      db.execute(`SELECT COUNT(*) as c FROM users WHERE banned_until > CURRENT_TIMESTAMP`),
      db.execute(`SELECT COUNT(*) as c FROM kaitalk_reports WHERE reported_at > datetime('now','-1 day')`),
      db.execute(`SELECT COUNT(*) as c FROM kaitalk_calls WHERE started_at > datetime('now','-1 day')`),
    ]);
    res.json({
      totalUsers: users.rows[0]?.c || 0,
      totalCalls: calls.rows[0]?.c || 0,
      pendingReports: pending.rows[0]?.c || 0,
      activeBans: bans.rows[0]?.c || 0,
      todayReports: todayR.rows[0]?.c || 0,
      todayCalls: todayC.rows[0]?.c || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/reports', requireAdmin, async (req, res) => {
  try {
    const db = getDbClient();
    const status = req.query.status;
    const limit = parseInt(req.query.limit) || 50;
    const where = status ? `WHERE r.status = ?` : '';
    const args = status ? [status, limit] : [limit];
    const result = await db.execute({
      sql: `SELECT r.*,
              u1.nickname as reporter_name, u2.nickname as reported_name
            FROM kaitalk_reports r
            LEFT JOIN users u1 ON u1.id = r.reporter_id
            LEFT JOIN users u2 ON u2.id = r.reported_id
            ${where}
            ORDER BY r.reported_at DESC LIMIT ?`,
      args,
    });
    res.json({ reports: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/reports/resolve', requireAdmin, express.json(), async (req, res) => {
  try {
    const { reportId, resolution } = req.body;
    const db = getDbClient();
    await db.execute({
      sql: `UPDATE kaitalk_reports SET status = 'resolved', resolution = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [resolution, reportId],
    });
    // 如果是 temp_ban，封禁被檢舉人 7 天
    if (resolution === 'temp_ban') {
      const report = await db.execute({ sql: `SELECT reported_id FROM kaitalk_reports WHERE id = ?`, args: [reportId] });
      if (report.rows[0]) {
        const uid = report.rows[0].reported_id;
        const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
        await db.execute({ sql: `UPDATE users SET banned_until = ? WHERE id = ?`, args: [expires, uid] });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/penalties', requireAdmin, async (req, res) => {
  try {
    const db = getDbClient();
    const result = await db.execute({
      sql: `SELECT p.*, u.nickname as user_name FROM kaitalk_penalties p
            LEFT JOIN users u ON u.id = p.user_id
            ORDER BY p.created_at DESC LIMIT 50`,
      args: [],
    });
    res.json({ penalties: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/api/user', requireAdmin, async (req, res) => {
  try {
    const q = req.query.q;
    const db = getDbClient();
    let user = (await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [q] })).rows[0];
    if (!user) {
      user = (await db.execute({ sql: `SELECT * FROM users WHERE nickname = ? LIMIT 1`, args: [q] })).rows[0];
    }
    if (!user) return res.json({ user: null });
    const reportCount = (await db.execute({ sql: `SELECT COUNT(*) as c FROM kaitalk_reports WHERE reported_id = ?`, args: [user.id] })).rows[0]?.c || 0;
    const blockCount = (await db.execute({ sql: `SELECT COUNT(*) as c FROM connections WHERE (user_a = ? OR user_b = ?) AND (a_blocked_b = 1 OR b_blocked_a = 1)`, args: [user.id, user.id] })).rows[0]?.c || 0;
    res.json({ user, reportCount, blockCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/user/ban', requireAdmin, express.json(), async (req, res) => {
  try {
    const { userId, hours } = req.body;
    const db = getDbClient();
    const expires = new Date(Date.now() + (hours || 168) * 3600 * 1000).toISOString();
    await db.execute({ sql: `UPDATE users SET banned_until = ? WHERE id = ?`, args: [expires, userId] });
    await db.execute({
      sql: `INSERT INTO kaitalk_penalties (user_id, action, reason, duration_hours, expires_at) VALUES (?, 'temp_ban', 'manual', ?, ?)`,
      args: [userId, hours || 168, expires],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/user/unban', requireAdmin, express.json(), async (req, res) => {
  try {
    const { userId } = req.body;
    const db = getDbClient();
    await db.execute({ sql: `UPDATE users SET banned_until = NULL WHERE id = ?`, args: [userId] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/user/karma', requireAdmin, express.json(), async (req, res) => {
  try {
    const { userId, delta } = req.body;
    const db = getDbClient();
    await db.execute({ sql: `UPDATE users SET karma = MAX(-100, MIN(200, karma + ?)) WHERE id = ?`, args: [delta, userId] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Trends 熱門話題（每小時快取）───────────────
let trendsCache = { tw: [], jp: [], updatedAt: 0 };
const TRENDS_TTL = 60 * 60 * 1000; // 1 小時

async function fetchTrendsRSS(geo) {
  try {
    const domain = geo === 'JP' ? 'google.co.jp' : 'google.com.tw';
    const url = `https://trends.${domain}/trending/rss?geo=${geo}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const xml = await resp.text();

    // 簡單解析 XML — 抓 <item><title> 和 <ht:approx_traffic>
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
      const block = match[1];
      const title = block.match(/<title>(.*?)<\/title>/)?.[1];
      const traffic = block.match(/<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/)?.[1];
      const picture = block.match(/<ht:picture>(.*?)<\/ht:picture>/)?.[1];
      if (title) {
        items.push({ title, traffic: traffic || '', picture: picture || '', geo });
      }
    }
    return items;
  } catch (err) {
    console.warn(`[📈] Trends fetch failed (${geo}): ${err.message}`);
    return [];
  }
}

async function refreshTrends() {
  const [tw, jp] = await Promise.all([fetchTrendsRSS('TW'), fetchTrendsRSS('JP')]);
  trendsCache = { tw, jp, updatedAt: Date.now() };
  console.log(`[📈] Trends refreshed: TW=${tw.length}, JP=${jp.length}`);
}

// 啟動時抓一次，之後每小時
refreshTrends();
setInterval(refreshTrends, TRENDS_TTL);

app.get('/api/trends', (req, res) => {
  res.json({
    tw: trendsCache.tw,
    jp: trendsCache.jp,
    updatedAt: trendsCache.updatedAt,
  });
});

// ─── IP Geo lookup ────────────────────────────────────
// 給 client 拿自己的位置（國家、地區、大區）。
// 走 cache 優先，cache miss 才打 ipinfo.io。
// 完全 graceful：失敗回 { country: null }
app.get('/api/geo/me', async (req, res) => {
  try {
    const ip = extractClientIp(req);
    const geo = await lookupIp(ip, getDbClient());
    res.json({
      ip: null, // 永遠不回原 IP
      country: geo?.country || null,
      region: geo?.region || null,
      city: geo?.city || null,
      bigRegion: geo?.bigRegion || null,
      source: geo?.source || null, // 'mem' | 'cache' | 'ipinfo' | null
    });
  } catch (err) {
    console.warn(`[geo] /api/geo/me failed: ${err.message}`);
    res.json({ country: null, region: null, city: null, bigRegion: null, source: null });
  }
});

// ─── 封鎖名單（in-memory cache）──────────────────────
// blockedPairs: Set of "userA|userB" (sorted) → O(1) lookup
const blockedPairs = new Set();

async function loadBlockedPairs() {
  try {
    const db = getDbClient();
    if (!db) return;
    const result = await db.execute(`
      SELECT user_a, user_b FROM connections
       WHERE a_blocked_b = 1 OR b_blocked_a = 1
    `);
    for (const row of result.rows) {
      blockedPairs.add(`${row.user_a}|${row.user_b}`);
    }
    console.log(`[🛡️] Loaded ${blockedPairs.size} blocked pairs`);
  } catch (err) {
    console.warn(`[🛡️] Failed to load blocked pairs: ${err.message}`);
  }
}

function isBlocked(uidA, uidB) {
  if (!uidA || !uidB) return false;
  const [a, b] = [uidA, uidB].sort();
  return blockedPairs.has(`${a}|${b}`);
}

function addBlock(uidA, uidB) {
  const [a, b] = [uidA, uidB].sort();
  blockedPairs.add(`${a}|${b}`);
}

// 啟動時載入封鎖名單
loadBlockedPairs();

// ─── 檢舉 + 封鎖 API ──────────────────────────────────
// 需要 Supabase JWT auth — 從 Authorization header 驗證

async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const result = await verifySupabaseJwt(token);
  return result?.userId || null;
}

// POST /api/report — 檢舉用戶
app.post('/api/report', express.json(), async (req, res) => {
  const userId = await authenticateRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { reportedId, callId, reason, notes, evidenceSnapshot } = req.body;
  if (!reportedId || !reason) {
    return res.status(400).json({ error: 'missing reportedId or reason' });
  }

  const validReasons = ['harassment', 'inappropriate', 'spam', 'underage', 'other'];
  if (!validReasons.includes(reason)) {
    return res.status(400).json({ error: 'invalid reason' });
  }

  try {
    const db = getDbClient();
    if (!db) return res.status(503).json({ error: 'db unavailable' });

    // 限制 evidence 大小（~10KB）
    const evidence = typeof evidenceSnapshot === 'string'
      ? evidenceSnapshot.slice(0, 10000)
      : JSON.stringify(evidenceSnapshot || []).slice(0, 10000);

    await db.execute({
      sql: `INSERT INTO kaitalk_reports (reporter_id, reported_id, call_id, reason, notes, evidence_snapshot)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [userId, reportedId, callId || null, reason, (notes || '').slice(0, 500), evidence],
    });

    // 自動封鎖對方（檢舉 = 同時封鎖）
    const [a, b] = [userId, reportedId].sort();
    const isA = userId === a;
    const blockCol = isA ? 'a_blocked_b' : 'b_blocked_a';
    const blockAtCol = isA ? 'a_blocked_at' : 'b_blocked_at';

    await db.execute({
      sql: `INSERT INTO connections (user_a, user_b, first_met_via, ${blockCol}, ${blockAtCol})
            VALUES (?, ?, 'kaitalk', 1, CURRENT_TIMESTAMP)
            ON CONFLICT(user_a, user_b) DO UPDATE SET
              ${blockCol} = 1, ${blockAtCol} = CURRENT_TIMESTAMP`,
      args: [a, b],
    });
    addBlock(userId, reportedId);

    console.log(`[🚨] Report: ${userId.slice(0, 8)} reported ${reportedId.slice(0, 8)} for ${reason}`);
    // Karma: 被檢舉 -10 + 自動懲罰檢查
    onReport(db, reportedId);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[🚨] Report failed: ${err.message}`);
    res.status(500).json({ error: 'internal' });
  }
});

// POST /api/block — 單純封鎖（不檢舉）
app.post('/api/block', express.json(), async (req, res) => {
  const userId = await authenticateRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { blockedId } = req.body;
  if (!blockedId) return res.status(400).json({ error: 'missing blockedId' });

  try {
    const db = getDbClient();
    if (!db) return res.status(503).json({ error: 'db unavailable' });

    const [a, b] = [userId, blockedId].sort();
    const isA = userId === a;
    const blockCol = isA ? 'a_blocked_b' : 'b_blocked_a';
    const blockAtCol = isA ? 'a_blocked_at' : 'b_blocked_at';

    await db.execute({
      sql: `INSERT INTO connections (user_a, user_b, first_met_via, ${blockCol}, ${blockAtCol})
            VALUES (?, ?, 'kaitalk', 1, CURRENT_TIMESTAMP)
            ON CONFLICT(user_a, user_b) DO UPDATE SET
              ${blockCol} = 1, ${blockAtCol} = CURRENT_TIMESTAMP`,
      args: [a, b],
    });
    addBlock(userId, blockedId);

    console.log(`[🛡️] Block: ${userId.slice(0, 8)} blocked ${blockedId.slice(0, 8)}`);
    // Karma: 被封鎖 -5
    onBlock(db, blockedId);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[🛡️] Block failed: ${err.message}`);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/friends — 我的好友列表（互相想再遇的人）
app.get('/api/friends', async (req, res) => {
  const userId = await authenticateRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const db = getDbClient();
    if (!db) return res.status(503).json({ error: 'db unavailable' });

    const result = await db.execute({
      sql: `
        SELECT c.user_a, c.user_b, c.reunion_code, c.matched_at, c.last_interaction_at,
               c.kaitalk_call_count,
               ua.nickname AS name_a, ub.nickname AS name_b
          FROM connections c
          LEFT JOIN users ua ON ua.id = c.user_a
          LEFT JOIN users ub ON ub.id = c.user_b
         WHERE c.matched = 1
           AND c.a_blocked_b = 0 AND c.b_blocked_a = 0
           AND (c.user_a = ? OR c.user_b = ?)
         ORDER BY c.last_interaction_at DESC
         LIMIT 50
      `,
      args: [userId, userId],
    });

    const friends = result.rows.map(row => {
      const isA = row.user_a === userId;
      return {
        friendId: isA ? row.user_b : row.user_a,
        friendName: isA ? (row.name_b || '未知') : (row.name_a || '未知'),
        reunionCode: row.reunion_code || null,
        matchedAt: row.matched_at,
        lastInteraction: row.last_interaction_at,
        callCount: row.kaitalk_call_count || 0,
      };
    });

    res.json({ friends });
  } catch (err) {
    console.error(`[👥] Friends list failed: ${err.message}`);
    res.status(500).json({ error: 'internal' });
  }
});

// ─── Edge TTS API ─────────────────────────────────────
//
// POST /api/tts — 文字轉語音（Edge TTS，好聽的聲音）
// 回傳 mp3 audio buffer

// 語音對照表（男女各語言最自然的聲音）
const EDGE_VOICES = {
  // 東亞
  'zh-TW': { female: 'zh-TW-HsiaoChenNeural',  male: 'zh-TW-YunJheNeural' },
  'zh-CN': { female: 'zh-CN-XiaoxiaoNeural',   male: 'zh-CN-YunxiNeural' },
  'ja-JP': { female: 'ja-JP-NanamiNeural',      male: 'ja-JP-KeitaNeural' },
  'ko-KR': { female: 'ko-KR-SunHiNeural',      male: 'ko-KR-InJoonNeural' },
  // 英語
  'en-US': { female: 'en-US-JennyNeural',       male: 'en-US-GuyNeural' },
  // 東南亞
  'vi-VN': { female: 'vi-VN-HoaiMyNeural',      male: 'vi-VN-NamMinhNeural' },
  'id-ID': { female: 'id-ID-GadisNeural',       male: 'id-ID-ArdiNeural' },
  'th-TH': { female: 'th-TH-PremwadeeNeural',   male: 'th-TH-NiwatNeural' },
  'tl-PH': { female: 'fil-PH-BlessicaNeural',   male: 'fil-PH-AngeloNeural' },
  // 南亞
  'hi-IN': { female: 'hi-IN-SwaraNeural',       male: 'hi-IN-MadhurNeural' },
  'ur-PK': { female: 'ur-PK-UzmaNeural',        male: 'ur-PK-AsadNeural' },
  // 歐洲
  'fr-FR': { female: 'fr-FR-DeniseNeural',      male: 'fr-FR-HenriNeural' },
  'es-ES': { female: 'es-ES-ElviraNeural',      male: 'es-ES-AlvaroNeural' },
  'pt-BR': { female: 'pt-BR-FranciscaNeural',   male: 'pt-BR-AntonioNeural' },
  'ru-RU': { female: 'ru-RU-SvetlanaNeural',    male: 'ru-RU-DmitryNeural' },
  'uk-UA': { female: 'uk-UA-PolinaNeural',      male: 'uk-UA-OstapNeural' },
};

// TTS 暫存目錄
const TTS_TMP_DIR = '/tmp/kaitalk-tts';
if (!existsSync(TTS_TMP_DIR)) mkdirSync(TTS_TMP_DIR, { recursive: true });

app.post('/api/tts', express.json(), async (req, res) => {
  const { text, lang, gender } = req.body;
  if (!text || !lang) return res.status(400).json({ error: 'missing text or lang' });

  try {
    const voiceMap = EDGE_VOICES[lang] || EDGE_VOICES['en-US'];
    const voiceName = gender === 'male' ? voiceMap.male : voiceMap.female;

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const result = await tts.toFile(TTS_TMP_DIR, text.slice(0, 500));
    const audioPath = result.audioFilePath;

    const buffer = readFileSync(audioPath);
    // 清掉暫存檔
    try { unlinkSync(audioPath); } catch {}

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(buffer);
  } catch (err) {
    console.error(`[🔊] Edge TTS error: ${err.message}`);
    res.status(500).json({ error: 'tts failed' });
  }
});

// ─── 信件 API ────────────────────────────────────────

// POST /api/letters/send — 寄信給好友
app.post('/api/letters/send', express.json(), async (req, res) => {
  const userId = await authenticateRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { toUid, body } = req.body;
  if (!toUid || !body?.trim()) return res.status(400).json({ error: 'missing toUid or body' });

  try {
    const db = getDbClient();
    if (!db) return res.status(503).json({ error: 'db unavailable' });

    // 確認是好友（matched=true）
    const [a, b] = [userId, toUid].sort();
    const conn = await db.execute({
      sql: `SELECT matched FROM connections WHERE user_a = ? AND user_b = ? AND matched = 1`,
      args: [a, b],
    });
    if (conn.rows.length === 0) return res.status(403).json({ error: 'not_friends' });

    // 檢查今日寄信數量（每天 3 封限制）
    const todayCount = await db.execute({
      sql: `SELECT COUNT(*) as c FROM kaitalk_letters WHERE from_uid = ? AND created_at > datetime('now','-1 day')`,
      args: [userId],
    });
    if ((todayCount.rows[0]?.c || 0) >= 3) {
      return res.status(429).json({ error: 'daily_limit', message: '今日寄信已達上限（3 封）' });
    }

    await db.execute({
      sql: `INSERT INTO kaitalk_letters (from_uid, to_uid, body, lang) VALUES (?, ?, ?, ?)`,
      args: [userId, toUid, body.trim().slice(0, 500), req.body.lang || null],
    });

    console.log(`[✉️] Letter: ${userId.slice(0, 8)} → ${toUid.slice(0, 8)}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[✉️] Letter send failed: ${err.message}`);
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/letters/inbox — 我的收件匣
app.get('/api/letters/inbox', async (req, res) => {
  const userId = await authenticateRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const db = getDbClient();
    if (!db) return res.status(503).json({ error: 'db unavailable' });

    const result = await db.execute({
      sql: `SELECT l.*, u.nickname as from_name
            FROM kaitalk_letters l
            LEFT JOIN users u ON u.id = l.from_uid
            WHERE l.to_uid = ?
            ORDER BY l.created_at DESC LIMIT 50`,
      args: [userId],
    });

    // 計算未讀數
    const unread = result.rows.filter(r => !r.read_at).length;
    res.json({ letters: result.rows, unread });
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

// GET /api/letters/thread/:friendId — 跟某好友的往來信件
app.get('/api/letters/thread/:friendId', async (req, res) => {
  const userId = await authenticateRequest(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  try {
    const db = getDbClient();
    const fid = req.params.friendId;
    const result = await db.execute({
      sql: `SELECT * FROM kaitalk_letters
            WHERE (from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?)
            ORDER BY created_at ASC LIMIT 100`,
      args: [userId, fid, fid, userId],
    });

    // 標記已讀
    await db.execute({
      sql: `UPDATE kaitalk_letters SET read_at = CURRENT_TIMESTAMP WHERE to_uid = ? AND from_uid = ? AND read_at IS NULL`,
      args: [userId, fid],
    });

    res.json({ messages: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'internal' });
  }
});

// ─── 配對佇列（in-memory）─────────────────────────────
// queue[gameType] = [{ socket, name }]
const queues = new Map();
const getQueue = (game) => {
  if (!queues.has(game)) queues.set(game, []);
  return queues.get(game);
};

const removeFromAllQueues = (socketId) => {
  for (const [, q] of queues) {
    const i = q.findIndex(p => p.socket.id === socketId);
    if (i !== -1) q.splice(i, 1);
  }
};

// ─── 進行中的通話（in-memory）────────────────────────
// roomCode → { callId, userA, userB, startedAt, sockets: Set }
// 用來記住「這個 room 的 DB call 紀錄」，以便掛斷時 endCall()
const activeCalls = new Map();

function startActiveCall(roomCode, players) {
  const now = Date.now();
  const userA = players[0].socket.data.userId || null;
  const userB = players[1].socket.data.userId || null;
  const langA = players[0].lang || null;
  const langB = players[1].lang || null;

  // 寫 DB（fire and forget）
  startCall({ roomCode, userA, userB, langA, langB })
    .then(callId => {
      const entry = activeCalls.get(roomCode);
      if (entry && callId) {
        entry.callId = callId;
      }
    })
    .catch(() => {});

  activeCalls.set(roomCode, {
    callId: null, // 會在 startCall promise resolve 時填
    userA,
    userB,
    nameA: players[0].name,
    nameB: players[1].name,
    startedAt: now,
    sockets: new Set([players[0].socket.id, players[1].socket.id]),
    // 想再遇標記（socketId → true）
    meetAgainMarks: new Set(),
  });
}

function endActiveCall(roomCode, endReason) {
  const entry = activeCalls.get(roomCode);
  if (!entry) return;
  activeCalls.delete(roomCode);

  if (!entry.callId) {
    // startCall 還沒回來就結束了——通話可能 < 100ms，不寫 DB
    return;
  }

  const durationSec = Math.round((Date.now() - entry.startedAt) / 1000);
  endCall({
    callId: entry.callId,
    userA: entry.userA,
    userB: entry.userB,
    durationSec,
    endReason,
  }).catch(() => {});

  // Karma: 通話結束事件
  onCallEnd(getDbClient(), {
    userA: entry.userA,
    userB: entry.userB,
    durationSec,
    aMarkedMeetAgain: entry.meetAgainMarks.has([...entry.sockets][0]),
    bMarkedMeetAgain: entry.meetAgainMarks.has([...entry.sockets][1]),
  });
}

// 用 socket.id 找它正在哪個 active call
function findActiveCallBySocket(socketId) {
  for (const [roomCode, entry] of activeCalls) {
    if (entry.sockets.has(socketId)) return { roomCode, entry };
  }
  return null;
}

const generateRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
};

// 重逢碼：6 碼數字，好記好輸入
const generateReunionCode = () => {
  let code = '';
  for (let i = 0; i < 6; i++) code += Math.floor(Math.random() * 10);
  return code;
};

// ─── 配對相容性檢查 ────────────────────────────────
//
// 「a 是否願意跟 b 配對」這個是單方向的判斷
// 真正配對成功 = a 願意 b 且 b 願意 a
//
// 三種模式：
//   quick    = 任何人都行（無條件，但仍受 targetLangs 過濾）
//   nearby   = 只接受跟我同 bigRegion 的
//   specific = 只接受 myBigRegion === my targetRegion 的
//
// 加上「想找講語言」過濾：
//   targetLangs (空陣列 = 不過濾) → 對方的 lang 必須在我 targetLangs 內
//
// 配對矩陣（行=我、列=對方）：
//                對方 quick   對方 nearby   對方 specific
//   我 quick     ✅           ✅(if 同區)    ✅(if 對方目標=我區)
//   我 nearby   ✅(if 同區)   ✅(if 同區)    ✅(if 雙方都符合)
//   我 specific  ✅(if 對方在我目標)  ✅(雙方相符)  ✅(雙方相符)
//   * 上面所有 ✅ 都還要再過 targetLangs 檢查
function aWillingToB(a, b) {
  // 0. 話題模式不再擋配對 — 話題只是破冰提示
  //    （配對優先找同話題，找不到就配一般人，由 find_match 處理）
  {
    // 1. 模式條件
    let modeOk = false;
    if (a.mode === 'quick') {
      modeOk = true;
    } else if (a.mode === 'nearby') {
      modeOk = !!a.myBigRegion && a.myBigRegion === b.myBigRegion;
    } else if (a.mode === 'specific') {
      modeOk = !!a.targetRegion && a.targetRegion === b.myBigRegion;
    }
    if (!modeOk) return false;
  }

  // 2. 想找講語言過濾（空陣列 = 不過濾）
  if (Array.isArray(a.targetLangs) && a.targetLangs.length > 0) {
    if (!b.lang) return false;
    if (!a.targetLangs.includes(b.lang)) return false;
  }

  // 3. 性別過濾
  // targetGender: 'male' | 'female' | 'any' | null/undefined
  // 'any' 或空 = 不過濾
  if (a.targetGender && a.targetGender !== 'any') {
    if (!b.gender) return false; // 對方沒填性別 → 不配
    if (b.gender !== a.targetGender) return false;
  }

  return true;
}

function isCompatible(a, b) {
  if (a.socket.id === b.socket.id) return false;
  // 封鎖過濾：任一方封鎖了另一方就不配
  if (isBlocked(a.socket.data.userId, b.socket.data.userId)) return false;
  return aWillingToB(a, b) && aWillingToB(b, a);
}

// ─── Socket.IO Auth Middleware ──────────────────────
//
// 設計：永遠不擋連線。如果有 token 就驗，驗過記下 socket.data.userId；
// 沒 token 或驗失敗就 fallback 到 anonymous（用 socket.id 當 user.id）。
//
// 這樣 main.js 還沒接 Supabase Auth 之前，server 也能正常運作。
// 之後 main.js 接好就會自動升級。
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;

  if (token) {
    const result = await verifySupabaseJwt(token);
    if (result?.userId) {
      socket.data.userId = result.userId;
      socket.data.isAnonymous = result.isAnonymous;
      socket.data.authVerified = true;
    } else {
      // 有送 token 但驗證失敗 → log 但不擋
      console.log(`[auth] socket ${socket.id.slice(0, 6)} sent invalid token, falling back`);
      socket.data.userId = null;
      socket.data.authVerified = false;
    }
  } else {
    socket.data.userId = null;
    socket.data.authVerified = false;
  }

  next(); // 永遠 next()，從不擋
});

// ─── Socket.IO ───────────────────────────────────────
io.on('connection', (socket) => {
  const tag = socket.data.userId
    ? `${socket.id.slice(0, 6)}/u:${socket.data.userId.slice(0, 6)}${socket.data.isAnonymous ? '*' : ''}`
    : socket.id.slice(0, 8);
  console.log(`[+] ${tag} connected`);

  // 如果驗證過，順手 upsert users 表（不阻塞、失敗也沒差）
  // nickname 之後 main.js 會在 find_match 帶上來，這裡先用占位
  if (socket.data.userId) {
    upsertUser({
      id: socket.data.userId,
      nickname: null, // 之後 find_match 時更新
      isAnonymous: socket.data.isAnonymous,
    }).catch(() => {});
  }

  // ── 配對：客戶端要求進入佇列 ──
  //
  // 接受的參數：
  //   name           暱稱
  //   lang           STT 語言
  //   mode           'quick' | 'nearby' | 'specific'
  //   myBigRegion    我自己在哪（onboarding 存的）
  //   targetRegion   我想找哪個區的人 (specific 才用)
  //
  // 配對演算法：
  //   - 不分多個 queue（避免太細導致永遠配不到）
  //   - 用「**雙向相容**」演算法：A 願意跟 B + B 願意跟 A 才配
  //   - 走 queue 找第一個 compatible 的對手
  //   - 找不到就留在 queue 裡等
  socket.on('find_match', async ({ name, gender, targetGender, lang, mode, myBigRegion, targetRegion, targetLangs, avatar, reunionCode, topicId } = {}) => {
    const game = 'voice';
    const q = getQueue(game);

    if (q.some(p => p.socket.id === socket.id)) return; // 防重入

    // 封禁檢查
    if (socket.data.userId && await isBanned(getDbClient(), socket.data.userId)) {
      socket.emit('banned', { message: '你的帳號已被暫時停權，請稍後再試。' });
      return;
    }

    const me = {
      socket,
      name: name || 'Anonymous',
      gender,
      targetGender,
      lang,
      mode: mode || 'quick',
      myBigRegion: myBigRegion || null,
      targetRegion: targetRegion || null,
      targetLangs: Array.isArray(targetLangs) ? targetLangs : [],
      avatar: avatar || 'avatar_mature.png',
      topicId: topicId || null,
      reunionCode: reunionCode || null,
    };

    let otherIdx = -1;

    // 重逢碼優先配對：查 DB 找到對方 userId，再到 queue 裡找
    if (reunionCode && socket.data.userId) {
      try {
        const db = getDbClient();
        if (db) {
          const row = await db.execute({
            sql: `SELECT user_a, user_b FROM connections WHERE reunion_code = ? AND matched = 1`,
            args: [reunionCode],
          });
          if (row.rows.length > 0) {
            const { user_a, user_b } = row.rows[0];
            const partnerId = socket.data.userId === user_a ? user_b : user_a;
            // 在 queue 裡找這個人
            otherIdx = q.findIndex(other => other.socket.data.userId === partnerId);
            if (otherIdx !== -1) {
              console.log(`[💌] Reunion code ${reunionCode}: matched ${socket.data.userId} ↔ ${partnerId}`);
            } else {
              console.log(`[💌] Reunion code ${reunionCode}: partner ${partnerId} not in queue, waiting...`);
              me.reunionPartnerId = partnerId; // 記住，之後有人進來再比對
            }
          } else {
            console.log(`[💌] Reunion code ${reunionCode}: not found or not matched`);
            socket.emit('reunion_invalid');
          }
        }
      } catch (err) {
        console.log(`[💌] Reunion code lookup error: ${err.message}`);
      }
    }

    // 一般配對（如果重逢碼沒找到人）
    if (otherIdx === -1) {
      // 先查有沒有人是用重逢碼在等我
      if (socket.data.userId) {
        otherIdx = q.findIndex(other =>
          other.reunionPartnerId === socket.data.userId
        );
      }
      // 話題優先：先找同話題 + 相容的人
      if (otherIdx === -1 && me.topicId) {
        otherIdx = q.findIndex(other =>
          other.topicId === me.topicId && isCompatible(me, other)
        );
      }
      // 再用一般相容性配對（不管話題）
      if (otherIdx === -1) {
        otherIdx = q.findIndex(other => isCompatible(me, other));
      }
    }

    if (otherIdx !== -1) {
      // 配對成功
      const other = q.splice(otherIdx, 1)[0];
      const players = [other, me]; // other 是先進來的 = host
      const roomCode = generateRoomCode();

      players.forEach(p => p.socket.join(roomCode));

      // 查雙方 IP geo，跟 declared region 比較（fire-and-forget，不阻塞 match_found）
      // 結果透過 match_found 帶給對方
      const verifyResults = [null, null]; // [player0 verified?, player1 verified?]
      const verifyPromises = players.map(async (p, idx) => {
        try {
          const ip = extractClientIp(p.socket.request);
          const geo = await lookupIp(ip, getDbClient());
          // 比較：IP 偵測的大區 vs 用戶自選的大區
          // 「一致」= 已驗證，「不一致 或 偵測不到」= 未驗證
          if (geo?.bigRegion && p.myBigRegion) {
            // 比國家即可（同國 = 驗證通過，不用精確到大區）
            const ipCountry = (geo.country || '').toUpperCase();
            const declaredCountry = p.myBigRegion.split('-')[0].toUpperCase();
            verifyResults[idx] = ipCountry === declaredCountry;
          } else {
            verifyResults[idx] = null; // 無法判斷
          }
        } catch {
          verifyResults[idx] = null;
        }
      });

      // 等 verify 但設 timeout（不能讓 match_found 卡住）
      await Promise.race([
        Promise.all(verifyPromises),
        new Promise(r => setTimeout(r, 2000)), // 最多等 2 秒
      ]);

      const host = players[0];
      players.forEach((p, idx) => {
        const peerIdx = 1 - idx;
        p.socket.emit('match_found', {
          roomCode,
          isHost: p.socket.id === host.socket.id,
          peer: {
            id: players[peerIdx].socket.id,
            name: players[peerIdx].name,
            userId: players[peerIdx].socket.data.userId || null,
            avatar: players[peerIdx].avatar || 'avatar_mature.png',
          },
          // 告訴這一端：對方資訊
          peerVerified: verifyResults[peerIdx],
          peerRegion: players[peerIdx].myBigRegion || null,
          peerGender: players[peerIdx].gender || null,
          matchedMode: (me.topicId || other.topicId) ? 'topic' : (me.mode === other.mode ? me.mode : 'mixed'),
          myTopicId: p.topicId || null,
          peerTopicId: players[peerIdx].topicId || null,
        });
      });
      console.log(`[★] Matched ${players[0].name}(${players[0].mode}) ↔ ${players[1].name}(${players[1].mode}) in room ${roomCode} [verify: ${verifyResults}]`);

      // 寫 DB（fire and forget），追蹤這通電話
      startActiveCall(roomCode, players);
    } else {
      // 沒找到 → 加入 queue 等
      q.push(me);
      socket.emit('match_queued', { position: q.length });
      console.log(`[Q] ${me.name}(${me.mode}${me.targetRegion ? '→' + me.targetRegion : ''}) queued (${q.length})`);
    }

    // 如果該 socket 有驗證過的 user.id，順手更新 users.nickname
    if (socket.data.userId && name) {
      upsertUser({
        id: socket.data.userId,
        nickname: name,
        isAnonymous: socket.data.isAnonymous,
      }).catch(() => {});
    }
  });

  // ── 取消配對 ──
  socket.on('cancel_match', () => {
    removeFromAllQueues(socket.id);
    socket.emit('match_cancelled');
  });

  // ── WebRTC 訊令轉發（server 完全不看 signal 內容）──
  // 加 log 是為了診斷「配對成功但音訊不通」這類問題
  // log 不會解析 signal payload 內容，只記 type
  socket.on('webrtc_signal', ({ target, signal }) => {
    const from = socket.id.slice(0, 6);
    const to = (target || '').slice(0, 6);
    let type = 'unknown';
    if (signal?.type === 'offer') type = 'OFFER';
    else if (signal?.type === 'answer') type = 'ANSWER';
    else if (signal?.candidate) {
      // candidate 字串：candidate:foundation component protocol priority ip port typ TYPE ...
      const m = String(signal.candidate).match(/typ (\w+)/);
      type = `cand-${m ? m[1] : '?'}`;
    }
    console.log(`[SDP] ${from} → ${to} ${type}`);
    io.to(target).emit('webrtc_signal', { from: socket.id, signal });
  });

  // ── 想再遇 ──
  // 用戶通話中按「💚 想再遇」→ 標記到 activeCalls 的 meetAgainMarks
  // 掛斷時才檢查「雙方是否都按了」→ 是 → emit mutual event
  socket.on('meet_again', () => {
    const found = findActiveCallBySocket(socket.id);
    if (!found) return;
    found.entry.meetAgainMarks.add(socket.id);
    console.log(`[💚] ${socket.id.slice(0, 6)} marked meet_again in room ${found.roomCode}`);

    // 寫 DB：更新 kaitalk_calls 的標記欄位（fire-and-forget）
    if (found.entry.callId) {
      const isA = found.entry.sockets.values().next().value === socket.id;
      const col = isA ? 'a_marked_meet_again' : 'b_marked_meet_again';
      getDbClient()?.execute({
        sql: `UPDATE kaitalk_calls SET ${col} = 1 WHERE id = ?`,
        args: [found.entry.callId],
      }).catch(() => {});
    }
  });

  // ── 對方掛電話 ──
  socket.on('hangup', ({ target }) => {
    console.log(`[HANGUP] ${socket.id.slice(0, 6)} → ${(target || '').slice(0, 6)}`);

    // 掛斷前先檢查：雙方是否都按了想再遇？
    const found = findActiveCallBySocket(socket.id);
    if (found) {
      const marks = found.entry.meetAgainMarks;
      const bothMarked = marks.size >= 2;

      if (bothMarked && found.entry.userA && found.entry.userB) {
        // 互相想再遇！通知雙方
        const peerName4A = found.entry.nameB;
        const peerName4B = found.entry.nameA;

        // 找兩個 socket
        const socketIds = [...found.entry.sockets];
        socketIds.forEach(sid => {
          const isA = sid === socketIds[0];
          io.to(sid).emit('meet_again_mutual', {
            peerName: isA ? peerName4A : peerName4B,
          });
        });

        console.log(`[🎉] Mutual meet-again in room ${found.roomCode}!`);

        // 產生重逢碼 + 寫 connections.matched = true
        const [a, b] = [found.entry.userA, found.entry.userB].sort();
        const reunionCode = generateReunionCode();

        getDbClient()?.execute({
          sql: `
            UPDATE connections
               SET a_likes_b = 1, b_likes_a = 1,
                   matched = 1, matched_at = CURRENT_TIMESTAMP,
                   reunion_code = ?
             WHERE user_a = ? AND user_b = ?
          `,
          args: [reunionCode, a, b],
        }).catch(() => {});

        // 把重逢碼傳給雙方
        socketIds.forEach(sid => {
          io.to(sid).emit('reunion_code', { code: reunionCode });
        });
      }

      endActiveCall(found.roomCode, 'hangup');
    }

    io.to(target).emit('peer_hangup');
  });

  // ── DataChannel fallback（之後字幕也可以走這條 socket 備援）──
  socket.on('send_to_peer', ({ target, message }) => {
    io.to(target).emit('peer_message', { from: socket.id, message });
  });

  socket.on('disconnect', () => {
    removeFromAllQueues(socket.id);
    // 通知還在房間裡的對方
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit('peer_hangup');
      }
    }
    // 結束 active call（如果這個 socket 在某通電話裡）
    const found = findActiveCallBySocket(socket.id);
    if (found) {
      endActiveCall(found.roomCode, 'disconnect');
    }
    console.log(`[-] ${socket.id.slice(0, 8)} disconnected`);
  });
});

// SPA fallback
app.get(/(.*)/, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`\n  kaitalk signaling server`);
  console.log(`  ────────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  MAX_PEERS = ${MAX_PEERS}`);
  console.log(`  打開兩個瀏覽器分頁就能測試\n`);
});
