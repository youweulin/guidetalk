/**
 * GuideTalk server.js
 *
 * 輕量訊令伺服器：
 *   - 房間（建立、加入、斷線清理）
 *   - WebRTC 訊令轉發（offer / answer / ICE）
 *   - GPS pub/sub（in-memory，不寫 DB、不寫 log）
 *
 * 通話媒體永遠 P2P，不經 server。
 * GPS 經 server 廣播，但只在記憶體 pub/sub，房間結束即消失。
 */

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.set('trust proxy', true);
app.use(express.static(join(__dirname, 'public')));

// 健康檢查 / 簡易狀態
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    peers: [...rooms.values()].reduce((n, r) => n + r.peers.size, 0),
    uptime: Math.floor(process.uptime()),
  });
});

// 房號 → /r/ABC123 直接打開房（前端依 path 自動加入）
app.get(/^\/r\/[A-Z0-9]+\/?$/, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// SPA fallback
app.get(/(.*)/, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ─── 房間註冊表 ─────────────────────────────────────────
//
// rooms: Map<roomCode, {
//   createdAt: number,
//   hostId: socket.id,
//   peers: Map<peerId, {
//     socketId, name, color, joinedAt,
//     loc: { lat, lng, acc, ts } | null,
//   }>,
// }>

const rooms = new Map();

const ROOM_TTL_MS       = 12 * 60 * 60 * 1000; // 12 小時硬上限
const ROOM_EMPTY_TTL_MS = 5 * 60 * 1000;        // 沒人後 5 分鐘才回收（防創房者瞬間離開）
const ROOM_CODE_LEN = 6;
const COLORS = [
  '#e63946', '#1d7fe6', '#0a7d3e', '#f4a261',
  '#9b51e0', '#2a9d8f', '#e76f51', '#264653',
];

function genRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function pickColor(room) {
  const used = new Set([...room.peers.values()].map(p => p.color));
  return COLORS.find(c => !used.has(c)) || COLORS[room.peers.size % COLORS.length];
}

function getRoom(code) {
  return rooms.get(code) || null;
}

function ensureRoomCreated(code, hostSocketId) {
  if (rooms.has(code)) {
    const room = rooms.get(code);
    room.emptyAt = null;  // 有人重新進來，取消空房計時
    return room;
  }
  const room = {
    createdAt: Date.now(),
    hostId: hostSocketId,
    peers: new Map(),
    emptyAt: null,
  };
  rooms.set(code, room);
  return room;
}

function removePeer(roomCode, peerId) {
  const room = getRoom(roomCode);
  if (!room) return;
  room.peers.delete(peerId);
  if (room.peers.size === 0) {
    // 不立刻刪：標記空房時間，5 分鐘後沒人才回收
    room.emptyAt = Date.now();
    console.log(`[room ${roomCode}] empty, will GC in ${ROOM_EMPTY_TTL_MS/1000}s if nobody joins`);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    // 1) 硬上限 12 小時
    if (now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
      io.to(code).emit('room_expired');
      console.log(`[room ${code}] TTL expired`);
      continue;
    }
    // 2) 空房 + 過 5 分鐘 → 回收
    if (room.peers.size === 0 && room.emptyAt && (now - room.emptyAt > ROOM_EMPTY_TTL_MS)) {
      rooms.delete(code);
      console.log(`[room ${code}] empty too long, GC`);
    }
  }
}, 30_000);

// ─── Socket 邏輯 ─────────────────────────────────────────

io.on('connection', (socket) => {
  let myRoom = null;
  let myName = null;

  socket.on('create_room', ({ name } = {}, ack) => {
    let code;
    do { code = genRoomCode(); } while (rooms.has(code));

    const room = ensureRoomCreated(code, socket.id);
    const color = pickColor(room);
    const peer = {
      socketId: socket.id,
      name: String(name || '').slice(0, 24) || `Guide-${code.slice(0, 3)}`,
      color,
      joinedAt: Date.now(),
      loc: null,
    };
    room.peers.set(socket.id, peer);

    socket.join(code);
    myRoom = code;
    myName = peer.name;

    if (typeof ack === 'function') {
      ack({ ok: true, roomCode: code, you: { peerId: socket.id, color, name: peer.name } });
    }
    console.log(`[room ${code}] created by ${peer.name} (${socket.id})`);
  });

  socket.on('join_room', ({ code, name } = {}, ack) => {
    const roomCode = String(code || '').toUpperCase().trim();
    const room = getRoom(roomCode);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'room_not_found' });
      return;
    }

    const color = pickColor(room);
    const peer = {
      socketId: socket.id,
      name: String(name || '').slice(0, 24) || `Guide-${roomCode.slice(0, 3)}`,
      color,
      joinedAt: Date.now(),
      loc: null,
    };
    room.peers.set(socket.id, peer);

    socket.join(roomCode);
    myRoom = roomCode;
    myName = peer.name;

    const peerList = [...room.peers.values()].map(p => ({
      peerId: p.socketId, name: p.name, color: p.color, loc: p.loc,
    }));

    if (typeof ack === 'function') {
      ack({
        ok: true,
        roomCode,
        you: { peerId: socket.id, color, name: peer.name },
        peers: peerList,
      });
    }

    socket.to(roomCode).emit('peer_joined', {
      peerId: socket.id, name: peer.name, color,
    });

    console.log(`[room ${roomCode}] +${peer.name} (${socket.id}) total=${room.peers.size}`);
  });

  // WebRTC 訊令轉發
  socket.on('signal', ({ target, signal } = {}) => {
    if (!myRoom || !target || !signal) return;
    const room = getRoom(myRoom);
    if (!room || !room.peers.has(target)) return;
    io.to(target).emit('signal', { from: socket.id, signal });
  });

  // GPS pub/sub
  socket.on('location', (loc = {}) => {
    if (!myRoom) return;
    const room = getRoom(myRoom);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    if (!peer) return;

    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

    const clean = {
      lat, lng,
      acc: Number.isFinite(Number(loc.acc)) ? Number(loc.acc) : null,
      heading: Number.isFinite(Number(loc.heading)) ? Number(loc.heading) : null,
      speed: Number.isFinite(Number(loc.speed)) ? Number(loc.speed) : null,
      ts: Date.now(),
    };
    peer.loc = clean;

    socket.to(myRoom).emit('peer_location', {
      peerId: socket.id,
      name: peer.name,
      color: peer.color,
      ...clean,
    });
  });

  socket.on('chat', ({ text } = {}) => {
    if (!myRoom || !text) return;
    const room = getRoom(myRoom);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    if (!peer) return;
    const clean = String(text).slice(0, 200);
    io.to(myRoom).emit('chat', {
      peerId: socket.id, name: peer.name, color: peer.color,
      text: clean, ts: Date.now(),
    });
  });

  socket.on('ptt', ({ on } = {}) => {
    if (!myRoom) return;
    socket.to(myRoom).emit('peer_ptt', { peerId: socket.id, on: !!on });
  });

  socket.on('leave_room', () => {
    cleanup('left');
  });

  socket.on('disconnect', () => {
    cleanup('disconnect');
  });

  function cleanup(reason) {
    if (!myRoom) return;
    const code = myRoom;
    const name = myName;
    socket.to(code).emit('peer_left', { peerId: socket.id, reason });
    removePeer(code, socket.id);
    socket.leave(code);
    console.log(`[room ${code}] -${name} (${socket.id}) reason=${reason}`);
    myRoom = null;
    myName = null;
  }
});

const PORT = process.env.PORT || 9001;
httpServer.listen(PORT, () => {
  console.log(`GuideTalk server listening on :${PORT}`);
});
