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
  chatHistory: [],   // 訊息歷史（含自己的）

  // 導覽機模式相關
  isHost: false,            // 我是不是主講
  roomMode: 'normal',       // 'normal' | 'tour-text' | 'tour-voice'（建房時固定）
  hostPeerId: null,         // 主講線上 peerId（離線為 null）
  ttsEnabled: localStorage.getItem('gt_tts') !== '0',  // 聽眾 TTS 預設開

  localStream: null,
  micReady: false,
  hotMic: true,             // 預設常開麥（一進房就直接通話，不用按）
  hotMicMuted: false,       // 麥克風是否靜音（不傳出去）
  speakerMuted: false,      // 喇叭是否靜音（聽不到別人）
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

// ─── 最近房間 ────────────────────────────────────
const RECENT_ROOMS_KEY = 'gt_recent_rooms';
const RECENT_ROOMS_MAX = 5;

function loadRecentRooms() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_ROOMS_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveRecentRooms(arr) {
  localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(arr.slice(0, RECENT_ROOMS_MAX)));
}
function rememberRoom(code) {
  if (!code) return;
  const arr = loadRecentRooms().filter(r => r.code !== code);
  arr.unshift({ code, ts: Date.now() });
  saveRecentRooms(arr);
}

// host token：建房者持有可重連認回
function loadHostToken(code) {
  return localStorage.getItem('gt_host_' + code) || null;
}
function saveHostToken(code, token) {
  if (!code || !token) return;
  localStorage.setItem('gt_host_' + code, token);
}
function forgetRoom(code) {
  saveRecentRooms(loadRecentRooms().filter(r => r.code !== code));
  renderRecentRooms();
}
function renderRecentRooms() {
  const wrap = $('recent-rooms-wrap');
  const list = $('recent-rooms');
  if (!wrap || !list) return;
  const rooms = loadRecentRooms();
  if (rooms.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  list.innerHTML = '';
  for (const r of rooms) {
    const btn = document.createElement('button');
    btn.className = 'recent-room';
    btn.innerHTML = `
      <div>
        <div class="rcode">${r.code}</div>
        <div class="rmeta">${formatRelTime(r.ts)}</div>
      </div>
      <button class="rdel" title="移除">✕</button>
    `;
    btn.addEventListener('click', (e) => {
      // 點 ✕ 不要觸發回房
      if (e.target.classList.contains('rdel')) {
        e.stopPropagation();
        forgetRoom(r.code);
        return;
      }
      const name = $('name-input').value.trim();
      if (!name) {
        toast('請先輸入暱稱');
        $('name-input').focus();
        return;
      }
      joinRoom(r.code);
    });
    list.appendChild(btn);
  }
}
function formatRelTime(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  const d = Math.floor(sec / 86400);
  return `${d} 天前`;
}
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
  state.socket.on('host_changed', ({ peerId }) => {
    state.hostPeerId = peerId;
    refreshModeUI();
  });
  state.socket.on('host_left', () => {
    state.hostPeerId = null;
    refreshModeUI();
    if (state.roomMode !== 'normal') toast('主講人離線了，等候回來…');
  });
  state.socket.on('peer_location', (loc) => {
    updatePeerLocation(loc.peerId, loc);
  });
  state.socket.on('chat', (msg) => {
    const { peerId, name, color, text, ts } = msg;
    state.chatHistory.push(msg);
    if (state.chatHistory.length > 100) state.chatHistory.shift();
    appendChatMessage(msg);
    const prefix = msg.isHost ? '🎤 ' : '';
    const tag = msg.source === 'voice' ? ' 🔊' : '';
    pushSubtitle({
      peerId,
      name: prefix + (peerId === state.myPeerId ? `${name}（你）` : name) + tag,
      color, text, isSelf: peerId === state.myPeerId,
    });
    if (peerId !== state.myPeerId) {
      const p = state.peers.get(peerId);
      if (p) p.lastSpoke = { text, ts: ts || Date.now() };
    }
  });
  state.socket.on('peer_ptt', ({ peerId, on }) => {
    const p = state.peers.get(peerId);
    if (!p) return;
    p.pttOn = on;
    if (p.chip) p.chip.classList.toggle('ptt-on', !!on);
    
    // 如果是導遊(host)切換麥克風狀態，要在畫面上提示
    if (peerId === state.hostPeerId) {
      pushSubtitle({
        peerId: 'system',
        name: '系統提示',
        color: 'var(--text-dim)',
        text: on ? '🎙️ 導遊已開啟麥克風' : '🔇 導遊已暫停麥克風'
      });
    }
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

  // 從首頁的 radio 取建房模式
  const modeInput = document.querySelector('input[name="create-mode"]:checked');
  const mode = modeInput ? modeInput.value : 'normal';

  connectSocket();
  setStatus('建立房間中…');

  try {
    if (!state.socket.connected) await new Promise(r => state.socket.once('connect', r));
    const resp = await emitAck('create_room', { name, mode });
    if (resp.hostToken) saveHostToken(resp.roomCode, resp.hostToken);
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
    const hostToken = loadHostToken(code);  // 之前建過此房就帶上認回
    const resp = await emitAck('join_room', { code, name, hostToken });
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
  state.isHost      = !!resp.isHost;
  state.roomMode    = resp.mode || 'normal';
  state.hostPeerId  = resp.hostPeerId || null;

  rememberRoom(resp.roomCode);

  $('room-code-display').textContent = resp.roomCode;
  showScreen('room');
  
  const isListenerView = !isNative && !state.isHost && state.roomMode === 'tour';
  if (isListenerView) {
    $('listener-view').classList.add('active');
    $('map').style.display = 'none';
    $('peer-strip').style.display = 'none';
    $('btn-list').style.display = 'none';
    $('btn-recenter').style.display = 'none';
    $('btn-ptt').style.display = 'none';
    $('btn-chat').style.display = 'none';
    $('btn-invite').style.display = 'none';
  } else {
    $('listener-view').classList.remove('active');
    $('map').style.display = 'block';
    $('peer-strip').style.display = 'flex';
    $('btn-list').style.display = 'flex';
    $('btn-recenter').style.display = 'flex';
    $('btn-ptt').style.display = 'flex';
    $('btn-chat').style.display = 'flex';
    $('btn-invite').style.display = 'flex';
    ensureMap();
  }

  refreshModeUI();
  // URL 改回根路徑，避免重整再觸發 auto-join
  if (location.pathname.startsWith('/r/')) {
    history.replaceState(null, '', '/');
  }

  // 已存在的 peers（如果是 join）
  if (resp.peers) {
    for (const p of resp.peers) {
      if (p.peerId === state.myPeerId) continue;
      addPeer(p);
      if (p.loc) updatePeerLocation(p.peerId, p.loc);
    }
  }
  // 訊息歷史（join 時 server 回傳）
  if (resp.chat && Array.isArray(resp.chat)) {
    state.chatHistory = resp.chat.slice(-100);
    renderChatHistory();
  }
  refreshRoomMeta();

  // 取得麥克風（之後用於 PTT / 常開），同時建 mesh 連線
  await ensureMic().catch(err => {
    console.warn('mic failed', err);
    setStatus('麥克風無法取得，可繼續看位置但無法通話', true);
  });

  // 預設常開麥：拿到麥克風後立刻進入直播狀態（不用按住）
  if (state.micReady && state.hotMic) {
    setMicEnabled(!state.hotMicMuted);
    state.socket?.emit('ptt', { on: !state.hotMicMuted });
    if (!state.hotMicMuted) startSTT();
  }

  // 我作為「新加入者」→ 對「該連線的」既存 peer 發起 offer
  for (const peerId of state.peers.keys()) {
    if (!shouldConnectToPeer(peerId)) continue;
    initiateOffer(peerId).catch(err => console.warn('offer failed', peerId, err));
  }

  // 開始追蹤位置（如果是極簡網頁聽眾，則不抓定位以省電）
  if (!isListenerView) {
    startGeoWatch();
  }

  // UI 初始化
  refreshTabsUI();
  refreshPttUI();
  // 進房自動展開距離表 — 立刻看到誰在哪（聽眾模式不用展開）
  setTimeout(() => {
    if (state.roomCode && !isListenerView) showSheet();
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
  // 先試完整 constraint，被拒就退到 audio:true（Chrome 偶爾對 echoCancellation 等回 NotFoundError）
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (e1) {
    console.warn('[mic] full-constraint fail:', e1.name, '— retry audio:true');
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  state.localStream = stream;
  state.micReady = true;
  setMicEnabled(state.hotMic && !state.hotMicMuted);
  refreshPttUI();
  applyTourModeMicRule();
  return stream;
}

function setMicEnabled(enabled) {
  if (!state.localStream) return;
  state.localStream.getAudioTracks().forEach(t => t.enabled = !!enabled);
}

// ─── WebRTC mesh ───────────────────────────────────
// 三模式連線拓樸：
//   normal      : 全 mesh，每兩人 P2P，雙向音訊
//   tour        : star，主講↔每聽眾，聽眾彼此沒連線
function shouldConnectToPeer(peerId) {
  if (state.roomMode === 'tour') {
    if (state.isHost) return true;          // 主講連所有人
    return peerId === state.hostPeerId;     // 聽眾只連主講
  }
  return true;  // normal mesh
}

function shouldUploadAudio() {
  // tour 任一模式下，非主講不上傳音訊（只有主講聲音被廣播）
  if (state.roomMode !== 'normal' && !state.isHost) return false;
  return true;
}

function createPC(peerId) {
  const pc = new RTCPeerConnection({ iceServers: state.ICE_SERVERS });

  if (shouldUploadAudio() && state.localStream) {
    for (const track of state.localStream.getTracks()) {
      pc.addTrack(track, state.localStream);
    }
  } else {
    // 聽眾在 tour 模式：只接收主講音訊
    try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch {}
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
      peer.audio.muted = state.speakerMuted;
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
  // tour mode 下，不該連的 peer 直接忽略訊令
  if (signal.type === 'offer' && !shouldConnectToPeer(from)) {
    console.log('[signal] reject offer from', from, '(topology)');
    return;
  }

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

// ─── TTS 朗讀（給導覽-文字模式的聽眾）────────────
const ttsSupported = 'speechSynthesis' in window;
console.log('[tts] supported:', ttsSupported);

// 預先觸發 voices 載入（Chrome 是異步的，第一次呼叫前會空陣列）
if (ttsSupported) {
  try { window.speechSynthesis.getVoices(); } catch {}
  if ('onvoiceschanged' in window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => {
      const voices = window.speechSynthesis.getVoices();
      console.log('[tts] voices loaded:', voices.length);
    };
  }
}

function speakText(text, lang) {
  if (!ttsSupported) {
    console.warn('[tts] not supported in this browser');
    return;
  }
  if (!text) return;
  try {
    // Chrome bug：如果上一句在 paused 狀態會卡死，先 resume
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || 'zh-TW';
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    u.onstart = () => console.log('[tts] ▶️', text);
    u.onerror = (e) => console.warn('[tts] ❌', e.error, text);
    u.onend = () => console.log('[tts] ✅ done');
    window.speechSynthesis.speak(u);
    console.log('[tts] queued:', text, '| pending=', window.speechSynthesis.pending,
                '| speaking=', window.speechSynthesis.speaking);
  } catch (err) {
    console.warn('[tts] speak failed', err);
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
            console.log('[stt] final:', text);
            state.socket?.emit('chat', { text, source: 'voice' });
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

  // 推送到大字幕區 (Listener View)
  const bigStack = $('big-subtitle-stack');
  const isListenerView = !isNative && !state.isHost && state.roomMode === 'tour';
  if (bigStack && isListenerView) {
    const emptyMsg = $('listener-empty');
    if (emptyMsg) emptyMsg.style.display = 'none';
    
    const bigBubble = document.createElement('div');
    bigBubble.className = 'big-subtitle';
    bigBubble.style.borderLeft = `4px solid ${color || 'var(--primary)'}`;
    bigBubble.innerHTML = `
      <div style="font-size:13px; font-weight:700; color:${color || 'var(--text-dim)'}; margin-bottom:6px; opacity:0.8;">
        ${escapeHtml(name)}
      </div>
      ${escapeHtml(text)}
    `;
    bigStack.appendChild(bigBubble);
    
    // 改為持續存在，並保留最近 50 句對話
    while (bigStack.children.length > 50) {
      bigStack.firstChild.remove();
    }
    const view = $('listener-view');
    if (view) view.scrollTop = view.scrollHeight;
  }
}

// ─── 麥克風 + 喇叭 兩顆獨立按鈕 ────────────────────
const pttBtn = $('btn-ptt');
const spkBtn = $('btn-speaker');
const pttLabel = () => $('ptt-label');
const spkLabel = () => $('spk-label');

function refreshPttUI() {
  const mc = pttBtn.classList;
  mc.remove('live', 'muted', 'disabled', 'holding');

  // 導覽機聽眾：麥克風鎖死
  if (state.roomMode !== 'normal' && !state.isHost) {
    mc.add('disabled');
    pttLabel().textContent = '🔇 主講中・你只能打字';
  } else if (!state.micReady) {
    mc.add('disabled');
    pttLabel().textContent = '🎙️ 點擊開麥';
  } else if (state.hotMicMuted) {
    mc.add('muted');
    pttLabel().textContent = '🔇 麥克風關';
  } else {
    mc.add('live');
    pttLabel().textContent = '🎙️ 通話中';
  }
  // 喇叭按鈕
  const sc = spkBtn.classList;
  sc.remove('live', 'muted');
  if (state.speakerMuted) {
    sc.add('muted');
    spkLabel().textContent = '🔇 喇叭關';
  } else {
    sc.add('live');
    spkLabel().textContent = '🔊 接收中';
  }
}

function refreshTabsUI() {}  // stub for legacy callers

function applySpeakerMute() {
  for (const [, p] of state.peers) {
    if (p.audio) p.audio.muted = state.speakerMuted;
  }
}

function pttClick() {
  // 導覽機聽眾：點麥克風 = 跳到打字面板
  if (state.roomMode !== 'normal' && !state.isHost) {
    toast('導覽機模式聽眾請打字傳訊');
    showQuickSend();
    return;
  }
  if (!state.micReady) {
    ensureMic().then(() => {
      state.hotMic = true;
      state.hotMicMuted = false;
      setMicEnabled(true);
      state.socket?.emit('ptt', { on: true });
      startSTT();
      refreshPttUI();
    }).catch(() => toast('麥克風權限被拒'));
    return;
  }
  state.hotMicMuted = !state.hotMicMuted;
  setMicEnabled(!state.hotMicMuted);
  state.socket?.emit('ptt', { on: !state.hotMicMuted });
  if (state.hotMicMuted) stopSTT();
  else startSTT();
  refreshPttUI();
}

function speakerClick() {
  state.speakerMuted = !state.speakerMuted;
  applySpeakerMute();
  refreshPttUI();
  toast(state.speakerMuted ? '已關閉喇叭（聽不到別人）' : '已開啟喇叭');
}

pttBtn.addEventListener('click', pttClick);
spkBtn.addEventListener('click', speakerClick);

// ─── 模式徽章 + 聽眾 mic 鎖死規則 ─────────────────
function refreshModeUI() {
  const badge = $('mode-badge');
  if (!badge) return;
  badge.classList.remove('tour');
  if (state.roomMode === 'tour') {
    badge.textContent = '🎤 導覽機模式';
    badge.classList.add('tour');
  } else {
    badge.textContent = '💬 對話模式';
  }
  // 房間 meta 角色
  const meta = $('room-meta');
  if (meta) {
    const total = state.peers.size + 1;
    let role = '';
    if (state.isHost) role = ' · 你是主講';
    else if (state.roomMode !== 'normal') {
      role = state.hostPeerId ? ' · 主講中' : ' · 等候主講';
    }
    meta.textContent = `${total} 人在線${role}`;
  }

  // 聽眾端大標題更新
  const hostNameEl = $('listener-host-name');
  if (hostNameEl) {
    if (state.hostPeerId) {
      const hostPeer = state.peers.get(state.hostPeerId);
      hostNameEl.textContent = `主講人：${hostPeer ? escapeHtml(hostPeer.name) : '導遊'}`;
    } else {
      hostNameEl.textContent = '等待主講人連線...';
    }
  }
}

// tour 模式聽眾：強制關麥、UI 鎖死、提示打字
function applyTourModeMicRule() {
  if (state.roomMode === 'normal') return;
  if (state.isHost) return;
  if (!state.micReady) return;
  state.hotMicMuted = true;
  setMicEnabled(false);
  state.socket?.emit('ptt', { on: false });
  stopSTT();
  refreshPttUI();
}

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

// 聽眾端：我迷路了（開啟 GPS）
const sosBtn = $('btn-listener-sos');
if (sosBtn) {
  sosBtn.addEventListener('click', () => {
    if (state.geoWatchHandle) {
      stopGeoWatch();
      sosBtn.textContent = '📍 我迷路了 (發送定位)';
      sosBtn.classList.remove('danger');
      sosBtn.classList.add('secondary');
      toast('已停止發送定位');
    } else {
      startGeoWatch();
      sosBtn.textContent = '🛑 停止發送定位';
      sosBtn.classList.remove('secondary');
      sosBtn.classList.add('danger');
      toast('定位發送中，導遊將看到你的位置');
    }
  });
}

// ─── 打字快送 + 訊息歷史 ──────────────────────────
const quicksendEl = $('quicksend');
const qsInput = $('qs-input');
const qsHistory = $('qs-history');

function showQuickSend() {
  // 跟距離表互斥
  if (sheetEl?.classList.contains('show')) hideSheet();
  renderChatHistory();
  quicksendEl.classList.add('show');
  $('quicksend-backdrop')?.classList.add('show');
  // 自動捲到底
  setTimeout(() => {
    qsHistory.scrollTop = qsHistory.scrollHeight;
    qsInput.focus();
  }, 280);
}
function hideQuickSend() {
  quicksendEl.classList.remove('show');
  $('quicksend-backdrop')?.classList.remove('show');
  qsInput.blur();
}
function sendChatText(text) {
  const t = String(text || '').trim();
  if (!t) return;
  if (!state.socket?.connected) { toast('未連線'); return; }
  // 不要本地 push（server 會 broadcast 給包含自己的所有人）
  state.socket.emit('chat', { text: t });
}

function renderChatHistory() {
  if (!qsHistory) return;
  qsHistory.innerHTML = '';
  for (const m of state.chatHistory) {
    qsHistory.appendChild(buildChatNode(m));
  }
  qsHistory.scrollTop = qsHistory.scrollHeight;
}

function appendChatMessage(m) {
  if (!qsHistory) return;
  const wasOpen = quicksendEl?.classList.contains('show');
  const node = buildChatNode(m);
  qsHistory.appendChild(node);
  // 限制 DOM 數量
  while (qsHistory.children.length > 100) qsHistory.firstChild.remove();
  if (wasOpen) qsHistory.scrollTop = qsHistory.scrollHeight;
}

function buildChatNode(m) {
  const div = document.createElement('div');
  const isSelf = m.peerId === state.myPeerId;
  div.className = 'chat-msg' + (isSelf ? ' self' : '');
  const who = document.createElement('div');
  who.className = 'who';
  who.style.color = m.color || (isSelf ? '#0a7d3e' : '#666');
  who.textContent = isSelf ? `${m.name}（你）` : m.name;
  const txt = document.createElement('div');
  txt.textContent = m.text;
  const when = document.createElement('div');
  when.className = 'when';
  when.textContent = formatChatTime(m.ts);
  div.appendChild(who);
  div.appendChild(txt);
  div.appendChild(when);
  return div;
}

function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

$('btn-chat').addEventListener('click', () => {
  if (quicksendEl.classList.contains('show')) hideQuickSend();
  else showQuickSend();
});
$('btn-close-chat').addEventListener('click', hideQuickSend);
$('quicksend-backdrop').addEventListener('click', hideQuickSend);
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
  // 渲染「最近房間」清單
  renderRecentRooms();

  const m = location.pathname.match(/^\/r\/([A-Z0-9]+)/i);
  if (m) {
    const code = m[1].toUpperCase();
    $('code-input').value = code;
    
    // 透過連結加入者，隱藏不必要的「建立房間」介面
    const createSec = $('create-room-section');
    if (createSec) createSec.style.display = 'none';
    const recentWrap = $('recent-rooms-wrap');
    if (recentWrap) recentWrap.style.display = 'none';

    // 已有暱稱 → 自動加入
    if (state.myName && state.myName.trim()) {
      setTimeout(() => {
        toast(`自動加入房號 ${code}…`);
        joinRoom(code);
      }, 200);
    } else {
      // 沒暱稱 → 提示並 focus 暱稱輸入框
      setTimeout(() => {
        toast(`房號 ${code} 已帶入，請輸入暱稱`);
        $('name-input').focus();
      }, 200);
    }
  }
  // Service Worker（PWA）
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
  }
})();
