/**
 * GuideTalk client
 *
 * 流程：
 *   1. 首頁：輸入暱稱 → 建房 / 加入
 *   2. 房間：
 *      - WebRTC mesh 通話（PTT 對講機 / 常開）
 *      - GPS 透過 Socket.IO 廣播
 *      - Leaflet 地圖顯示所有夥伴
 *      - 點擊夥伴 → 在原生地圖開啟導航
 */

import { io } from 'https://cdn.socket.io/4.8.1/socket.io.esm.min.js';

// ─── 平台偵測 ────────────────────────────────────
const Capacitor = window.Capacitor || null;
const isNative = !!(Capacitor?.isNativePlatform?.());
const isIOSApp = isNative && Capacitor?.getPlatform?.() === 'ios';

// 在 Capacitor App 裡走遠端 server，PWA 走相對路徑（同源）
const SERVER_URL = isNative ? 'https://guidetalk.zeabur.app' : '';
const SHARE_BASE = (location.origin && !location.origin.startsWith('capacitor:'))
  ? location.origin
  : 'https://guidetalk.zeabur.app';

// ─── DOM helpers ───────────────────────────────────
const $ = (id) => document.getElementById(id);

const screens = {
  home: $('screen-home'),
  room: $('screen-room'),
};
function showScreen(name) {
  for (const k of Object.keys(screens)) screens[k].classList.toggle('active', k === name);
}

const toastEl = $('toast');
let toastTimer = null;
function toast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function setStatus(text, isError = false) {
  const el = $('status-line');
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}

// ─── 狀態 ──────────────────────────────────────────
const state = {
  socket: null,
  myName: localStorage.getItem('gt_name') || '',
  myPeerId: null,
  myColor: null,
  roomCode: null,

  // peers: Map<peerId, { name, color, loc?, pc?, audio?, marker?, chip?, pttOn? }>
  peers: new Map(),

  localStream: null,
  micReady: false,
  hotMic: false,            // false = PTT, true = 常開麥
  pttHolding: false,

  map: null,
  myMarker: null,
  hasFitOnce: false,

  geoWatchHandle: null,     // { type: 'web'|'cap', id }
  myLastLoc: null,

  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

$('name-input').value = state.myName;

// ─── 網路 ──────────────────────────────────────────
function connectSocket() {
  if (state.socket?.connected) return state.socket;
  state.socket = io(SERVER_URL || undefined, {
    transports: ['websocket', 'polling'],
    reconnection: true,
  });

  state.socket.on('connect', () => {
    console.log('[socket] connected', state.socket.id);
  });

  state.socket.on('signal', handleSignal);
  state.socket.on('peer_joined', (p) => {
    console.log('[peer] joined', p);
    addPeer(p);
    setStatus(`${p.name} 加入了`);
    setTimeout(() => setStatus(''), 2000);
    // 既存的 peer 不主動 offer，等新加入的人來 offer
  });
  state.socket.on('peer_left', ({ peerId }) => {
    const p = state.peers.get(peerId);
    console.log('[peer] left', peerId);
    removePeer(peerId);
    if (p) {
      setStatus(`${p.name} 離開了`);
      setTimeout(() => setStatus(''), 2000);
    }
  });
  state.socket.on('peer_location', (loc) => {
    updatePeerLocation(loc.peerId, loc);
  });
  state.socket.on('peer_ptt', ({ peerId, on }) => {
    const p = state.peers.get(peerId);
    if (!p) return;
    p.pttOn = on;
    if (p.chip) p.chip.classList.toggle('ptt-on', !!on);
  });
  state.socket.on('room_expired', () => {
    toast('房間已過期');
    leaveRoom();
  });
  state.socket.on('disconnect', () => {
    setStatus('連線中斷，重新連線中…', true);
  });
}

function emitAck(event, payload) {
  return new Promise((resolve, reject) => {
    state.socket.emit(event, payload, (resp) => {
      if (!resp?.ok) reject(new Error(resp?.error || 'unknown'));
      else resolve(resp);
    });
    setTimeout(() => reject(new Error('timeout')), 8000);
  });
}

// ─── 建房 / 加入 ───────────────────────────────────
async function createRoom() {
  const name = $('name-input').value.trim();
  if (!name) { toast('請輸入暱稱'); return; }
  state.myName = name;
  localStorage.setItem('gt_name', name);

  connectSocket();
  setStatus('建立房間中…');

  try {
    if (!state.socket.connected) await new Promise(r => state.socket.once('connect', r));
    const resp = await emitAck('create_room', { name });
    enterRoom(resp);
  } catch (err) {
    toast('建立失敗：' + err.message);
    setStatus('');
  }
}

async function joinRoom(code) {
  const name = $('name-input').value.trim();
  if (!name) { toast('請輸入暱稱'); return; }
  if (!code || code.length < 4) { toast('請輸入正確房號'); return; }
  state.myName = name;
  localStorage.setItem('gt_name', name);

  connectSocket();
  setStatus(`加入房間 ${code}…`);

  try {
    if (!state.socket.connected) await new Promise(r => state.socket.once('connect', r));
    const resp = await emitAck('join_room', { code, name });
    enterRoom(resp);
  } catch (err) {
    toast(err.message === 'room_not_found' ? '找不到此房間' : '加入失敗：' + err.message);
    setStatus('');
  }
}

async function enterRoom(resp) {
  state.roomCode = resp.roomCode;
  state.myPeerId = resp.you.peerId;
  state.myColor  = resp.you.color;

  $('room-code-display').textContent = resp.roomCode;
  showScreen('room');
  ensureMap();

  // 已存在的 peers（如果是 join）
  if (resp.peers) {
    for (const p of resp.peers) {
      if (p.peerId === state.myPeerId) continue;
      addPeer(p);
      if (p.loc) updatePeerLocation(p.peerId, p.loc);
    }
  }
  refreshRoomMeta();

  // 取得麥克風（之後用於 PTT / 常開），同時建 mesh 連線
  await ensureMic().catch(err => {
    console.warn('mic failed', err);
    setStatus('麥克風無法取得，可繼續看位置但無法通話', true);
  });

  // 我作為「新加入者」→ 對所有既存 peer 發起 offer
  for (const peerId of state.peers.keys()) {
    initiateOffer(peerId).catch(err => console.warn('offer failed', peerId, err));
  }

  // 開始追蹤位置
  startGeoWatch();
}

function leaveRoom() {
  try { state.socket?.emit('leave_room'); } catch {}
  // 關掉所有 peer connection
  for (const [, p] of state.peers) closePeer(p);
  state.peers.clear();
  $('peer-strip').innerHTML = '';
  // 停麥
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
    state.micReady = false;
  }
  // 停 GPS
  stopGeoWatch();
  // 清地圖
  if (state.map) {
    state.map.remove();
    state.map = null;
    state.myMarker = null;
    state.hasFitOnce = false;
  }
  state.roomCode = null;
  showScreen('home');
}

