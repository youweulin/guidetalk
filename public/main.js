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
  myLang: localStorage.getItem('gt_lang') || 'zh-TW',
  myPeerId: null,
  myColor: null,
  roomCode: null,

  // peers: Map<peerId, { name, color, loc?, pc?, audio?, marker?, chip?, pttOn? }>
  peers: new Map(),

  localStream: null,
  micReady: false,
  hotMic: false,            // false = PTT, true = 常開麥
  hotMicMuted: false,       // 常開麥模式下是否暫時靜音
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
const langSelect = $('lang-select');
if (langSelect) {
  langSelect.value = state.myLang;
  langSelect.addEventListener('change', () => {
    state.myLang = langSelect.value;
    localStorage.setItem('gt_lang', state.myLang);
  });
}

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
  state.socket.on('chat', ({ peerId, name, color, text, ts }) => {
    if (peerId === state.myPeerId) return;  // 不顯示自己的回音
    const p = state.peers.get(peerId);
    if (p) p.lastSpoke = { text, ts: ts || Date.now() };
    pushSubtitle({ peerId, name, color, text });
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

  // UI 初始化
  refreshTabsUI();
  refreshPttUI();
  // 進房自動展開距離表 — 立刻看到誰在哪
  setTimeout(() => {
    if (state.roomCode) showSheet();
  }, 500);
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

  // CartoDB Voyager — 風格最接近 Google Maps（公路顏色 + POI），免 key 免費
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '© OSM · © CARTO',
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
  p.marker.bindPopup(`<b>${escapeHtml(p.name)}</b>`);
  refreshPeerPopup(peerId, p);
  p.marker.on('popupopen', (e) => {
    const cur = state.peers.get(peerId);
    if (!cur) return;
    refreshPeerPopup(peerId, cur);  // 開啟瞬間刷一下最新數字
    const node = e.popup.getElement();
    node?.querySelector('[data-act="open-maps"]')?.addEventListener('click', () => {
      openInNativeMaps(cur.loc.lat, cur.loc.lng, cur.name);
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
  // 直線距離（即時、永遠有）
  const straight = haversine(
    state.myLastLoc.lat, state.myLastLoc.lng,
    p.loc.lat, p.loc.lng,
  );
  // 開車 ETA（OSRM 拿到才顯示）
  if (p.eta && p.eta.durationSec != null) {
    distEl.textContent = `🚗 ${formatDuration(p.eta.durationSec)} · ${formatDistance(p.eta.drivingMeters)}`;
  } else {
    distEl.textContent = `↔ ${formatDistance(straight)}`;
  }
  // 也更新 popup 內容
  refreshPeerPopup(peerId, p);
  // 嘗試刷新 ETA（內部會節流）
  maybeRefreshEta(peerId, p);
}

function refreshAllDistances() {
  for (const [peerId, p] of state.peers) updatePeerDistance(peerId, p);
}

// ─── ETA via OSRM（router.project-osrm.org，免費、免 key）───
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
const ETA_TTL_MS         = 30_000; // 30 秒沒動就重抓
const ETA_MOVE_THRESHOLD = 100;    // 任一端移動 >100m 就重抓
const ETA_MIN_GAP_MS     = 5_000;  // 同一 peer 兩次呼叫至少間隔 5 秒

function shouldRefreshEta(peer) {
  if (!peer.loc || !state.myLastLoc) return false;
  if (peer.etaInFlight) return false;
  if (!peer.eta) return true;
  const e = peer.eta;
  const now = Date.now();
  if (now - e.fetchedAt < ETA_MIN_GAP_MS) return false;
  if (now - e.fetchedAt > ETA_TTL_MS) return true;
  if (e.peerLoc && haversine(e.peerLoc.lat, e.peerLoc.lng, peer.loc.lat, peer.loc.lng) > ETA_MOVE_THRESHOLD) return true;
  if (e.selfLoc && haversine(e.selfLoc.lat, e.selfLoc.lng, state.myLastLoc.lat, state.myLastLoc.lng) > ETA_MOVE_THRESHOLD) return true;
  return false;
}

async function fetchOsrm(lat1, lng1, lat2, lng2) {
  const url = `${OSRM_BASE}/${lng1},${lat1};${lng2},${lat2}?overview=false&alternatives=false&steps=false`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.code !== 'Ok' || !d.routes?.[0]) return null;
    return {
      drivingMeters: Math.round(d.routes[0].distance),
      durationSec:   Math.round(d.routes[0].duration),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function maybeRefreshEta(peerId, peer) {
  if (!shouldRefreshEta(peer)) return;
  peer.etaInFlight = true;
  const myLoc = state.myLastLoc;
  const peerLoc = peer.loc;
  const result = await fetchOsrm(myLoc.lat, myLoc.lng, peerLoc.lat, peerLoc.lng);
  peer.etaInFlight = false;
  if (!result) return;
  // peer 可能已離線；保險檢查
  if (!state.peers.has(peerId)) return;
  peer.eta = {
    drivingMeters: result.drivingMeters,
    durationSec:   result.durationSec,
    fetchedAt:     Date.now(),
    peerLoc:       { lat: peerLoc.lat, lng: peerLoc.lng },
    selfLoc:       { lat: myLoc.lat,   lng: myLoc.lng },
  };
  // 更新 chip 顯示
  if (peer.chip) {
    const distEl = peer.chip.querySelector('.dist');
    if (distEl) distEl.textContent = `🚗 ${formatDuration(peer.eta.durationSec)} · ${formatDistance(peer.eta.drivingMeters)}`;
  }
  refreshPeerPopup(peerId, peer);
}

function formatDuration(sec) {
  if (sec < 60)   return '<1分';
  if (sec < 3600) return `${Math.round(sec / 60)}分`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${m}分`;
}

function refreshPeerPopup(peerId, p) {
  if (!p.marker || !p.loc) return;
  const straight = state.myLastLoc
    ? haversine(state.myLastLoc.lat, state.myLastLoc.lng, p.loc.lat, p.loc.lng)
    : null;
  const etaLine = p.eta
    ? `<div style="margin-top:4px;color:#0a7d3e;font-weight:600;">
         🚗 開車約 ${formatDuration(p.eta.durationSec)}（${formatDistance(p.eta.drivingMeters)}）
       </div>`
    : `<div style="margin-top:4px;color:#6e6e73;font-size:12px;">⏳ 計算中…</div>`;
  const straightLine = straight != null
    ? `<div style="color:#6e6e73;font-size:12px;">↔ 直線 ${formatDistance(straight)}</div>`
    : '';
  const speedLine = (p.loc.speed != null && p.loc.speed > 0.5)
    ? `<div style="color:#6e6e73;font-size:12px;">🏎 ${(p.loc.speed * 3.6).toFixed(0)} km/h</div>`
    : '';
  const ageLine = p.loc.ts
    ? `<div style="color:#6e6e73;font-size:12px;">📡 ${formatLocAge(p.loc.ts)}</div>`
    : '';
  const html = `
    <b>${escapeHtml(p.name)}</b>
    ${etaLine}
    ${straightLine}
    ${speedLine}
    ${ageLine}
    <div style="margin-top:8px;display:flex;gap:6px;">
      <button class="btn" data-act="open-maps"
              style="padding:8px 12px;font-size:13px;min-height:36px;border-radius:8px;">
        在地圖開啟
      </button>
    </div>
  `;
  p.marker.setPopupContent(html);
}

function formatLocAge(ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 10) return '剛剛';
  if (sec < 60) return `${sec} 秒前`;
  return `${Math.round(sec / 60)} 分鐘前`;
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
  // 預設靜音（PTT 模式 / 常開但靜音）
  setMicEnabled(state.hotMic && !state.hotMicMuted);
  refreshPttUI();
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

// ─── 即時字幕（Web Speech API）────────────────────
//
// 各客戶端各自跑 STT，把識別文字 emit 給 server 廣播。
// iOS Capacitor WKWebView 不支援 Web Speech，會自動 silent skip。
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const sttSupported = !!SpeechRec;
let sttInstance = null;
let sttRunning = false;
let sttManualStop = false;

function startSTT() {
  if (!sttSupported) return;
  if (sttRunning) return;
  try {
    sttInstance = new SpeechRec();
    sttInstance.lang = state.myLang || 'zh-TW';
    sttInstance.continuous = true;
    sttInstance.interimResults = false;
    sttInstance.maxAlternatives = 1;

    sttInstance.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) {
          const text = (r[0]?.transcript || '').trim();
          if (text && text.length >= 2) {
            state.socket?.emit('chat', { text });
            // 自己的也放本地 subtitle stack（給自己看到）
            pushSubtitle({
              peerId: state.myPeerId,
              name: state.myName + '（你）',
              color: state.myColor || '#0a7d3e',
              text,
              isSelf: true,
            });
          }
        }
      }
    };
    sttInstance.onerror = (e) => {
      console.warn('[stt] error', e.error);
      // not-allowed / no-speech / aborted → 不重試
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        sttManualStop = true;
      }
    };
    sttInstance.onend = () => {
      sttRunning = false;
      if (sttManualStop) return;
      // 持續模式偶爾自動斷，沒手動停就重啟
      if (state.hotMic || state.pttHolding) {
        try { sttInstance.start(); sttRunning = true; } catch {}
      }
    };

    sttManualStop = false;
    sttInstance.start();
    sttRunning = true;
  } catch (err) {
    console.warn('[stt] failed to start', err);
  }
}

function stopSTT() {
  sttManualStop = true;
  if (sttInstance && sttRunning) {
    try { sttInstance.stop(); } catch {}
  }
  sttRunning = false;
}

// ─── 浮動字幕渲染 ──────────────────────────────────
const subtitleStack = $('subtitle-stack');
const SUBTITLE_TTL_MS = 8000;
const SUBTITLE_MAX = 4;

function pushSubtitle({ peerId, name, color, text, isSelf = false }) {
  if (!subtitleStack || !text) return;
  const bubble = document.createElement('div');
  bubble.className = 'subtitle-bubble';
  bubble.style.borderLeftColor = color || '#fff';
  bubble.dataset.peerId = peerId || '';
  bubble.innerHTML = `
    <div class="who" style="color:${color || '#fff'}">
      ${escapeHtml(name)}${isSelf ? '' : ''}
    </div>
    ${escapeHtml(text)}
  `;
  subtitleStack.appendChild(bubble);
  // 限制最多顯示 N 個
  while (subtitleStack.children.length > SUBTITLE_MAX) {
    subtitleStack.firstChild.remove();
  }
  setTimeout(() => {
    bubble.classList.add('fade');
    setTimeout(() => bubble.remove(), 800);
  }, SUBTITLE_TTL_MS);
}

// ─── PTT / 常開麥 ──────────────────────────────────
const pttBtn = $('btn-ptt');
const tabPtt = $('tab-ptt');
const tabHot = $('tab-hot');
const pttLabel = () => $('ptt-label');

// 大按鈕的視覺狀態完全由這個 function 決定
function refreshPttUI() {
  const cls = pttBtn.classList;
  cls.remove('holding', 'live', 'muted', 'disabled');

  if (!state.micReady) {
    cls.add('disabled');
    pttLabel().textContent = '🎙️ 點擊允許麥克風';
    return;
  }

  if (state.hotMic) {
    // 常開麥模式
    if (state.hotMicMuted) {
      cls.add('muted');
      pttLabel().textContent = '🔇 已靜音・點擊開啟';
    } else {
      cls.add('live');
      pttLabel().textContent = '🔴 直播中・點擊靜音';
    }
  } else {
    // PTT 對講機模式
    if (state.pttHolding) {
      cls.add('holding');
      pttLabel().textContent = '🔴 通話中…';
    } else {
      pttLabel().textContent = '🎙️ 按住講話';
    }
  }
}

function refreshTabsUI() {
  tabPtt.classList.toggle('active', !state.hotMic);
  tabHot.classList.toggle('active', state.hotMic);
}

async function setMode(mode) {
  await ensureMic().catch(() => {});
  if (mode === 'hot') {
    state.hotMic = true;
    state.hotMicMuted = false;     // 切到常開預設取消靜音 = 直播
    if (state.micReady) setMicEnabled(true);
    state.socket?.emit('ptt', { on: true });
    startSTT();
  } else {
    state.hotMic = false;
    state.hotMicMuted = false;
    state.pttHolding = false;
    if (state.micReady) setMicEnabled(false);
    state.socket?.emit('ptt', { on: false });
    stopSTT();
  }
  refreshTabsUI();
  refreshPttUI();
}

tabPtt.addEventListener('click', () => setMode('ptt'));
tabHot.addEventListener('click', () => setMode('hot'));

// 大按鈕：行為依模式而定
function pttDown(e) {
  e.preventDefault();
  if (!state.micReady) {
    ensureMic().then(() => refreshPttUI()).catch(() => toast('麥克風權限被拒'));
    return;
  }
  // 常開麥模式 → 按下不做事（在 click 時切靜音）
  if (state.hotMic) return;
  // PTT 模式 → 按住開麥
  state.pttHolding = true;
  setMicEnabled(true);
  state.socket?.emit('ptt', { on: true });
  startSTT();
  refreshPttUI();
}
function pttUp() {
  if (state.hotMic) return;
  if (!state.pttHolding) return;
  state.pttHolding = false;
  setMicEnabled(false);
  state.socket?.emit('ptt', { on: false });
  stopSTT();
  refreshPttUI();
}
function pttClick() {
  // 常開麥模式才有 click 行為（切靜音）
  if (!state.hotMic) return;
  if (!state.micReady) {
    ensureMic().then(() => refreshPttUI()).catch(() => toast('麥克風權限被拒'));
    return;
  }
  state.hotMicMuted = !state.hotMicMuted;
  setMicEnabled(!state.hotMicMuted);
  state.socket?.emit('ptt', { on: !state.hotMicMuted });
  if (state.hotMicMuted) stopSTT();
  else startSTT();
  refreshPttUI();
}
pttBtn.addEventListener('pointerdown', pttDown);
pttBtn.addEventListener('pointerup', pttUp);
pttBtn.addEventListener('pointercancel', pttUp);
pttBtn.addEventListener('pointerleave', pttUp);
pttBtn.addEventListener('click', pttClick);

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

// ─── 打字快送 ────────────────────────────────────
const quicksendEl = $('quicksend');
const qsInput = $('qs-input');

function showQuickSend() {
  // 跟距離表互斥
  if (sheetEl?.classList.contains('show')) hideSheet();
  quicksendEl.classList.add('show');
  setTimeout(() => qsInput.focus(), 250);
}
function hideQuickSend() {
  quicksendEl.classList.remove('show');
  qsInput.blur();
}
function sendChatText(text) {
  const t = String(text || '').trim();
  if (!t) return;
  if (!state.socket?.connected) { toast('未連線'); return; }
  state.socket.emit('chat', { text: t });
  // 自己也看到
  pushSubtitle({
    peerId: state.myPeerId,
    name: state.myName + '（你）',
    color: state.myColor || '#0a7d3e',
    text: t, isSelf: true,
  });
}

$('btn-chat').addEventListener('click', () => {
  if (quicksendEl.classList.contains('show')) hideQuickSend();
  else showQuickSend();
});
$('btn-close-chat').addEventListener('click', hideQuickSend);
$('qs-send').addEventListener('click', () => {
  sendChatText(qsInput.value);
  qsInput.value = '';
});
qsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendChatText(qsInput.value);
    qsInput.value = '';
  }
});
// 一鍵預設句
document.querySelectorAll('.qs-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    sendChatText(btn.textContent.trim());
    hideQuickSend();
  });
});

// ─── 距離表面板 ──────────────────────────────────
const sheetEl = $('sheet');
const sheetMask = $('sheet-mask');
const sheetList = $('sheet-list');
let sheetTimer = null;

function showSheet() {
  renderSheet();
  sheetEl.classList.add('show');
  sheetMask.classList.add('show');
  // 開啟期間每秒刷新（時速、回報時間在跑）
  clearInterval(sheetTimer);
  sheetTimer = setInterval(renderSheet, 1000);
}
function hideSheet() {
  sheetEl.classList.remove('show');
  sheetMask.classList.remove('show');
  clearInterval(sheetTimer);
  sheetTimer = null;
}
$('btn-list').addEventListener('click', () => {
  if (sheetEl.classList.contains('show')) hideSheet();
  else showSheet();
});
$('btn-close-sheet').addEventListener('click', hideSheet);
sheetMask.addEventListener('click', hideSheet);

function renderSheet() {
  if (!sheetEl.classList.contains('show')) return;

  // 收集所有人（含自己）→ 排序：先自己、其他人按 ETA 由近到遠
  const rows = [];

  // 自己
  rows.push({
    self: true,
    peerId: state.myPeerId,
    name: (state.myName || '我') + '（你）',
    color: state.myColor || '#0a7d3e',
    loc: state.myLastLoc,
    eta: null,
  });

  // 其他人
  const others = [...state.peers.entries()].map(([peerId, p]) => ({
    self: false, peerId, name: p.name, color: p.color,
    loc: p.loc, eta: p.eta,
  }));
  // ETA 有值的優先排，再來直線距離由近到遠
  others.sort((a, b) => {
    const ea = a.eta?.durationSec ?? Infinity;
    const eb = b.eta?.durationSec ?? Infinity;
    if (ea !== eb) return ea - eb;
    const da = a.loc && state.myLastLoc
      ? haversine(state.myLastLoc.lat, state.myLastLoc.lng, a.loc.lat, a.loc.lng) : Infinity;
    const db = b.loc && state.myLastLoc
      ? haversine(state.myLastLoc.lat, state.myLastLoc.lng, b.loc.lat, b.loc.lng) : Infinity;
    return da - db;
  });
  rows.push(...others);

  if (rows.length <= 1) {
    sheetList.innerHTML = `<div class="sheet-empty">還沒有夥伴加入<br>點 🔗 邀請吧</div>`;
    return;
  }

  sheetList.innerHTML = rows.map(r => renderRow(r)).join('');
  // 點 row → 飛到那個位置
  sheetList.querySelectorAll('.peer-row').forEach(node => {
    node.addEventListener('click', () => {
      const id = node.dataset.peerId;
      if (id === state.myPeerId) {
        if (state.myLastLoc) state.map.setView([state.myLastLoc.lat, state.myLastLoc.lng], 16);
      } else {
        const p = state.peers.get(id);
        if (p?.loc) {
          state.map.setView([p.loc.lat, p.loc.lng], 16);
          p.marker?.openPopup?.();
        }
      }
      hideSheet();
    });
  });
}

function renderRow(r) {
  const initial = (r.name || '?').charAt(0).toUpperCase();

  // 距離 / ETA 數字
  let bigText = '—';
  let subText = '';
  if (r.self) {
    bigText = '你';
    subText = r.loc ? '已定位' : '定位中';
  } else if (r.eta) {
    bigText = formatDuration(r.eta.durationSec);
    subText = `🚗 ${formatDistance(r.eta.drivingMeters)}`;
  } else if (r.loc && state.myLastLoc) {
    const d = haversine(state.myLastLoc.lat, state.myLastLoc.lng, r.loc.lat, r.loc.lng);
    bigText = formatDistance(d);
    subText = '↔ 直線';
  } else {
    bigText = '—';
    subText = '無位置';
  }

  // meta：速度 + 回報時間
  const meta = [];
  if (r.loc?.speed != null && r.loc.speed > 0.5) {
    meta.push(`🏎 ${(r.loc.speed * 3.6).toFixed(0)} km/h`);
  }
  if (r.loc?.ts) {
    meta.push(`📡 ${formatLocAge(r.loc.ts)}`);
  }
  if (r.eta && r.loc && state.myLastLoc) {
    const straight = haversine(state.myLastLoc.lat, state.myLastLoc.lng, r.loc.lat, r.loc.lng);
    meta.push(`↔ ${formatDistance(straight)}`);
  }

  // 最近一句話（30 秒內）
  let chatBlock = '';
  if (!r.self) {
    const peer = state.peers.get(r.peerId);
    const ls = peer?.lastSpoke;
    if (ls && ls.text && (Date.now() - ls.ts) < 30000) {
      chatBlock = `<div class="pchat">💬 ${escapeHtml(ls.text)}</div>`;
    }
  }

  return `
    <div class="peer-row ${r.self ? 'self' : ''}" data-peer-id="${escapeHtml(r.peerId)}">
      <div class="pdot" style="background:${r.color}">${escapeHtml(initial)}</div>
      <div>
        <div class="pname">${escapeHtml(r.name)}</div>
        <div class="pmeta">${meta.join(' ')}</div>
      </div>
      <div class="peta">
        <div class="big">${escapeHtml(bigText)}</div>
        <div class="sub">${escapeHtml(subText)}</div>
      </div>
      ${chatBlock}
    </div>
  `;
}

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
