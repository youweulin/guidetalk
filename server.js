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

  // 2. 想找講語言過濾（空陣列 = 不過濾）
  if (Array.isArray(a.targetLangs) && a.targetLangs.length > 0) {
    if (!b.lang) return false; // 對方沒講語言 = 沒辦法判斷
    if (!a.targetLangs.includes(b.lang)) return false;
  }

  return true;
}

function isCompatible(a, b) {
  if (a.socket.id === b.socket.id) return false;
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
  socket.on('find_match', async ({ name, gender, targetGender, lang, mode, myBigRegion, targetRegion, targetLangs } = {}) => {
    const game = 'voice';
    const q = getQueue(game);

    if (q.some(p => p.socket.id === socket.id)) return; // 防重入

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
    };

    // 嘗試在 queue 裡找一個 compatible 的對手
    // 優先找 matched=true（互相想再遇的人），再找一般 compatible
    // 這樣「想再遇」的人會被優先配在一起
    let otherIdx = -1;

    // 先看有沒有 mutual matched 的對象（需要查 DB，但太慢不現實）
    // 簡化方案：直接走 findIndex 即可，之後 Phase 4 做更精密的
    otherIdx = q.findIndex(other => isCompatible(me, other));

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
          },
          // 告訴這一端：對方的位置驗證結果
          peerVerified: verifyResults[peerIdx],
          // 告訴這一端：對方選的大區（用在地化豆知識用）
          peerRegion: players[peerIdx].myBigRegion || null,
          matchedMode: me.mode === other.mode ? me.mode : 'mixed',
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

        // 寫 connections.matched = true
        const [a, b] = [found.entry.userA, found.entry.userB].sort();
        getDbClient()?.execute({
          sql: `
            UPDATE connections
               SET a_likes_b = 1, b_likes_a = 1,
                   matched = 1, matched_at = CURRENT_TIMESTAMP
             WHERE user_a = ? AND user_b = ?
          `,
          args: [a, b],
        }).catch(() => {});
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