// ─── 房間 UI 維護 ──────────────────────────────────
function refreshRoomMeta() {
  const total = state.peers.size + 1;
  $('room-meta').textContent = `${total} 人在線`;
}

function addPeer(p) {
  if (state.peers.has(p.peerId)) return;
  const peer = {
    name: p.name, color: p.color,
    loc: p.loc || null,
    pc: null, audio: null, marker: null, chip: null,
    pttOn: false,
  };
  state.peers.set(p.peerId, peer);
  buildPeerChip(p.peerId, peer);
  refreshRoomMeta();
}

function removePeer(peerId) {
  const p = state.peers.get(peerId);
  if (!p) return;
  closePeer(p);
  if (p.chip) p.chip.remove();
  state.peers.delete(peerId);
  refreshRoomMeta();
  if (state.peers.size === 0) fitMapBounds();
}

function closePeer(p) {
  try { p.pc?.close?.(); } catch {}
  if (p.audio) {
    try { p.audio.pause(); } catch {}
    p.audio.srcObject = null;
    p.audio.remove?.();
  }
  if (p.marker && state.map) state.map.removeLayer(p.marker);
  p.pc = null;
  p.audio = null;
  p.marker = null;
}

function buildPeerChip(peerId, peer) {
  const chip = document.createElement('div');
  chip.className = 'peer-chip';
  chip.dataset.peerId = peerId;
  chip.innerHTML = `
    <span class="dot" style="background:${peer.color}"></span>
    <span class="nm">${escapeHtml(peer.name)}</span>
    <span class="dist"></span>
  `;
  chip.addEventListener('click', () => {
    const cur = state.peers.get(peerId);
    if (cur?.loc) {
      state.map.setView([cur.loc.lat, cur.loc.lng], 16);
      cur.marker?.openPopup?.();
    }
  });
  $('peer-strip').appendChild(chip);
  peer.chip = chip;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ─── 地圖 ──────────────────────────────────────────
function ensureMap() {
  if (state.map) return state.map;
  // 預設視角：台灣中部，等取到 GPS 再調整
  state.map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView([23.973, 120.982], 7);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(state.map);
  return state.map;
}

function makeIcon(color, label, isMe = false) {
  return L.divIcon({
    className: '',
    html: `<div class="marker-pin ${isMe ? 'me' : ''}" style="background:${color};color:${color}">
             <span>${escapeHtml(label || '')}</span>
           </div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  });
}

function fitMapBounds() {
  if (!state.map) return;
  const pts = [];
  if (state.myLastLoc) pts.push([state.myLastLoc.lat, state.myLastLoc.lng]);
  for (const [, p] of state.peers) {
    if (p.loc) pts.push([p.loc.lat, p.loc.lng]);
  }
  if (pts.length === 0) return;
  if (pts.length === 1) {
    state.map.setView(pts[0], 15);
  } else {
    state.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
  }
}

function updateMyMarker(loc) {
  if (!state.map) return;
  const initial = (state.myName || '?').charAt(0).toUpperCase();
  if (!state.myMarker) {
    state.myMarker = L.marker([loc.lat, loc.lng], {
      icon: makeIcon(state.myColor || '#0a7d3e', initial, true),
      zIndexOffset: 1000,
    }).addTo(state.map);
    state.myMarker.bindPopup(`<b>${escapeHtml(state.myName)}（你）</b>`);
  } else {
    state.myMarker.setLatLng([loc.lat, loc.lng]);
  }
  if (!state.hasFitOnce) {
    state.hasFitOnce = true;
    fitMapBounds();
  }
}

function updatePeerLocation(peerId, loc) {
  const p = state.peers.get(peerId);
  if (!p) return;
  p.loc = loc;
  if (!state.map) return;
  const initial = (p.name || '?').charAt(0).toUpperCase();
  if (!p.marker) {
    p.marker = L.marker([loc.lat, loc.lng], {
      icon: makeIcon(p.color, initial),
    }).addTo(state.map);
    bindPeerPopup(peerId, p);
  } else {
    p.marker.setLatLng([loc.lat, loc.lng]);
  }
  updatePeerDistance(peerId, p);
}

function bindPeerPopup(peerId, p) {
  if (!p.marker) return;
  const html = `
    <b>${escapeHtml(p.name)}</b>
    <div style="margin-top:6px;display:flex;gap:6px;">
      <button class="btn" data-act="open-maps" data-peer="${peerId}"
              style="padding:8px 12px;font-size:13px;min-height:36px;border-radius:8px;">
        在地圖開啟
      </button>
    </div>
  `;
  p.marker.bindPopup(html);
  p.marker.on('popupopen', (e) => {
    const node = e.popup.getElement();
    node?.querySelector('[data-act="open-maps"]')?.addEventListener('click', () => {
      openInNativeMaps(p.loc.lat, p.loc.lng, p.name);
    });
  });
}

function updatePeerDistance(peerId, p) {
  if (!p.chip) return;
  const distEl = p.chip.querySelector('.dist');
  if (!distEl) return;
  if (!state.myLastLoc || !p.loc) {
    distEl.textContent = '';
    return;
  }
  const meters = haversine(
    state.myLastLoc.lat, state.myLastLoc.lng,
    p.loc.lat, p.loc.lng,
  );
  distEl.textContent = formatDistance(meters);
}

function refreshAllDistances() {
  for (const [peerId, p] of state.peers) updatePeerDistance(peerId, p);
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)}km`;
}

function openInNativeMaps(lat, lng, label = '') {
  const ua = navigator.userAgent || '';
  const q = encodeURIComponent(label || `${lat},${lng}`);
  let url;
  if (/iPhone|iPad|iPod|Mac OS X/.test(ua)) {
    url = `https://maps.apple.com/?ll=${lat},${lng}&q=${q}`;
  } else {
    url = `https://www.google.com/maps?q=${lat},${lng}(${q})`;
  }
  // 在 Capacitor App 中用瀏覽器打開（會跳到原生 Maps）
  window.open(url, '_blank');
}

// ─── GPS ──────────────────────────────────────────
async function startGeoWatch() {
  stopGeoWatch();
  // 先試 Capacitor Geolocation（iOS App）
  if (isNative && Capacitor?.Plugins?.Geolocation) {
    try {
      const Geo = Capacitor.Plugins.Geolocation;
      await Geo.requestPermissions();
      const id = await Geo.watchPosition(
        { enableHighAccuracy: true, timeout: 20000 },
        (pos, err) => {
          if (err) { console.warn('cap geo err', err); return; }
          if (!pos) return;
          handleGeoUpdate(pos.coords);
        },
      );
      state.geoWatchHandle = { type: 'cap', id };
      setStatus('定位中…');
      return;
    } catch (err) {
      console.warn('Capacitor Geolocation failed, fallback to web', err);
    }
  }
  // Fallback：Web Geolocation API（PWA / 桌機 / Android Chrome）
  if (!navigator.geolocation) {
    setStatus('此裝置不支援定位', true);
    return;
  }
  const id = navigator.geolocation.watchPosition(
    pos => handleGeoUpdate(pos.coords),
    err => {
      console.warn('web geo err', err);
      setStatus('定位失敗，請開啟定位權限', true);
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
  );
  state.geoWatchHandle = { type: 'web', id };
  setStatus('定位中…');
}

function stopGeoWatch() {
  const h = state.geoWatchHandle;
  if (!h) return;
  try {
    if (h.type === 'cap') Capacitor.Plugins.Geolocation.clearWatch({ id: h.id });
    else navigator.geolocation.clearWatch(h.id);
  } catch {}
  state.geoWatchHandle = null;
}

let lastEmittedAt = 0;
const GPS_MIN_INTERVAL_MS = 3000;

function handleGeoUpdate(coords) {
  const loc = {
    lat: coords.latitude,
    lng: coords.longitude,
    acc: coords.accuracy ?? null,
    heading: Number.isFinite(coords.heading) ? coords.heading : null,
    speed: Number.isFinite(coords.speed) ? coords.speed : null,
    ts: Date.now(),
  };
  state.myLastLoc = loc;
  updateMyMarker(loc);
  refreshAllDistances();

  // 節流：3 秒一次
  const now = Date.now();
  if (now - lastEmittedAt < GPS_MIN_INTERVAL_MS) return;
  lastEmittedAt = now;
  state.socket?.emit('location', loc);
  setStatus('');
}

// ─── 麥克風 ───────────────────────────────────────
async function ensureMic() {
  if (state.micReady) return state.localStream;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  state.localStream = stream;
  state.micReady = true;
  // 預設靜音（PTT 模式）
  setMicEnabled(state.hotMic);
  $('btn-ptt').classList.remove('disabled');
  $('ptt-label').textContent = state.hotMic ? '🔊 麥克風常開中' : '🎙️ 按住講話';
  return stream;
}

function setMicEnabled(enabled) {
  if (!state.localStream) return;
  state.localStream.getAudioTracks().forEach(t => t.enabled = !!enabled);
}

// ─── WebRTC mesh ───────────────────────────────────
function createPC(peerId) {
  const pc = new RTCPeerConnection({ iceServers: state.ICE_SERVERS });

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      pc.addTrack(track, state.localStream);
    }
  }

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) {
      state.socket.emit('signal', {
        target: peerId,
        signal: { type: 'ice', candidate: e.candidate },
      });
    }
  });

  pc.addEventListener('track', (e) => {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    if (!peer.audio) {
      peer.audio = new Audio();
      peer.audio.autoplay = true;
      peer.audio.playsInline = true;
      // 不加進 DOM，autoplay 即可（iOS 需要先有使用者互動，已由建房/加入按鈕滿足）
    }
    peer.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
    peer.audio.play?.().catch(() => {});
  });

  pc.addEventListener('connectionstatechange', () => {
    console.log(`[pc ${peerId}] state`, pc.connectionState);
    if (pc.connectionState === 'failed') {
      // 簡單重試一次
      setTimeout(() => initiateOffer(peerId).catch(()=>{}), 1500);
    }
  });

  return pc;
}

