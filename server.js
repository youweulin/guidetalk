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
import { upsertUser, dbConfigured, startCall, endCall } from './lib/db.js';

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
    startedAt: now,
    sockets: new Set([players[0].socket.id, players[1].socket.id]),
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
  socket.on('find_match', ({ name, gender, targetGender, lang } = {}) => {
    // 簡單版：先用單一佇列，篩選邏輯之後再加
    const game = 'voice';
    const q = getQueue(game);

    if (q.some(p => p.socket.id === socket.id)) return; // 防重入

    q.push({ socket, name: name || 'Anonymous', gender, targetGender, lang });
    socket.emit('match_queued', { position: q.length });
    console.log(`[Q] ${name || socket.id.slice(0, 8)} queued (${q.length}/${MAX_PEERS})`);

    // 如果該 socket 有驗證過的 user.id，順手更新 users.nickname
    // 失敗也不阻塞（lib/db.js 的 helper 永遠 silent fail）
    if (socket.data.userId && name) {
      upsertUser({
        id: socket.data.userId,
        nickname: name,
        isAnonymous: socket.data.isAnonymous,
      }).catch(() => {});
    }

    // 滿 MAX_PEERS 人 → 直接配對（Phase 0 跳過 vote step，加速測試）
    if (q.length >= MAX_PEERS) {
      const players = q.splice(0, MAX_PEERS);
      const roomCode = generateRoomCode();

      // 兩人都加入同一個 socket.io 房間
      players.forEach(p => p.socket.join(roomCode));

      // host = 第一個進佇列的，負責發 WebRTC offer
      const host = players[0];
      players.forEach((p, idx) => {
        p.socket.emit('match_found', {
          roomCode,
          isHost: p.socket.id === host.socket.id,
          peer: {
            id: players[1 - idx].socket.id,
            name: players[1 - idx].name,
          },
        });
      });
      console.log(`[★] Matched ${players.map(p => p.name).join(' ↔ ')} in room ${roomCode}`);

      // 寫 DB（fire and forget），追蹤這通電話
      startActiveCall(roomCode, players);
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

  // ── 對方掛電話 ──
  socket.on('hangup', ({ target }) => {
    console.log(`[HANGUP] ${socket.id.slice(0, 6)} → ${(target || '').slice(0, 6)}`);
    io.to(target).emit('peer_hangup');

    // 結束 active call（如果這個 socket 真的在某通電話裡）
    const found = findActiveCallBySocket(socket.id);
    if (found) {
      endActiveCall(found.roomCode, 'hangup');
    }
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