function ensurePC(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return null;
  if (!peer.pc) peer.pc = createPC(peerId);
  return peer.pc;
}

async function initiateOffer(peerId) {
  await ensureMic();  // 拿到麥克風才有 track 可加
  const pc = ensurePC(peerId);
  if (!pc) return;
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  state.socket.emit('signal', {
    target: peerId,
    signal: { type: offer.type, sdp: offer.sdp },
  });
}

async function handleSignal({ from, signal }) {
  if (!state.peers.has(from) && signal?.type === 'offer') {
    // 還沒收到 peer_joined 就先收到 offer，安全處理：建立 peer
    addPeer({ peerId: from, name: 'Guide', color: '#888' });
  }
  const peer = state.peers.get(from);
  if (!peer) return;

  if (signal.type === 'offer') {
    await ensureMic();
    const pc = ensurePC(from);
    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.socket.emit('signal', {
      target: from,
      signal: { type: answer.type, sdp: answer.sdp },
    });
  } else if (signal.type === 'answer') {
    const pc = peer.pc;
    if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
  } else if (signal.type === 'ice') {
    const pc = peer.pc;
    if (pc && signal.candidate) {
      try { await pc.addIceCandidate(signal.candidate); }
      catch (e) { console.warn('addIceCandidate', e); }
    }
  }
}

// ─── PTT / 常開麥 ──────────────────────────────────
const pttBtn = $('btn-ptt');
const modeBtn = $('btn-mode');

function setHotMic(on) {
  state.hotMic = !!on;
  modeBtn.classList.toggle('active', state.hotMic);
  modeBtn.textContent = state.hotMic ? '🔊' : '🎙️';
  $('ptt-label').textContent = state.hotMic ? '🔊 麥克風常開中' : '🎙️ 按住講話';
  if (state.micReady) setMicEnabled(state.hotMic || state.pttHolding);
  state.socket?.emit('ptt', { on: state.hotMic });
}

modeBtn.addEventListener('click', async () => {
  await ensureMic().catch(() => {});
  setHotMic(!state.hotMic);
});

// PTT 按住：pointer 事件涵蓋 touch + mouse
function pttDown(e) {
  e.preventDefault();
  if (!state.micReady) {
    ensureMic().catch(() => toast('麥克風權限被拒'));
    return;
  }
  if (state.hotMic) return; // 常開模式忽略 PTT 按住
  state.pttHolding = true;
  setMicEnabled(true);
  pttBtn.classList.add('holding');
  $('ptt-label').textContent = '🔴 通話中…';
  state.socket?.emit('ptt', { on: true });
}
function pttUp() {
  if (!state.pttHolding) return;
  state.pttHolding = false;
  if (!state.hotMic) setMicEnabled(false);
  pttBtn.classList.remove('holding');
  $('ptt-label').textContent = state.hotMic ? '🔊 麥克風常開中' : '🎙️ 按住講話';
  state.socket?.emit('ptt', { on: state.hotMic });
}
pttBtn.addEventListener('pointerdown', pttDown);
pttBtn.addEventListener('pointerup', pttUp);
pttBtn.addEventListener('pointercancel', pttUp);
pttBtn.addEventListener('pointerleave', pttUp);

// ─── 邀請對話框 ──────────────────────────────────
const inviteModal = $('invite-modal');
function showInvite() {
  if (!state.roomCode) return;
  $('invite-code-text').textContent = state.roomCode;
  const url = `${SHARE_BASE}/r/${state.roomCode}`;
  $('invite-url-text').textContent = url;
  inviteModal.classList.add('show');
}
function hideInvite() { inviteModal.classList.remove('show'); }

$('btn-invite').addEventListener('click', showInvite);
$('btn-close-invite').addEventListener('click', hideInvite);
$('btn-copy-url').addEventListener('click', async () => {
  const url = `${SHARE_BASE}/r/${state.roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('已複製連結');
  } catch {
    toast('複製失敗，請手動複製');
  }
});
$('btn-share').addEventListener('click', async () => {
  const url = `${SHARE_BASE}/r/${state.roomCode}`;
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'GuideTalk 房間邀請',
        text: `加入我的 GuideTalk 房間 ${state.roomCode}`,
        url,
      });
    } catch {}
  } else {
    // 沒原生分享就退到複製
    try { await navigator.clipboard.writeText(url); toast('已複製連結，貼到 LINE 即可'); } catch {}
  }
});

// ─── 首頁按鈕 ─────────────────────────────────────
$('btn-create').addEventListener('click', createRoom);
$('btn-join').addEventListener('click', () => {
  const code = $('code-input').value.trim().toUpperCase();
  joinRoom(code);
});
$('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});

// ─── 房間頂部按鈕 ─────────────────────────────────
$('btn-leave').addEventListener('click', () => {
  if (confirm('離開房間？')) leaveRoom();
});
$('btn-recenter').addEventListener('click', () => {
  if (state.myLastLoc && state.map) {
    state.map.setView([state.myLastLoc.lat, state.myLastLoc.lng], 16);
  } else {
    fitMapBounds();
  }
});

// ─── 進入時：檢查 URL 是否帶房號 ────────────────────
(function bootstrap() {
  const m = location.pathname.match(/^\/r\/([A-Z0-9]+)/i);
  if (m) {
    $('code-input').value = m[1].toUpperCase();
  }
  // Service Worker（PWA）
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
  }
})();
