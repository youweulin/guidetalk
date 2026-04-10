/**
 * kaitalk 客戶端 — Phase 0 + 音量視覺化
 *
 * 流程：
 *   1. 連 Socket.IO 訊令 server
 *   2. 點「開始配對」→ 取得麥克風 + 進佇列 + 開始本地 mic 音量分析
 *   3. server 配對成功 → 顯示對方暱稱 + 房號
 *   4. host 建 RTCPeerConnection、加 audio track、createOffer → 透過 server 轉發
 *   5. guest 收 offer → setRemoteDescription → createAnswer → 轉發回去
 *   6. ICE candidates 雙向轉發
 *   7. P2P 連通後：對方的 audio track 接到 <audio> 播放 + Web Audio Analyser 顯示音量
 *
 * 同一台電腦測試訣竅：
 *   - 兩個分頁都按「靜音喇叭」
 *   - 對著一個分頁講話，另一個分頁的「對方聲音」meter 會跳動
 *   - 證明 P2P 真的連通且音訊有在流，但耳朵不會 echo
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ─── DOM ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const logEl = $('log');
const btnStart = $('btn-start');
const btnCancel = $('btn-cancel');
const btnHangup = $('btn-hangup');
const btnMute = $('btn-mute');
const btnSubtitle = $('btn-subtitle');
const nameInput = $('name');
const userDisplayEl = $('user-display');
const remoteAudio = $('remote-audio');

const peerCard = $('peer-card');
const peerNameEl = $('peer-name');
const roomCodeEl = $('room-code');
const myRoleEl = $('my-role');
const peerLangBadgeEl = $('peer-lang-badge');

const metersEl = $('meters');
const localMeter = $('local-meter');
const remoteMeter = $('remote-meter');
const localLevelEl = $('local-level');
const remoteLevelEl = $('remote-level');

const subtitlesEl = $('subtitles');
const langBarEl = $('lang-bar');
const subtitlesListEl = $('subtitles-list');
const langBtn = $('lang-btn');
const sttStatusEl = $('stt-status');

// ─── State ───────────────────────────────────────────
let socket = null;
let pc = null;
let localStream = null;
let peerId = null;
let peerUserId = null;          // Supabase uid（for block/report API）
let peerName = null;
let isHost = false;
let pendingCandidates = [];

// Match timeout (30s 沒配到提示換 quick mode)
let matchTimeoutId = null;
let lastMatchOpts = null; // 記住目前是哪個模式發起的，超時提示用

// Web Audio analyser state
let audioCtx = null;
let localAnalyser = null;
let remoteAnalyser = null;
let meterRafId = null;

// Subtitle / STT state
let subtitleDC = null;          // RTCDataChannel for subtitle messages
let recognition = null;         // SpeechRecognition instance
let sttActive = false;          // 是否正在跑 STT
let sttLang = detectInitialLang(); // 我講的語言（影響 STT + 對方知道我在講什麼）
let peerLang = null;            // 對方講的語言（從對方第一筆字幕學到）
let peerRegionStored = null;    // 對方的地區（match_found 取得）
let peerGenderStored = null;    // 對方的性別（match_found 取得）
let subtitlesEnabled = localStorage.getItem('kaitalk.subtitles') !== 'false'; // 用戶開關，預設開
const subtitleBuffer = [];      // event log: [{ id, speaker, text, lang, interim, ts }]
const MAX_BUFFER = 50;          // in-memory buffer 上限

// 支援的語言（之後加翻譯時，只要每個都能對應到翻譯 API 的 code 即可）
const LANGS = [
  { code: 'zh-TW', flag: '🇹🇼', label: '中文' },
  { code: 'ja-JP', flag: '🇯🇵', label: '日本語' },
  { code: 'en-US', flag: '🇺🇸', label: 'English' },
  { code: 'ko-KR', flag: '🇰🇷', label: '한국어' },
  { code: 'zh-CN', flag: '🇨🇳', label: '简中' },
];

function detectInitialLang() {
  // 1. localStorage 記住用戶上次的選擇
  const saved = localStorage.getItem('kaitalk.lang');
  if (saved) return saved;
  // 2. 從瀏覽器語言推測
  const nav = (navigator.language || 'zh-TW');
  if (nav.startsWith('zh-TW') || nav === 'zh-Hant') return 'zh-TW';
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('ja')) return 'ja-JP';
  if (nav.startsWith('ko')) return 'ko-KR';
  if (nav.startsWith('en')) return 'en-US';
  return 'zh-TW';
}

function langInfo(code) {
  return LANGS.find(l => l.code === code) || { code, flag: '🌐', label: code };
}

// ─── Translation Provider (Phase 2) ──────────────────
//
// 介面：translate(text, fromLang, toLang) → Promise<string>
//
// 多 provider 策略，依序嘗試：
//   1. Apple Translation     ← iOS 原生 App（透過 Capacitor plugin），最佳選擇
//   2. Chrome Built-in       ← Chrome 138+ 桌面/Android，裝置上 AI 模型，免費
//   3. Google Free endpoint  ← 任何瀏覽器，免費但 unofficial
//   4. MyMemory              ← 終極 fallback
//
// 新加 provider 就 push 進 PROVIDERS 即可，不用改其他地方。

class TranslationProvider {
  get name() { return this.constructor.name; }
  async isAvailable(from, to) { return false; }
  async translate(text, fromLang, toLang) { return text; }
}

// ─── Provider 1: Apple Translation（iOS 原生 App 才能用）───
//
// 需要的條件：
//   - kaitalk 必須打包成 Capacitor iOS App（不能只開 Safari 網頁）
//   - iOS 17.4+ 才有 Translation framework
//   - iOS 18+ 才有完整的 TranslationSession（裝置上 AI）
//   - 需要寫一個 Capacitor plugin 把原生 API 橋接到 JS
//
// Plugin 的 Swift code 大致長這樣（之後在 ios/App/App/Plugins/ 加）：
//
//   import Capacitor
//   import Translation
//
//   @objc(AppleTranslationPlugin)
//   public class AppleTranslationPlugin: CAPPlugin {
//     @objc func translate(_ call: CAPPluginCall) {
//       let text = call.getString("text") ?? ""
//       let from = call.getString("from") ?? "zh"
//       let to = call.getString("to") ?? "ja"
//       Task {
//         let session = TranslationSession(
//           configuration: .init(source: Locale.Language(identifier: from),
//                                target: Locale.Language(identifier: to)))
//         let response = try await session.translate(text)
//         call.resolve(["translated": response.targetText])
//       }
//     }
//   }
//
// JS 端就會有 window.Capacitor.Plugins.AppleTranslation.translate({...})
class AppleTranslationProvider extends TranslationProvider {
  static isInstalled() {
    return !!(window.Capacitor?.Plugins?.AppleTranslation);
  }
  async isAvailable(from, to) {
    return AppleTranslationProvider.isInstalled();
  }
  async translate(text, fromLang, toLang) {
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return text;
    const result = await window.Capacitor.Plugins.AppleTranslation.translate({
      text, from, to,
    });
    return result.translated;
  }
}

// ─── Provider 2: Chrome Built-in Translator API（NOW 可用）───
//
// Chrome 138+ 提供 window.Translator，裝置上跑 AI 模型：
//   - 完全免費、零延遲（不用網路）
//   - 隱私 100%（文字不離開瀏覽器）
//   - 第一次用某語言對會下載約 22MB 模型
//   - 支援 zh, ja, en, ko, fr, de, es, ... 等主要語言
//
// 你現在 Chrome 桌面版測試的話，這個會自動被選用！
class ChromeBuiltinTranslator extends TranslationProvider {
  constructor() {
    super();
    this.instances = new Map(); // 'from|to' → Translator instance
  }
  static isInstalled() {
    return typeof self !== 'undefined' && 'Translator' in self;
  }
  async isAvailable(fromLang, toLang) {
    if (!ChromeBuiltinTranslator.isInstalled()) return false;
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return true;
    try {
      const availability = await Translator.availability({
        sourceLanguage: from,
        targetLanguage: to,
      });
      return availability !== 'unavailable';
    } catch {
      return false;
    }
  }
  async getInstance(from, to) {
    const key = `${from}|${to}`;
    if (this.instances.has(key)) return this.instances.get(key);
    const inst = await Translator.create({
      sourceLanguage: from,
      targetLanguage: to,
    });
    this.instances.set(key, inst);
    return inst;
  }
  async translate(text, fromLang, toLang) {
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return text;
    const instance = await this.getInstance(from, to);
    return await instance.translate(text);
  }
}

// ─── Provider 3: Google 免費 endpoint ───
class GoogleFreeTranslator extends TranslationProvider {
  async isAvailable() { return true; }
  async translate(text, fromLang, toLang) {
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return text;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data[0].map(seg => seg[0]).join('');
  }
}

// ─── Provider 4: MyMemory（fallback）───
class MyMemoryTranslator extends TranslationProvider {
  async isAvailable() { return true; }
  async translate(text, fromLang, toLang) {
    const from = fromLang.split('-')[0];
    const to = toLang.split('-')[0];
    if (from === to) return text;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.responseData?.translatedText || text;
  }
}

// 順序就是優先順序：第一個能用的就用
const PROVIDERS = [
  new AppleTranslationProvider(),
  new ChromeBuiltinTranslator(),
  new GoogleFreeTranslator(),
  new MyMemoryTranslator(),
];

// ─── Persistent Translation Cache ────────────────────
//
// 為什麼要持久化：
//   - Google/MyMemory 都有 IP 每日上限
//   - 如果快取只活在記憶體，每次 refresh / 新對話都從零翻譯
//   - 把快取存到 localStorage → 跨對話/跨天累積
//   - 用戶用越久，自己的「常用語料庫」越完整，API 用量越來越低
//
// 隱私：完全只在用戶手機，server 永遠看不到
const TRANSLATION_CACHE_KEY = 'kaitalk.translationCache.v1';
const TRANSLATION_CACHE_LIMIT = 500;
const TRANSLATION_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天

function loadTranslationCache() {
  // 注意：這個 function 在 module top-level 就會跑（const translationCache = loadTranslationCache()），
  // 比 log() 還早被叫，所以這裡只能用 console.log，不能用 log()
  try {
    const raw = localStorage.getItem(TRANSLATION_CACHE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    const now = Date.now();
    const map = new Map();
    let expired = 0;
    for (const [key, entry] of Object.entries(obj)) {
      if (entry?.ts && now - entry.ts < TRANSLATION_CACHE_TTL) {
        map.set(key, entry);
      } else {
        expired++;
      }
    }
    console.log(`[kaitalk] 📚 載入翻譯快取 ${map.size} 筆${expired ? `（過期 ${expired} 筆）` : ''}`);
    return map;
  } catch (err) {
    console.warn(`[kaitalk] 快取載入失敗: ${err.message}`);
    return new Map();
  }
}

let saveTimer = null;
function saveTranslationCacheDebounced() {
  // 每 2 秒最多寫一次，避免頻繁 I/O
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj = {};
      for (const [k, v] of translationCache) obj[k] = v;
      localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(obj));
    } catch (err) {
      log(`快取存檔失敗: ${err.message}`);
      // 通常是 quota exceeded → 砍一半重試
      try {
        const sorted = [...translationCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
        for (let i = 0; i < Math.floor(sorted.length / 2); i++) {
          translationCache.delete(sorted[i][0]);
        }
        const obj = {};
        for (const [k, v] of translationCache) obj[k] = v;
        localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(obj));
        log(`已清掉一半舊快取重新存`);
      } catch {}
    }
  }, 2000);
}

function evictOldestIfNeeded() {
  if (translationCache.size <= TRANSLATION_CACHE_LIMIT) return;
  // LRU：按 ts 排序，刪掉最舊的 50 筆（一次刪多筆減少刪除頻率）
  const sorted = [...translationCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const toDelete = translationCache.size - TRANSLATION_CACHE_LIMIT + 50;
  for (let i = 0; i < toDelete; i++) {
    translationCache.delete(sorted[i][0]);
  }
}

const translationCache = loadTranslationCache();

let lastWorkingProvider = null; // 紀錄最後一次成功的 provider，下次優先用

async function translateText(text, fromLang, toLang) {
  if (!text || !text.trim()) return null;
  const key = `${fromLang}|${toLang}|${text}`;

  // 查快取
  const cached = translationCache.get(key);
  if (cached) {
    // 更新 ts（LRU 用），但不寫檔（避免每次讀都寫）
    cached.ts = Date.now();
    return cached.value;
  }

  // 把 lastWorkingProvider 排到最前，避免每次都重試前面的 provider
  const ordered = lastWorkingProvider
    ? [lastWorkingProvider, ...PROVIDERS.filter(p => p !== lastWorkingProvider)]
    : PROVIDERS;

  for (const p of ordered) {
    try {
      if (!(await p.isAvailable(fromLang, toLang))) continue;
      const translated = await p.translate(text, fromLang, toLang);
      if (translated && translated !== text) {
        if (lastWorkingProvider !== p) {
          log(`✨ 翻譯使用: ${p.name}`);
          lastWorkingProvider = p;
        }
        translationCache.set(key, { value: translated, ts: Date.now() });
        evictOldestIfNeeded();
        saveTranslationCacheDebounced();
        return translated;
      }
    } catch (err) {
      log(`翻譯失敗 (${p.name}): ${err.message}`);
      continue;
    }
  }
  log(`所有翻譯 provider 都失敗`);
  return null;
}

// 給 UI/Console 用：清掉所有翻譯快取
window.kaitalkClearTranslationCache = function() {
  translationCache.clear();
  localStorage.removeItem(TRANSLATION_CACHE_KEY);
  log(`🗑️ 翻譯快取已清空`);
};

// ─── Helpers ─────────────────────────────────────────
const log = (msg) => {
  const t = new Date().toLocaleTimeString();
  logEl.innerHTML = `[${t}] ${msg}<br>` + logEl.innerHTML;
  console.log(`[kaitalk] ${msg}`);
};

const setStatus = (text, withPulse = false) => {
  statusEl.innerHTML = (withPulse ? '<span class="pulse"></span>' : '') + text;
};

const showButtons = (state) => {
  // 3 個配對模式按鈕（包成 #match-modes 容器，整個一起 show/hide）
  const matchModes = document.getElementById('match-modes');
  if (matchModes) matchModes.style.display = state === 'idle' ? 'block' : 'none';

  // user card（暱稱+地區+想找）只在 idle 顯示
  const ub = document.getElementById('user-bar');
  if (ub) ub.style.display = state === 'idle' ? 'flex' : 'none';

  // 歷史對話區只在 idle 顯示（有紀錄時）
  const bottomTabs = document.getElementById('bottom-tabs');
  if (bottomTabs) {
    if (state === 'idle') {
      renderBottomTabs();
    } else {
      bottomTabs.style.display = 'none';
    }
  }

  // status 只在 matching 時顯示（idle 隱藏，in-call 也隱藏）
  statusEl.style.display = state === 'matching' ? 'block' : 'none';

  btnCancel.style.display = state === 'matching' ? 'block' : 'none';

  // 想再遇 + 掛斷（包在 #call-actions 一行裡）
  const callActions = document.getElementById('call-actions');
  if (callActions) {
    callActions.style.display = state === 'in-call' ? 'flex' : 'none';
  }
  // 封鎖 + 檢舉
  const safetyActions = document.getElementById('safety-actions');
  if (safetyActions) {
    safetyActions.style.display = state === 'in-call' ? 'flex' : 'none';
  }
  // 打字輸入框（通話中才顯示）
  const cib = document.getElementById('chat-input-bar');
  if (cib) cib.style.display = state === 'in-call' ? 'flex' : 'none';
  // reset 想再遇按鈕狀態
  const btnMeetAgainEl = document.getElementById('btn-meet-again');
  if (btnMeetAgainEl && state === 'in-call') {
    btnMeetAgainEl.textContent = '💚 想再遇';
    btnMeetAgainEl.classList.remove('pressed');
    btnMeetAgainEl.disabled = false;
  }
  // 通話中拿掉這些（讓字幕區可以更大）：
  //   - 暱稱輸入框（已顯示在 user-bar）
  //   - 喇叭按鈕（一般用戶用不到，只有單機測試需要）
  //   - status 列（peer card 已經顯示「與你配對的是 X」）
  btnMute.style.display = 'none';
};

const showPeerCard = (name, room, role, peerVerified, peerGender) => {
  peerNameEl.textContent = name;
  // 顯示對方性別 icon
  const pgIcon = document.getElementById('peer-gender-icon');
  if (pgIcon) pgIcon.textContent = GENDER_ICONS[peerGender] || '';
  roomCodeEl.textContent = room;
  myRoleEl.textContent = role === 'host' ? 'HOST' : 'GUEST';
  myRoleEl.className = `role ${role}`;
  // 位置驗證徽章：true = 綠勾（IP 跟 declared 同國），其他 = 不顯示
  const verifyEl = document.getElementById('peer-verified-badge');
  if (verifyEl) {
    if (peerVerified === true) {
      verifyEl.textContent = '✓';
      verifyEl.title = '對方位置已驗證（IP 與申報一致）';
      verifyEl.style.display = 'inline-block';
    } else {
      verifyEl.style.display = 'none';
    }
  }
  peerCard.classList.add('active');
};

const hidePeerCard = () => {
  peerCard.classList.remove('active');
};

// 對方語言徽章：null = 偵測中、傳 lang code = 顯示國旗
function setPeerLangBadge(langCode) {
  if (!peerLangBadgeEl) return;
  if (!langCode) {
    peerLangBadgeEl.textContent = '🌐 偵測中';
    peerLangBadgeEl.classList.add('detecting');
    return;
  }
  const li = langInfo(langCode);
  peerLangBadgeEl.textContent = li.flag;
  peerLangBadgeEl.classList.remove('detecting');
}

const showMeters = () => metersEl.classList.add('active');
const hideMeters = () => metersEl.classList.remove('active');

const showSubtitles = () => {
  subtitlesEl.classList.add('active');
  langBarEl.classList.add('active');
};
const hideSubtitles = () => {
  subtitlesEl.classList.remove('active');
  langBarEl.classList.remove('active');
};

// ─── Web Audio Analyser ──────────────────────────────
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function attachAnalyser(stream) {
  const ctx = ensureAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);
  // 注意：不接到 ctx.destination，避免本地 mic 變 echo
  return analyser;
}

// 算 RMS level（time domain，比 frequency 準）
function getLevel(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 3); // ×3 讓視覺更靈敏
}

function startMeterLoop() {
  if (meterRafId) return;
  const tick = () => {
    const localLv = getLevel(localAnalyser);
    const remoteLv = getLevel(remoteAnalyser);

    localMeter.style.width = (localLv * 100) + '%';
    remoteMeter.style.width = (remoteLv * 100) + '%';
    localLevelEl.textContent = Math.round(localLv * 100) + '%';
    remoteLevelEl.textContent = Math.round(remoteLv * 100) + '%';

    meterRafId = requestAnimationFrame(tick);
  };
  tick();
}

function stopMeterLoop() {
  if (meterRafId) {
    cancelAnimationFrame(meterRafId);
    meterRafId = null;
  }
  localMeter.style.width = '0%';
  remoteMeter.style.width = '0%';
  localLevelEl.textContent = '0%';
  remoteLevelEl.textContent = '0%';
}

// ─── Subtitle Buffer ─────────────────────────────────
//
// 設計：
//   - in-memory event log，掛斷瞬間清空
//   - 每筆 { id, speaker: 'self'|'peer', text, interim, ts }
//   - interim（暫時的中間結果）會被同 speaker 的下一個 interim 取代
//   - final 把 interim 升級為定稿
//
// 之後要做：本機 IndexedDB 持久化、「保存對話」按鈕、檢舉時打包證據
function addSubtitle(speaker, text, lang, interim) {
  if (!text || !text.trim()) return;

  // 找到該 speaker 最後一筆 interim
  let lastInterimIdx = -1;
  for (let i = subtitleBuffer.length - 1; i >= 0; i--) {
    if (subtitleBuffer[i].speaker === speaker && subtitleBuffer[i].interim) {
      lastInterimIdx = i;
      break;
    }
  }

  let entry;
  if (lastInterimIdx !== -1) {
    // 取代既有 interim
    entry = subtitleBuffer[lastInterimIdx];
    entry.text = text;
    entry.lang = lang;
    entry.interim = interim;
    entry.ts = Date.now();
    entry.translated = null; // 重新翻譯
  } else {
    // 新增一筆
    entry = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      speaker,
      text,
      lang,
      interim,
      ts: Date.now(),
      translated: null,
    };
    subtitleBuffer.push(entry);
  }

  while (subtitleBuffer.length > MAX_BUFFER) subtitleBuffer.shift();
  renderSubtitles();

  // 翻譯邏輯：
  //   - 只翻譯對方的最終結果（self 不用翻、interim 太花費）
  //   - 對方語言跟我不一樣才翻
  //   - 翻好後更新 entry 並重新 render
  if (
    speaker === 'peer' &&
    !interim &&
    lang &&
    lang.split('-')[0] !== sttLang.split('-')[0]
  ) {
    translateText(text, lang, sttLang).then(translated => {
      if (translated && translated !== text) {
        entry.translated = translated;
        entry.translatedTo = sttLang;
        renderSubtitles();
      }
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderSubtitles() {
  if (subtitleBuffer.length === 0) {
    subtitlesListEl.innerHTML = '<div class="subtitles-empty">開始講話試試看...</div>';
    return;
  }
  subtitlesListEl.innerHTML = subtitleBuffer.map(s => {
    const label = s.speaker === 'self' ? '你' : (peerName || '對方');
    const li = langInfo(s.lang || 'unknown');
    const translationHTML = s.translated
      ? `<div class="translation">↳ ${escapeHtml(s.translated)}</div>`
      : '';
    return `<div class="subtitle-line ${s.speaker} ${s.interim ? 'interim' : ''}">
      <span class="speaker">${li.flag} ${escapeHtml(label)}</span>
      <div class="text-wrap">
        <div class="text">${escapeHtml(s.text)}</div>
        ${translationHTML}
      </div>
    </div>`;
  }).join('');
  // 自動捲到底
  subtitlesListEl.parentElement.scrollTop = subtitlesListEl.parentElement.scrollHeight;
}

function clearSubtitles() {
  subtitleBuffer.length = 0;
  renderSubtitles();
}

// ─── Web Speech API (STT) ────────────────────────────
//
// 兩邊各自的瀏覽器跑 STT 處理「自己」的麥克風，
// 結果透過 DataChannel 傳給對方顯示。
//
// 跟翻譯解耦：未來加翻譯只是在 onresult 多套一層 translateFn 再 send。
function isSTTSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function setSTTStatus(state, label) {
  if (!sttStatusEl) return;
  sttStatusEl.className = `stt-status ${state}`;
  // 只顯示圓點，不顯示文字（省空間）
  sttStatusEl.innerHTML = `<span class="dot"></span>`;
  sttStatusEl.title = label || state; // hover 才看得到文字
}

function startSTT() {
  if (!isSTTSupported()) {
    log('⚠️ 瀏覽器不支援 Web Speech API');
    setSTTStatus('error', '不支援');
    subtitlesListEl.innerHTML = '<div class="subtitles-empty">此瀏覽器不支援即時字幕<br>請改用 Chrome / Edge / Safari</div>';
    return;
  }
  if (sttActive) {
    log('STT 已經在跑了，跳過');
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = sttLang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    log(`✅ STT onstart 觸發 (${sttLang})`);
    setSTTStatus('active', '辨識中');
    if (subtitleBuffer.length === 0) {
      subtitlesListEl.innerHTML = '<div class="subtitles-empty">講話試試看...（已在辨識）</div>';
    }
  };

  recognition.onaudiostart = () => log('🎤 STT 開始接收音訊');
  recognition.onspeechstart = () => log('🗣️ STT 偵測到人聲');
  recognition.onnomatch = () => log('STT 沒辨識出內容');

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      const isFinal = result.isFinal;
      if (!text) continue;

      log(`📝 STT result: "${text}" (final=${isFinal})`);

      // 顯示在自己這邊（標自己的語言）
      addSubtitle('self', text, sttLang, !isFinal);

      // 透過 DataChannel 傳給對方
      // 注意：lang 一定要帶，未來翻譯才知道從什麼翻成什麼
      if (subtitleDC && subtitleDC.readyState === 'open') {
        try {
          subtitleDC.send(JSON.stringify({
            type: 'subtitle',
            v: 1,
            data: {
              text,
              lang: sttLang,
              interim: !isFinal,
              ts: Date.now(),
            },
          }));
        } catch (err) {
          log(`字幕送出失敗: ${err.message}`);
        }
      } else if (isFinal) {
        // DC 還沒開：等開了之後再送可能來不及，但 self 顯示一定要有
        log(`(DC 未開，僅本地顯示)`);
      }
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') {
      // 常見、無害；no-speech 是 Chrome 沒聽到聲音超過幾秒
      return;
    }
    log(`❌ STT error: ${e.error}`);
    setSTTStatus('error', e.error);

    // 'not-allowed' = 用戶拒絕麥克風
    // 'service-not-allowed' = Chrome 連不到 Google STT 服務
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      sttActive = false; // 不要 auto restart
    }
  };

  recognition.onend = () => {
    log(`STT onend (sttActive=${sttActive})`);
    // Safari/Chrome 會在停頓後自動結束 → 沒掛斷的話自動重啟
    if (sttActive) {
      try {
        recognition.start();
      } catch (err) {
        log(`STT restart 失敗: ${err.message}`);
        setSTTStatus('error', '重啟失敗');
      }
    } else {
      setSTTStatus('idle', '已停止');
    }
  };

  setSTTStatus('starting', '啟動中...');
  try {
    recognition.start();
    sttActive = true;
    log(`▶️ STT.start() 已呼叫 (${sttLang})`);
  } catch (err) {
    log(`❌ STT.start() 失敗: ${err.message}`);
    setSTTStatus('error', err.message);
  }
}

function stopSTT() {
  sttActive = false;
  if (recognition) {
    try { recognition.stop(); } catch {}
    recognition = null;
  }
  setSTTStatus('idle', '未啟動');
}

function updateLangBtn() {
  const li = langInfo(sttLang);
  // 只顯示國旗（省空間）
  langBtn.textContent = li.flag;
  langBtn.title = li.label; // hover 看完整名
}

function toggleLang() {
  const idx = LANGS.findIndex(l => l.code === sttLang);
  sttLang = LANGS[(idx + 1) % LANGS.length].code;
  localStorage.setItem('kaitalk.lang', sttLang);
  updateLangBtn();
  log(`我講的語言改成: ${sttLang}`);
  // 重啟 STT 套用新語言
  if (sttActive) {
    stopSTT();
    setTimeout(() => startSTT(), 200);
  }
}

// ─── Subtitle DataChannel ────────────────────────────
function setupSubtitleDC(dc) {
  subtitleDC = dc;
  dc.onopen = () => {
    log(`字幕 DataChannel open（雙向字幕通道已建立）`);
  };
  dc.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);

      // 語音字幕
      if (msg.type === 'subtitle' && msg.data) {
        if (!subtitlesEnabled) return;
        const { text, lang, interim } = msg.data;
        if (!peerLang && lang) {
          peerLang = lang;
          log(`對方語言: ${lang}`);
          setPeerLangBadge(lang);
        }
        addSubtitle('peer', text, lang, interim);
      }

      // 文字訊息（打字）
      if (msg.type === 'chat' && msg.data) {
        const { text, lang } = msg.data;
        if (!peerLang && lang) {
          peerLang = lang;
          setPeerLangBadge(lang);
        }
        addSubtitle('peer', text, lang, false);
      }
    } catch (err) {
      log(`DC parse error: ${err.message}`);
    }
  };
  dc.onclose = () => log(`字幕 DataChannel closed`);
  dc.onerror = (e) => log(`字幕 DC error: ${e.error || 'unknown'}`);
}

// ─── Socket ──────────────────────────────────────────
// ─── Supabase Auth state ──────────────────────────────
// 匿名登入拿到的 JWT。socket.io 連線時帶上它。
// 失敗都 fall back 到「沒 token」，舊行為照常。
let supabaseClient = null;
let kaitalkUserId = null;
let kaitalkAccessToken = null;

async function initSupabaseAnonAuth() {
  // 1. 讀 server 給的 config
  let config;
  try {
    const r = await fetch('/config.json');
    config = await r.json();
  } catch (err) {
    log(`⚠️ /config.json 讀不到，跳過 Auth: ${err.message}`);
    return;
  }
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) {
    log(`⚠️ Supabase config 沒設，跳過 Auth`);
    return;
  }

  // 2. 建 supabase client（用 CDN 載入的 global 變數）
  if (typeof window.supabase?.createClient !== 'function') {
    log(`⚠️ Supabase JS 沒載入，跳過 Auth`);
    return;
  }
  try {
    supabaseClient = window.supabase.createClient(
      config.supabaseUrl,
      config.supabaseAnonKey,
      {
        auth: {
          // 把 session 存 localStorage，刷新頁面也保留同一個 user.id
          persistSession: true,
          autoRefreshToken: true,
          storageKey: 'kaitalk.supabase.session',
        },
      }
    );
  } catch (err) {
    log(`⚠️ Supabase client 建立失敗: ${err.message}`);
    return;
  }

  // 3. 看有沒有既有 session（之前匿名登入過、persistSession 帶回來的）
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session?.access_token) {
      kaitalkUserId = session.user.id;
      kaitalkAccessToken = session.access_token;
      log(`🔑 既有匿名 session: ${kaitalkUserId.slice(0, 8)}...`);
      return;
    }
  } catch (err) {
    log(`⚠️ getSession 失敗: ${err.message}`);
  }

  // 4. 沒 session → 建匿名帳號
  try {
    const { data, error } = await supabaseClient.auth.signInAnonymously();
    if (error) {
      log(`⚠️ 匿名登入失敗: ${error.message}`);
      return;
    }
    if (data?.session) {
      kaitalkUserId = data.session.user.id;
      kaitalkAccessToken = data.session.access_token;
      log(`🔑 匿名登入成功: ${kaitalkUserId.slice(0, 8)}...`);
    }
  } catch (err) {
    log(`⚠️ signInAnonymously throw: ${err.message}`);
  }
}

function connectSocket() {
  // 連 socket.io 時把 JWT 帶上去（沒 token 也 OK，server 會 fallback）
  const opts = { transports: ['websocket', 'polling'] };
  if (kaitalkAccessToken) {
    opts.auth = { token: kaitalkAccessToken };
  }
  socket = io(opts);

  socket.on('connect', () => {
    log(`Socket connected: ${socket.id.slice(0, 8)}`);
    setStatus('就緒，按下方按鈕開始配對');
    showButtons('idle');
  });

  socket.on('match_queued', ({ position }) => {
    log(`進入佇列 (#${position})`);
    setStatus('等待其他使用者...', true);
    // 啟動 30 秒沒配到提示
    startMatchTimeoutTimer();
  });

  socket.on('match_found', async ({ roomCode, isHost: hostFlag, peer, peerVerified, peerRegion, peerGender }) => {
    // 配對成功，停掉等待逾時
    stopMatchTimeoutTimer();
    peerId = peer.id;
    peerUserId = peer.userId || null; // Supabase uid（for block/report API）
    peerName = peer.name;
    peerRegionStored = peerRegion || null;
    peerGenderStored = peerGender || null;
    isHost = hostFlag;
    log(`配對成功！房號 ${roomCode}, 對方 ${peer.name} ${peerGender || '?'}, 我是 ${isHost ? 'host' : 'guest'}`);
    setStatus(`🎉 已配對到 ${peer.name}，建立連線中...`, true);
    showPeerCard(peer.name, roomCode, isHost ? 'host' : 'guest', peerVerified, peerGender);
    setPeerLangBadge(null); // 對方語言一開始未知
    // 在地化豆知識：根據雙方地區選
    const myRegion = localStorage.getItem(ONB_BIG_REGION_KEY) || null;
    showRandomTrivia(myRegion, peerRegion);
    showButtons('in-call');
    showMeters();
    if (subtitlesEnabled) showSubtitles();
    clearSubtitles();
    await setupPeerConnection();
  });

  socket.on('webrtc_signal', async ({ from, signal }) => {
    if (!pc) return;
    try {
      if (signal.type === 'offer') {
        log(`收到 offer`);
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        pendingCandidates = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc_signal', { target: from, signal: answer });
        log(`回送 answer`);
      } else if (signal.type === 'answer') {
        log(`收到 answer`);
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        pendingCandidates = [];
      } else if (signal.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(signal));
        } else {
          pendingCandidates.push(new RTCIceCandidate(signal));
        }
      }
    } catch (err) {
      log(`signal error: ${err.message}`);
    }
  });

  socket.on('peer_hangup', () => {
    log(`對方掛斷`);
    saveConversationHistory(); // 對方掛斷也要存
    renderBottomTabs();
    const oldName = peerName;
    cleanup();
    setStatus(`${oldName || '對方'} 掛斷了`);
    hidePeerCard();
    hideMeters();
    hideTrivia();
    hideSubtitles();
    showButtons('idle');
  });

  // ── 互相想再遇通知（掛斷後才收到）──
  socket.on('meet_again_mutual', ({ peerName: mutualName }) => {
    log(`🎉 互相想再遇！對方: ${mutualName}`);
    const overlay = document.getElementById('mutual-match-overlay');
    const nameEl = document.getElementById('mutual-match-name');
    if (overlay && nameEl) {
      nameEl.textContent = mutualName || '—';
      overlay.classList.add('active');
    }
  });

  socket.on('reunion_code', ({ code }) => {
    log(`💌 重逢碼: ${code}`);
    const codeBox = document.getElementById('reunion-code-box');
    const codeDisplay = document.getElementById('reunion-code-display');
    if (codeBox && codeDisplay) {
      codeDisplay.textContent = code;
      codeBox.style.display = 'block';
    }
    // 也存到 localStorage，方便之後查看
    try {
      const codes = JSON.parse(localStorage.getItem('kaitalk.reunionCodes') || '[]');
      codes.unshift({ code, peerName: peerName || '未知', ts: Date.now() });
      if (codes.length > 20) codes.length = 20;
      localStorage.setItem('kaitalk.reunionCodes', JSON.stringify(codes));
    } catch {}
  });

  socket.on('reunion_invalid', () => {
    log('⚠️ 重逢碼無效或已過期');
    setStatus('重逢碼無效，請確認後重試');
  });

  socket.on('banned', ({ message }) => {
    log(`🚫 ${message}`);
    setStatus(message);
    showButtons('idle');
  });

  socket.on('match_cancelled', () => {
    stopMatchTimeoutTimer();
    log(`配對已取消`);
    setStatus('已取消');
    showButtons('idle');
  });

  socket.on('disconnect', () => {
    log(`Socket disconnected`);
    setStatus('連線中斷');
  });
}

// ─── WebRTC ──────────────────────────────────────────
async function setupPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // 加入本地音訊 track（這就是 kaitalk vs porkergame 的關鍵差別）
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    log(`本地 audio track 已加入`);
  }

  // 字幕 DataChannel：host 建立、guest 接收
  // 用獨立的 DataChannel 是為了 protocol 擴充性——
  // 之後可以再加 'reaction'、'game' 等 channel，互不干擾
  if (isHost) {
    const dc = pc.createDataChannel('subtitle', { ordered: true });
    setupSubtitleDC(dc);
    log(`Host: 建立 subtitle DataChannel`);
  } else {
    pc.ondatachannel = (event) => {
      if (event.channel.label === 'subtitle') {
        log(`Guest: 收到 subtitle DataChannel`);
        setupSubtitleDC(event.channel);
      }
    };
  }

  // STT 立刻啟動，不等 DataChannel —— 即使 DC 還沒開，本地字幕一定要先看得到
  // DC 開好後送出去的訊息會自動帶走，沒開的話就只在自己這邊顯示
  if (subtitlesEnabled) {
    startSTT();
  }

  // 收到對方的 track → 接到 <audio> 播放 + 接到 analyser 顯示音量
  pc.ontrack = (event) => {
    log(`收到對方 audio track`);
    const remoteStream = event.streams[0];
    remoteAudio.srcObject = remoteStream;
    remoteAnalyser = attachAnalyser(remoteStream);
    setStatus(`🎙️ 與 ${peerName} 通話中`, true);
  };

  // ICE candidate → 透過 server 轉給對方
  let iceCandidateCount = 0;
  pc.onicecandidate = (event) => {
    if (event.candidate && peerId) {
      iceCandidateCount++;
      // 只 log 前 3 個跟最後 1 個 (gathering 結束)，避免洗滿
      if (iceCandidateCount <= 3) {
        log(`🧊 ICE candidate #${iceCandidateCount}: ${event.candidate.type || '?'}`);
      }
      socket.emit('webrtc_signal', { target: peerId, signal: event.candidate });
    } else if (!event.candidate) {
      log(`🧊 ICE gathering 結束（共送 ${iceCandidateCount} 個）`);
    }
  };

  pc.oniceconnectionstatechange = () => {
    log(`ICE state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'connected') {
      setStatus(`🎙️ 與 ${peerName} P2P 連線成功，正在通話`, true);
    } else if (pc.iceConnectionState === 'failed') {
      setStatus('連線失敗（可能需要 TURN）');
    }
  };

  pc.onconnectionstatechange = () => {
    log(`PC state: ${pc.connectionState}`);
  };

  // host 主動發 offer
  if (isHost) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc_signal', { target: peerId, signal: offer });
    log(`已發送 offer 給 ${peerId.slice(0, 8)}`);
  }
  // guest 等對方的 offer
}

// ─── Actions ─────────────────────────────────────────
//
// startMatching 接受一個 options 參數：
//   { mode: 'quick' | 'nearby' | 'specific', targetRegion?: 'jp-kanto' }
// 預設 'quick'（隨機，全球）
//
// nearby = 自己的大區（從 localStorage 讀）
// specific = 用戶選的目標大區
async function startMatching(opts = {}) {
  const mode = opts.mode || 'quick';
  const targetRegion = opts.targetRegion || null;
  const reunionCode = opts.reunionCode || null;
  // 記住，給逾時提示用
  lastMatchOpts = { mode, targetRegion };

  // 防呆：如果上一次的 pc/stream 還沒清乾淨，先 cleanup
  // 這個發生在「上次配對失敗 / 沒掛斷就再點」的情況
  if (pc || localStream) {
    log('🧹 startMatching: 清掉殘留的 pc/stream');
    cleanup();
  }

  try {
    setStatus('請求麥克風權限...');
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    log(`麥克風 OK`);

    // 立刻掛上本地 mic analyser，這樣配對時就能看自己的 mic 動
    localAnalyser = attachAnalyser(localStream);
    showMeters();
    startMeterLoop();

    // 強迫暱稱：button disabled 已經擋掉空字串，這裡再保險一次
    // 優先讀 localStorage（input 在主畫面是 hidden）
    const name = (localStorage.getItem(ONB_NICKNAME_KEY) || nameInput.value || '').trim();
    if (!name) {
      log('⚠️ 請先輸入暱稱');
      setStatus('請先輸入暱稱');
      return;
    }
    // 寫進通話畫面右半「自己」的名字
    const myGender = localStorage.getItem(ONB_GENDER_KEY);
    const myGIcon = GENDER_ICONS[myGender] || '👤';
    if (userDisplayEl) userDisplayEl.textContent = `${name} ${myGIcon}`;

    // 我自己的大區（onboarding 存的）
    const myBigRegion = localStorage.getItem(ONB_BIG_REGION_KEY) || null;

    // 三種模式對應的配對訊息
    const matchPayload = {
      name,
      lang: sttLang,
      mode,
      myBigRegion,
      targetRegion,
      targetLangs: getTargetLangs(),
      gender: localStorage.getItem(ONB_GENDER_KEY) || null,
      targetGender: localStorage.getItem(ONB_TARGET_GENDER_KEY) || 'any',
      reunionCode,
    };

    log(`📡 開始配對 (mode=${mode}${targetRegion ? ', target=' + targetRegion : ''}${reunionCode ? ', 重逢碼=' + reunionCode : ''})`);
    if (reunionCode) {
      setStatus('💌 使用重逢碼尋找對方...', true);
    }
    socket.emit('find_match', matchPayload);
    showButtons('matching');
  } catch (err) {
    log(`getUserMedia 失敗: ${err.message}`);
    setStatus('無法取得麥克風權限');
  }
}

function cancelMatching() {
  stopMatchTimeoutTimer();
  socket.emit('cancel_match');
  cleanup();
  hidePeerCard();
  hideMeters();
  hideSubtitles();
  showButtons('idle');
}

// ─── 配對逾時提示（30 秒沒配到）─────────
const MATCH_TIMEOUT_MS = 30000;

function startMatchTimeoutTimer() {
  stopMatchTimeoutTimer();
  matchTimeoutId = setTimeout(() => {
    matchTimeoutId = null;
    handleMatchTimeout();
  }, MATCH_TIMEOUT_MS);
}

function stopMatchTimeoutTimer() {
  if (matchTimeoutId) {
    clearTimeout(matchTimeoutId);
    matchTimeoutId = null;
  }
}

async function handleMatchTimeout() {
  // 如果已經配上了或取消了 → 不做事
  if (peerId || !lastMatchOpts) return;

  const mode = lastMatchOpts.mode || 'quick';
  if (mode === 'quick') {
    // 已經是 quick 還配不到 → 不能 fallback 了，只是再等
    setStatus('還在等待中，可以再耐心一下...', true);
    log(`⏰ 配對逾時 (quick mode 已是最寬鬆)`);
    return;
  }

  // nearby 或 specific → 提示換 quick
  log(`⏰ 配對逾時 (${mode}) → 提示用戶換 quick`);
  const modeLabel = mode === 'nearby' ? '附近' : '指定地方';
  const wantQuick = await showConfirm({
    icon: '😔',
    text: `「${modeLabel}」配對 30 秒了還沒人，要不要改成「快速配對」試試？`,
    okLabel: '快速配對',
    cancelLabel: '繼續等',
  });
  if (wantQuick) {
    cancelMatching();
    setTimeout(() => {
      startMatching({ mode: 'quick' });
    }, 200);
  } else {
    setStatus('繼續等待中...', true);
    startMatchTimeoutTimer();
  }
}

function showConfirm({ icon = '📞', text = '確定嗎？', okLabel = '確定', cancelLabel = '取消' }) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-overlay');
    const iconEl = document.getElementById('confirm-icon');
    const textEl = document.getElementById('confirm-text');
    const btnOk = document.getElementById('btn-confirm-ok');
    const btnCancel = document.getElementById('btn-confirm-cancel');
    if (!overlay) return resolve(false);

    iconEl.textContent = icon;
    textEl.textContent = text;
    btnOk.textContent = okLabel;
    btnCancel.textContent = cancelLabel;
    overlay.classList.add('active');

    const cleanup = () => {
      overlay.classList.remove('active');
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
  });
}

// ─── 封鎖 + 檢舉 ─────────────────────────────────────

async function apiCall(path, body) {
  if (!kaitalkAccessToken) return { error: 'no auth' };
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${kaitalkAccessToken}`,
      },
      body: JSON.stringify(body),
    });
    return await resp.json();
  } catch (err) {
    return { error: err.message };
  }
}

async function blockCurrentPeer() {
  if (!peerUserId) {
    log('⚠️ 對方未驗證，無法封鎖');
    return;
  }
  const yes = await showConfirm({
    icon: '🚫',
    text: `封鎖 ${peerName || '對方'}？\n封鎖後將永遠不會再配對到此人。`,
    okLabel: '封鎖',
    cancelLabel: '取消',
  });
  if (!yes) return;

  const result = await apiCall('/api/block', { blockedId: peerUserId });
  if (result.ok) {
    log(`🚫 已封鎖 ${peerName}`);
  } else {
    log(`封鎖失敗: ${result.error || '未知錯誤'}`);
  }
}

function showReportOverlay() {
  const overlay = document.getElementById('report-overlay');
  if (!overlay) return;
  // 重置選中狀態
  overlay.querySelectorAll('.report-reason-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('report-notes')?.setAttribute('value', '');
  if (document.getElementById('report-notes')) document.getElementById('report-notes').value = '';
  document.getElementById('btn-report-submit')?.setAttribute('disabled', '');
  overlay.classList.add('active');
}

async function submitReport() {
  if (!peerUserId) {
    log('⚠️ 對方未驗證，無法檢舉');
    return;
  }
  const overlay = document.getElementById('report-overlay');
  const selectedBtn = overlay?.querySelector('.report-reason-btn.selected');
  if (!selectedBtn) return;

  const reason = selectedBtn.dataset.reason;
  const notes = document.getElementById('report-notes')?.value || '';

  // 用字幕 buffer 當證據
  const evidenceSnapshot = subtitleBuffer
    .filter(s => !s.interim && s.text)
    .map(s => ({ speaker: s.speaker, text: s.text, lang: s.lang, ts: s.ts }));

  const result = await apiCall('/api/report', {
    reportedId: peerUserId,
    reason,
    notes: notes.slice(0, 500),
    evidenceSnapshot,
  });

  overlay?.classList.remove('active');

  if (result.ok) {
    log(`🚨 已檢舉 ${peerName}（${reason}），對方已被自動封鎖`);
    // 檢舉 = 自動封鎖 + 掛斷
    saveConversationHistory();
    renderBottomTabs();
    if (peerId) socket.emit('hangup', { target: peerId });
    cleanup();
    setStatus('已檢舉並掛斷');
    hidePeerCard();
    hideMeters();
    hideSubtitles();
    showButtons('idle');
  } else {
    log(`檢舉失敗: ${result.error || '未知錯誤'}`);
  }
}

async function hangup() {
  const yes = await showConfirm({
    icon: '📞',
    text: '確定要結束通話嗎？',
    okLabel: '結束通話',
    cancelLabel: '繼續聊',
  });
  if (!yes) return;
  // 掛斷前保存對話紀錄
  saveConversationHistory();
  renderBottomTabs();
  if (peerId) socket.emit('hangup', { target: peerId });
  cleanup();
  setStatus('已掛斷');
  hidePeerCard();
  hideMeters();
  hideSubtitles();
  showButtons('idle');
}

function toggleMute() {
  const muted = !remoteAudio.muted;
  remoteAudio.muted = muted;
  if (muted) {
    btnMute.textContent = '🔇 喇叭：靜音中（meter 仍然會動）';
    btnMute.classList.add('muted');
  } else {
    btnMute.textContent = '🔊 喇叭：開（單機測試請按靜音）';
    btnMute.classList.remove('muted');
  }
  log(`喇叭 ${muted ? '靜音' : '開啟'}`);
}

function updateSubtitleBtn() {
  // 只顯示圖示，靠顏色暗示開/關（避免文字太多擠版）
  btnSubtitle.textContent = '💬';
  btnSubtitle.title = subtitlesEnabled ? '字幕開啟中（點此關閉）' : '字幕已關閉（點此開啟）';
  if (subtitlesEnabled) {
    btnSubtitle.classList.remove('off');
  } else {
    btnSubtitle.classList.add('off');
  }
}

function toggleSubtitles() {
  subtitlesEnabled = !subtitlesEnabled;
  localStorage.setItem('kaitalk.subtitles', subtitlesEnabled ? 'true' : 'false');
  updateSubtitleBtn();
  log(`字幕 ${subtitlesEnabled ? '開啟' : '關閉'}`);

  if (subtitlesEnabled) {
    showSubtitles();
    // 只有正在通話才啟動 STT
    if (pc) startSTT();
  } else {
    stopSTT();
    hideSubtitles();
    clearSubtitles();
  }
}

function cleanup() {
  stopSTT();
  stopMeterLoop();
  if (subtitleDC) {
    try { subtitleDC.close(); } catch {}
    subtitleDC = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (remoteAudio.srcObject) {
    remoteAudio.srcObject = null;
  }
  localAnalyser = null;
  remoteAnalyser = null;
  peerId = null;
  peerUserId = null;
  peerName = null;
  peerLang = null;
  peerRegionStored = null;
  peerGenderStored = null;
  isHost = false;
  pendingCandidates = [];
  if (userDisplayEl) userDisplayEl.textContent = '—';
}

// ─── Onboarding（新用戶第一次開時的 5 步驟引導）────
const ONB_NICKNAME_KEY = 'kaitalk.nickname';
const ONB_GENDER_KEY = 'kaitalk.gender';
const ONB_TARGET_GENDER_KEY = 'kaitalk.targetGender';
const ONB_BIG_REGION_KEY = 'kaitalk.bigRegion';
const ONB_DONE_KEY = 'kaitalk.onboardingDone';
const ONB_AVATAR_KEY = 'kaitalk.avatar';

const GENDER_ICONS = { male: '👨', female: '👩', other: '😊' };

const BIG_REGIONS = [
  { id: 'tw-north',    flag: '🇹🇼', name: '北部' },
  { id: 'tw-central',  flag: '🇹🇼', name: '中部' },
  { id: 'tw-south',    flag: '🇹🇼', name: '南部' },
  { id: 'tw-east',     flag: '🇹🇼', name: '東部' },
  { id: 'tw-island',   flag: '🇹🇼', name: '離島' },
  { id: 'jp-hokkaido', flag: '🇯🇵', name: '北海道' },
  { id: 'jp-tohoku',   flag: '🇯🇵', name: '東北' },
  { id: 'jp-kanto',    flag: '🇯🇵', name: '関東' },
  { id: 'jp-chubu',    flag: '🇯🇵', name: '中部' },
  { id: 'jp-kansai',   flag: '🇯🇵', name: '関西' },
  { id: 'jp-chugoku',  flag: '🇯🇵', name: '中国' },
  { id: 'jp-shikoku',  flag: '🇯🇵', name: '四国' },
  { id: 'jp-kyushu',   flag: '🇯🇵', name: '九州' },
];

const onboardingEl = $('onboarding');
const ONB_TOTAL_STEPS = 5;
const onbStepEls = Array.from({ length: ONB_TOTAL_STEPS }, (_, i) => $(`step-${i + 1}`));
const onbDotEls = Array.from({ length: ONB_TOTAL_STEPS }, (_, i) => $(`dot-${i + 1}`));
const onbNameInput = $('onb-name');
const onbStep1Next = $('onb-step1-next');
const onbStep2Next = $('onb-step2-next');
const onbStep3Next = $('onb-step3-next');
const onbStep4Next = $('onb-step4-next');
const onbStep5Next = $('onb-step5-next');
const onbRegionGrid = $('onb-region-grid');
const onbDetectedRegion = $('onb-detected-region');
const onbDetectedRegionValue = $('onb-detected-region-value');

let onbSelectedRegion = null;
let onbSelectedLang = null;
let onbSelectedGender = null;
let onbSelectedTargetGender = null;

function onbShowStep(n) {
  onbStepEls.forEach((el, i) => {
    if (el) el.classList.toggle('active', i === n - 1);
  });
  onbDotEls.forEach((dot, i) => {
    if (!dot) return;
    dot.classList.remove('active', 'done');
    if (i < n - 1) dot.classList.add('done');
    else if (i === n - 1) dot.classList.add('active');
  });
}

function onbBuildRegionGrid() {
  if (!onbRegionGrid) return;
  onbRegionGrid.innerHTML = BIG_REGIONS.map(r =>
    `<button class="grid-btn" data-region="${r.id}">${r.flag} ${r.name}</button>`
  ).join('');
  onbRegionGrid.querySelectorAll('.grid-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      onbRegionGrid.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onbSelectedRegion = btn.dataset.region;
      onbStep4Next.disabled = false;
    });
  });
}

async function onbDetectRegion() {
  try {
    const r = await fetch('/api/geo/me');
    const data = await r.json();
    if (data?.bigRegion) {
      const found = BIG_REGIONS.find(x => x.id === data.bigRegion);
      if (found && onbDetectedRegion) {
        onbDetectedRegion.style.display = 'block';
        onbDetectedRegionValue.textContent = `${found.flag} ${found.name}`;
        const btn = onbRegionGrid?.querySelector(`[data-region="${data.bigRegion}"]`);
        if (btn) {
          btn.classList.add('selected');
          onbSelectedRegion = data.bigRegion;
          onbStep4Next.disabled = false;
        }
      }
    }
  } catch (err) {
    log(`onb geo detect failed: ${err.message}`);
  }
}

function onbBuildLangGrid() {
  // Step 5 lang grid (only onboarding step-5 lang-grid buttons)
  document.querySelectorAll('#step-5 .lang-grid .grid-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#step-5 .lang-grid .grid-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onbSelectedLang = btn.dataset.lang;
      onbStep5Next.disabled = false;
    });
  });
  const detected = detectInitialLang();
  const btn = document.querySelector(`#step-5 .lang-grid .grid-btn[data-lang="${detected}"]`);
  if (btn) {
    btn.classList.add('selected');
    onbSelectedLang = detected;
    onbStep5Next.disabled = false;
  }
}

function onbWireGenderGrid() {
  // Step 2: gender
  document.querySelectorAll('.onb-gender-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.onb-gender-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onbSelectedGender = btn.dataset.gender;
      // 即時預覽主題色
      localStorage.setItem(ONB_GENDER_KEY, onbSelectedGender);
      applyGenderTheme();
      onbStep2Next.disabled = false;
    });
  });
  // Step 3: target gender
  document.querySelectorAll('.onb-target-gender-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.onb-target-gender-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      onbSelectedTargetGender = btn.dataset.tgender;
      onbStep3Next.disabled = false;
    });
  });
}

function onbStart() {
  if (!onboardingEl) return;
  onbBuildRegionGrid();
  onbBuildLangGrid();
  onbWireGenderGrid();
  onbShowStep(1);
  onboardingEl.classList.add('active');
  onbDetectRegion();
}

function onbFinish() {
  const name = onbNameInput.value.trim();
  if (!name) return;
  localStorage.setItem(ONB_NICKNAME_KEY, name);
  if (onbSelectedGender) localStorage.setItem(ONB_GENDER_KEY, onbSelectedGender);
  if (onbSelectedTargetGender) localStorage.setItem(ONB_TARGET_GENDER_KEY, onbSelectedTargetGender);
  localStorage.setItem(ONB_BIG_REGION_KEY, onbSelectedRegion);
  if (onbSelectedLang) localStorage.setItem('kaitalk.lang', onbSelectedLang);
  localStorage.setItem(ONB_DONE_KEY, 'true');

  onboardingEl.classList.remove('active');

  if (nameInput) {
    nameInput.value = name;
    nameInput.disabled = true;
    nameInput.title = '暱稱已鎖定（升級會員可修改）';
  }

  if (onbSelectedLang) {
    sttLang = onbSelectedLang;
    updateLangBtn();
  }

  updateStartBtnState();
  renderUserBar();
}

if (onbNameInput) {
  onbNameInput.addEventListener('input', () => {
    onbStep1Next.disabled = onbNameInput.value.trim().length === 0;
  });
}
onbStep1Next?.addEventListener('click', () => onbShowStep(2));
onbStep2Next?.addEventListener('click', () => onbShowStep(3));
onbStep3Next?.addEventListener('click', () => onbShowStep(4));
onbStep4Next?.addEventListener('click', () => onbShowStep(5));
onbStep5Next?.addEventListener('click', onbFinish);

// ─── Wire up ─────────────────────────────────────────
btnStart.addEventListener('click', () => startMatching({ mode: 'quick' }));
btnCancel.addEventListener('click', cancelMatching);
btnHangup.addEventListener('click', hangup);
btnMute.addEventListener('click', toggleMute);
btnSubtitle.addEventListener('click', toggleSubtitles);
langBtn.addEventListener('click', toggleLang);

// 封鎖 + 檢舉
document.getElementById('btn-block')?.addEventListener('click', blockCurrentPeer);
document.getElementById('btn-report')?.addEventListener('click', showReportOverlay);

// 檢舉 overlay 互動
const reportOverlay = document.getElementById('report-overlay');
reportOverlay?.querySelectorAll('.report-reason-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    reportOverlay.querySelectorAll('.report-reason-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const submitBtn = document.getElementById('btn-report-submit');
    if (submitBtn) submitBtn.disabled = false;
  });
});
document.getElementById('btn-report-submit')?.addEventListener('click', submitReport);
document.getElementById('btn-report-cancel')?.addEventListener('click', () => {
  reportOverlay?.classList.remove('active');
});


// 「附近配對」按鈕：用 onboarding 存的 myBigRegion 做為「同地區」
const btnNearby = document.getElementById('btn-nearby');
btnNearby?.addEventListener('click', () => {
  const myRegion = localStorage.getItem(ONB_BIG_REGION_KEY);
  if (!myRegion) {
    alert('請先完成設定（選擇你的地區）');
    return;
  }
  startMatching({ mode: 'nearby' });
});

// 「指定地方」按鈕：開 picker
const btnSpecific = document.getElementById('btn-specific');
const specificPicker = document.getElementById('specific-picker');
const specificRegionGrid = document.getElementById('specific-region-grid');
const btnSpecificConfirm = document.getElementById('btn-specific-confirm');
const btnSpecificCancel = document.getElementById('btn-specific-cancel');
let specificSelectedRegion = null;

function buildSpecificPicker() {
  if (!specificRegionGrid) return;
  specificRegionGrid.innerHTML = BIG_REGIONS.map(r =>
    `<button class="grid-btn" data-region="${r.id}">${r.flag} ${r.name}</button>`
  ).join('');
  specificRegionGrid.querySelectorAll('.grid-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      specificRegionGrid.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      specificSelectedRegion = btn.dataset.region;
      btnSpecificConfirm.disabled = false;
    });
  });
}
buildSpecificPicker();

btnSpecific?.addEventListener('click', () => {
  specificPicker?.classList.add('active');
  specificSelectedRegion = null;
  if (btnSpecificConfirm) btnSpecificConfirm.disabled = true;
  specificRegionGrid?.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('selected'));
});
btnSpecificCancel?.addEventListener('click', () => {
  specificPicker?.classList.remove('active');
});
btnSpecificConfirm?.addEventListener('click', () => {
  if (!specificSelectedRegion) return;
  specificPicker?.classList.remove('active');
  startMatching({ mode: 'specific', targetRegion: specificSelectedRegion });
});

// ── 對話紀錄（本機 localStorage）──
const HISTORY_KEY = 'kaitalk.chatHistory';
const HISTORY_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天
const HISTORY_MAX = 50; // 最多保存 50 筆對話

function saveConversationHistory() {
  // 只存有內容的 final 訊息（不存 interim）
  const messages = subtitleBuffer
    .filter(s => !s.interim && s.text)
    .map(s => ({
      speaker: s.speaker,
      text: s.text,
      lang: s.lang,
      translated: s.translated || null,
      ts: s.ts,
    }));
  if (messages.length === 0) return;

  // 找重逢碼（剛剛這通有沒有產生）
  let reunionCode = null;
  try {
    const codes = JSON.parse(localStorage.getItem('kaitalk.reunionCodes') || '[]');
    const match = codes.find(c => c.peerName === (peerName || '未知'));
    if (match) reunionCode = match.code;
  } catch {}

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    peerName: peerName || '未知',
    peerGender: peerGenderStored || null,
    peerRegion: peerRegionStored || null,
    peerLang: peerLang || null,
    reunionCode,
    myName: localStorage.getItem(ONB_NICKNAME_KEY) || '我',
    startedAt: messages[0]?.ts || Date.now(),
    endedAt: Date.now(),
    messageCount: messages.length,
    messages,
  };

  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    let history = raw ? JSON.parse(raw) : [];
    // 清掉過期的
    const now = Date.now();
    history = history.filter(h => now - h.endedAt < HISTORY_TTL);
    // 加新的
    history.unshift(entry);
    // 限制筆數
    if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    log(`📋 對話已保存（${messages.length} 則訊息）`);
  } catch (err) {
    log(`對話保存失敗: ${err.message}`);
  }
}

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const history = JSON.parse(raw);
    const now = Date.now();
    return history.filter(h => now - h.endedAt < HISTORY_TTL);
  } catch {
    return [];
  }
}

function renderBottomTabs() {
  const tabsEl = document.getElementById('bottom-tabs');
  if (!tabsEl) return;

  const history = getHistory();
  // 有歷史或已登入就顯示 tabs
  tabsEl.style.display = (history.length > 0 || kaitalkUserId) ? 'block' : 'none';

  renderHistoryTab(history);
  renderFriendsTab();
}

function renderHistoryTab(history) {
  const listEl = document.getElementById('history-list');
  if (!listEl) return;

  if (!history || history.length === 0) {
    listEl.innerHTML = '<div class="friends-empty">還沒有對話紀錄</div>';
    return;
  }

  listEl.innerHTML = history.map(h => {
    const date = new Date(h.endedAt);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
    const durationSec = Math.round((h.endedAt - h.startedAt) / 1000);
    const durationStr = durationSec < 60 ? `${durationSec}秒` : `${Math.floor(durationSec / 60)}分`;
    const regionObj = BIG_REGIONS.find(r => r.id === h.peerRegion);
    const regionTag = regionObj ? `<span class="tag tag-blue">${regionObj.flag} ${regionObj.name}</span>` : '';
    const li = h.peerLang ? langInfo(h.peerLang) : null;
    const langTag = li ? `<span class="tag tag-red">${li.flag} ${li.label}</span>` : '';
    const gIcon = GENDER_ICONS[h.peerGender] || '';
    return `
      <div class="history-item" data-id="${h.id}">
        <div class="hi-row">
          <div class="hi-avatar">${gIcon || '👤'}</div>
          <div class="hi-info">
            <div class="hi-name">${escapeHtml(h.peerName)}</div>
            <div class="hi-tags">${regionTag}${langTag}</div>
          </div>
          <div class="hi-right">
            <span class="hi-date">${dateStr}</span>
            <span class="hi-meta">${durationStr} · ${h.messageCount}則</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      const h = history.find(x => x.id === id);
      if (h) showHistoryDetail(h);
    });
  });
}

async function renderFriendsTab() {
  const listEl = document.getElementById('friends-list');
  if (!listEl) return;

  if (!kaitalkAccessToken) {
    listEl.innerHTML = '<div class="friends-empty">登入後可查看好友</div>';
    return;
  }

  listEl.innerHTML = '<div class="friends-empty">載入中...</div>';

  try {
    const resp = await fetch('/api/friends', {
      headers: { 'Authorization': `Bearer ${kaitalkAccessToken}` },
    });
    const data = await resp.json();
    const friends = data.friends || [];

    if (friends.length === 0) {
      listEl.innerHTML = '<div class="friends-empty">還沒有好友<br><span style="font-size:11px;">通話時互按「💚 想再遇」就能成為好友</span></div>';
      return;
    }

    listEl.innerHTML = friends.map(f => {
      const codeHtml = f.reunionCode
        ? `<span style="font-family:ui-monospace;letter-spacing:0.1em;color:var(--primary);font-weight:700;">${f.reunionCode}</span>`
        : '';
      return `
        <div class="friend-item" data-code="${f.reunionCode || ''}" data-name="${escapeHtml(f.friendName)}">
          <div class="fi-row">
            <div class="fi-avatar">👤</div>
            <div class="fi-info">
              <div class="fi-name">${escapeHtml(f.friendName)}</div>
              <div class="fi-meta">聊過 ${f.callCount} 次 ${codeHtml}</div>
            </div>
            <div class="fi-actions">
              <button class="fi-btn fi-btn-call" data-code="${f.reunionCode || ''}">📞</button>
              <button class="fi-btn fi-btn-mail" data-friend-id="${f.friendId}" data-friend-name="${escapeHtml(f.friendName)}">✉️</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // 一鍵再次通話
    listEl.querySelectorAll('.fi-btn-call').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = btn.dataset.code;
        if (code) {
          startMatching({ mode: 'quick', reunionCode: code });
        }
      });
    });

    // 寫信
    listEl.querySelectorAll('.fi-btn-mail').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openLetterThread(btn.dataset.friendId, btn.dataset.friendName);
      });
    });
  } catch (err) {
    listEl.innerHTML = '<div class="friends-empty">載入失敗</div>';
  }
}

// ─── 信件系統 ─────────────────────────────────────

async function openLetterThread(friendId, friendName) {
  const overlay = document.getElementById('letter-overlay');
  const contentEl = overlay?.querySelector('.letter-overlay-content');
  if (!overlay || !contentEl) return;

  contentEl.innerHTML = `
    <div class="letter-header">
      <h3>✉️ 與 ${escapeHtml(friendName)} 的信件</h3>
    </div>
    <div class="letter-messages" id="letter-messages"><div class="friends-empty">載入中...</div></div>
    <div class="letter-compose">
      <textarea id="letter-input" class="letter-input" placeholder="寫封信..." maxlength="500" rows="2"></textarea>
      <button id="btn-letter-send" class="btn-primary" style="margin-top:8px;">寄出</button>
    </div>
    <button class="btn-secondary" id="btn-letter-close" style="margin-top:8px;">關閉</button>
  `;

  overlay.classList.add('active');

  // 載入信件
  try {
    const resp = await fetch(`/api/letters/thread/${friendId}`, {
      headers: { 'Authorization': `Bearer ${kaitalkAccessToken}` },
    });
    const data = await resp.json();
    const msgsEl = document.getElementById('letter-messages');
    const msgs = data.messages || [];

    if (msgs.length === 0) {
      msgsEl.innerHTML = '<div class="friends-empty">還沒有信件<br><span style="font-size:11px;">寫第一封信給對方吧</span></div>';
    } else {
      msgsEl.innerHTML = msgs.map(m => {
        const isMine = m.from_uid === kaitalkUserId;
        const time = new Date(m.created_at).toLocaleString('zh-TW', { month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit' });
        return `
          <div class="letter-msg ${isMine ? 'self' : 'peer'}">
            <div class="letter-bubble">${escapeHtml(m.body)}</div>
            <div class="letter-time">${time}</div>
          </div>
        `;
      }).join('');
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  } catch {
    document.getElementById('letter-messages').innerHTML = '<div class="friends-empty">載入失敗</div>';
  }

  // 寄信
  document.getElementById('btn-letter-send')?.addEventListener('click', async () => {
    const input = document.getElementById('letter-input');
    const body = input?.value?.trim();
    if (!body) return;

    const resp = await fetch('/api/letters/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${kaitalkAccessToken}`,
      },
      body: JSON.stringify({ toUid: friendId, body, lang: sttLang }),
    });
    const result = await resp.json();

    if (result.ok) {
      input.value = '';
      openLetterThread(friendId, friendName); // 重新載入
    } else if (result.error === 'daily_limit') {
      log('⚠️ 今日寄信已達上限（3 封）');
    } else {
      log(`⚠️ 寄信失敗: ${result.error || result.message || ''}`);
    }
  });

  document.getElementById('btn-letter-close')?.addEventListener('click', () => {
    overlay.classList.remove('active');
  });
}

// Tab 切換
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-history').style.display = tab === 'history' ? 'block' : 'none';
    document.getElementById('tab-friends').style.display = tab === 'friends' ? 'block' : 'none';
    if (tab === 'friends') renderFriendsTab();
  });
});

function deleteHistoryById(id) {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return;
    let history = JSON.parse(raw);
    history = history.filter(h => h.id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {}
}

function showHistoryDetail(h) {
  const overlay = document.getElementById('history-overlay');
  const contentEl = overlay?.querySelector('.history-overlay-content');
  if (!overlay || !contentEl) return;

  const regionObj = BIG_REGIONS.find(r => r.id === h.peerRegion);
  const regionTag = regionObj ? `${regionObj.flag} ${regionObj.name}` : '';
  const li = h.peerLang ? langInfo(h.peerLang) : null;
  const langTag = li ? `${li.flag} ${li.label}` : '';
  const gIcon = GENDER_ICONS[h.peerGender] || '';

  const msgs = h.messages.map(m => {
    const label = m.speaker === 'self' ? '你' : h.peerName;
    const mli = langInfo(m.lang || 'unknown');
    const transHtml = m.translated ? `<div class="hd-trans">↳ ${escapeHtml(m.translated)}</div>` : '';
    return `
      <div class="hd-msg ${m.speaker}">
        <div class="hd-bubble">
          <div class="hd-text">${escapeHtml(m.text)}</div>
          ${transHtml}
        </div>
        <div class="hd-label">${mli.flag} ${escapeHtml(label)}</div>
      </div>
    `;
  }).join('');

  contentEl.innerHTML = `
    <div class="hd-header">
      <span class="hd-avatar">${gIcon || '👤'}</span>
      <span class="hd-name">${escapeHtml(h.peerName)}</span>
      <span class="hd-info">${regionTag} ${langTag}</span>
    </div>
    ${h.reunionCode ? `
    <div class="hd-reunion">
      <span class="hd-reunion-label">💌 重逢碼</span>
      <span class="hd-reunion-code">${h.reunionCode}</span>
      <button class="btn-reunion-use" id="btn-reunion-use">用此碼配對</button>
    </div>` : ''}
    <div class="hd-messages">${msgs}</div>
    <div class="hd-actions">
      <button class="btn-secondary" id="btn-history-close">關閉</button>
      <button class="btn-danger-small" id="btn-history-delete">🗑️ 刪除紀錄</button>
    </div>
  `;

  overlay.classList.add('active');
  document.getElementById('btn-history-close')?.addEventListener('click', () => {
    overlay.classList.remove('active');
  });
  document.getElementById('btn-reunion-use')?.addEventListener('click', () => {
    overlay.classList.remove('active');
    startMatching({ mode: 'quick', reunionCode: h.reunionCode });
  });
  document.getElementById('btn-history-delete')?.addEventListener('click', async () => {
    const yes = await showConfirm({
      icon: '🗑️',
      text: `刪除與 ${h.peerName} 的對話紀錄？`,
      okLabel: '刪除',
      cancelLabel: '取消',
    });
    if (yes) {
      deleteHistoryById(h.id);
      overlay.classList.remove('active');
      renderBottomTabs();
    }
  });
}

// ── 文字訊息（打字送出）──
const chatInputBar = document.getElementById('chat-input-bar');
const chatInput = document.getElementById('chat-input');
const btnChatSend = document.getElementById('btn-chat-send');

function sendChatMessage() {
  if (!chatInput || !chatInput.value.trim()) return;
  const text = chatInput.value.trim();
  chatInput.value = '';

  // 顯示在自己這邊
  addSubtitle('self', text, sttLang, false);

  // 透過 DataChannel 傳給對方
  if (subtitleDC && subtitleDC.readyState === 'open') {
    try {
      subtitleDC.send(JSON.stringify({
        type: 'chat',
        v: 1,
        data: { text, lang: sttLang, ts: Date.now() },
      }));
    } catch (err) {
      log(`文字送出失敗: ${err.message}`);
    }
  }
}

btnChatSend?.addEventListener('click', sendChatMessage);
chatInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// ── 想再遇按鈕 ──
const btnMeetAgain = document.getElementById('btn-meet-again');
btnMeetAgain?.addEventListener('click', () => {
  if (btnMeetAgain.classList.contains('pressed')) return; // 只能按一次
  socket.emit('meet_again');
  btnMeetAgain.textContent = '💚 已標記想再遇';
  btnMeetAgain.classList.add('pressed');
  btnMeetAgain.disabled = true;
  log(`💚 已送出想再遇`);
});

// ── 互相想再遇 overlay 關閉 ──
document.getElementById('btn-mutual-ok')?.addEventListener('click', () => {
  document.getElementById('mutual-match-overlay')?.classList.remove('active');
});

// ─── Settings overlay ─────────────────────────────────
//
// 點齒輪 icon 開設定，可以改：
//   - 我的地區（更新 localStorage 的 myBigRegion）
//   - 我的語言（更新 sttLang + localStorage）
// 暱稱顯示在 read-only 區，要改要付費（之後接 paywall）
const btnSettings = document.getElementById('btn-settings');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsNicknameDisplay = document.getElementById('settings-nickname-display');
const settingsRegionGrid = document.getElementById('settings-region-grid');
const btnSettingsSave = document.getElementById('btn-settings-save');
const btnSettingsCancel = document.getElementById('btn-settings-cancel');

let settingsTempRegion = null;
let settingsTempLang = null;
let settingsTempGender = null;
let settingsTempTargetGender = null;
let settingsTempAvatar = null;
let settingsTempTargetLangs = [];

function buildSettingsRegionGrid() {
  if (!settingsRegionGrid) return;
  settingsRegionGrid.innerHTML = BIG_REGIONS.map(r =>
    `<button class="grid-btn" data-region="${r.id}">${r.flag} ${r.name}</button>`
  ).join('');
  settingsRegionGrid.querySelectorAll('.grid-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settingsRegionGrid.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      settingsTempRegion = btn.dataset.region;
    });
  });
}
buildSettingsRegionGrid();

function wireSettingsLangButtons() {
  document.querySelectorAll('.settings-lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-lang-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      settingsTempLang = btn.dataset.lang;
    });
  });
}
wireSettingsLangButtons();

function wireSettingsAvatarButtons() {
  document.querySelectorAll('.avatar-option').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.avatar-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      settingsTempAvatar = btn.dataset.avatar;
    });
  });
}
wireSettingsAvatarButtons();

// Wire settings gender buttons
document.querySelectorAll('.settings-gender-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.settings-gender-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    settingsTempGender = btn.dataset.gender;
  });
});
document.querySelectorAll('.settings-tgender-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.settings-tgender-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    settingsTempTargetGender = btn.dataset.tgender;
  });
});

// 想找講什麼語言（多選 toggle）
document.querySelectorAll('.settings-target-lang-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('selected');
    const lang = btn.dataset.tlang;
    if (btn.classList.contains('selected')) {
      if (!settingsTempTargetLangs.includes(lang)) settingsTempTargetLangs.push(lang);
    } else {
      settingsTempTargetLangs = settingsTempTargetLangs.filter(l => l !== lang);
    }
  });
});

function openSettings() {
  if (!settingsOverlay) return;

  // 顯示當前暱稱
  if (settingsNicknameDisplay) {
    settingsNicknameDisplay.textContent = localStorage.getItem(ONB_NICKNAME_KEY) || '（未設定）';
  }

  // 預選當前頭像
  const curAvatar = localStorage.getItem(ONB_AVATAR_KEY) || 'avatar_mature.png';
  settingsTempAvatar = curAvatar;
  document.querySelectorAll('.avatar-option').forEach(b => {
    b.classList.toggle('selected', b.dataset.avatar === curAvatar);
  });

  // 預選當前性別
  const curGender = localStorage.getItem(ONB_GENDER_KEY);
  settingsTempGender = curGender;
  document.querySelectorAll('.settings-gender-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.gender === curGender);
  });
  const curTGender = localStorage.getItem(ONB_TARGET_GENDER_KEY);
  settingsTempTargetGender = curTGender;
  document.querySelectorAll('.settings-tgender-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.tgender === curTGender);
  });

  // 預選當前地區
  const currentRegion = localStorage.getItem(ONB_BIG_REGION_KEY);
  settingsTempRegion = currentRegion;
  settingsRegionGrid?.querySelectorAll('.grid-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.region === currentRegion);
  });

  // 預選當前語言
  settingsTempLang = sttLang;
  document.querySelectorAll('.settings-lang-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.lang === sttLang);
  });

  // 預選想找的語言（多選）
  const curTargetLangs = getTargetLangs();
  settingsTempTargetLangs = [...curTargetLangs];
  document.querySelectorAll('.settings-target-lang-btn').forEach(b => {
    b.classList.toggle('selected', curTargetLangs.includes(b.dataset.tlang));
  });

  settingsOverlay.classList.add('active');
}

function closeSettings() {
  settingsOverlay?.classList.remove('active');
}

function saveSettings() {
  // 儲存性別
  if (settingsTempGender) localStorage.setItem(ONB_GENDER_KEY, settingsTempGender);
  if (settingsTempTargetGender) localStorage.setItem(ONB_TARGET_GENDER_KEY, settingsTempTargetGender);

  // 儲存頭像
  if (settingsTempAvatar) localStorage.setItem(ONB_AVATAR_KEY, settingsTempAvatar);

  // 儲存地區
  if (settingsTempRegion) localStorage.setItem(ONB_BIG_REGION_KEY, settingsTempRegion);

  // 儲存語言並重啟 STT 套用
  if (settingsTempLang && settingsTempLang !== sttLang) {
    sttLang = settingsTempLang;
    localStorage.setItem('kaitalk.lang', sttLang);
    updateLangBtn();
    if (sttActive) {
      stopSTT();
      setTimeout(() => startSTT(), 200);
    }
  }

  // 儲存想找的語言
  if (settingsTempTargetLangs.length === 0) {
    localStorage.removeItem(TARGET_LANGS_KEY);
  } else {
    localStorage.setItem(TARGET_LANGS_KEY, JSON.stringify(settingsTempTargetLangs));
  }

  log(`設定已儲存`);
  closeSettings();
  renderUserBar();
}

btnSettings?.addEventListener('click', openSettings);
btnSettingsCancel?.addEventListener('click', closeSettings);
btnSettingsSave?.addEventListener('click', saveSettings);

// ─── User bar 渲染（暱稱 + 地區 + 語言）─────────────
const userBarEl = document.getElementById('user-bar');
const userBarNameEl = document.getElementById('user-bar-name');
const userBarRegionEl = document.getElementById('user-bar-region');
const userBarLangEl = document.getElementById('user-bar-lang');

function applyGenderTheme() {
  const gender = localStorage.getItem(ONB_GENDER_KEY);
  if (gender === 'female') {
    document.documentElement.dataset.theme = 'female';
  } else if (gender === 'male') {
    document.documentElement.dataset.theme = 'male';
  } else {
    delete document.documentElement.dataset.theme; // 中性
  }
}

function renderUserBar() {
  if (!userBarEl) return;
  applyGenderTheme();

  // 暱稱（純名字，不帶性別 icon — icon 在 avatar 圈裡）
  const name = localStorage.getItem(ONB_NICKNAME_KEY) || '—';
  const gender = localStorage.getItem(ONB_GENDER_KEY);
  const gIcon = GENDER_ICONS[gender] || '👤';
  if (userBarNameEl) userBarNameEl.textContent = name;

  // Avatar image
  const avatarImgEl = document.getElementById('avatar-img');
  if (avatarImgEl) {
    const chosenAvatar = localStorage.getItem(ONB_AVATAR_KEY) || 'avatar_mature.png';
    avatarImgEl.src = '/' + chosenAvatar;
    const avatarTransforms = {
      'avatar_mature.png':   'scale(1.1) translateY(2%)',
      'avatar_sporty.png':   'scale(1.4) translateY(10%)',
      'avatar_elegant.png':  'scale(1.2) translateY(5%)',
      'avatar_shorthair.png':'scale(1.1) translateY(3%)',
      'avatar_older_m.png':  'scale(1.15) translateY(3%)',
      'avatar_older_f.png':  'scale(1.2) translateY(5%)',
      'avatar_idol_m.png':   'scale(1.0) translateY(0)',
      'avatar_idol_f.png':   'scale(1.15) translateY(4%)',
    };
    avatarImgEl.style.transform = avatarTransforms[chosenAvatar] || 'scale(1) translateY(0)';
  }

  // 地區
  const regionId = localStorage.getItem(ONB_BIG_REGION_KEY);
  if (userBarRegionEl) {
    if (regionId) {
      const r = BIG_REGIONS.find(x => x.id === regionId);
      userBarRegionEl.textContent = r ? `${r.flag} ${r.name}` : `📍 ${regionId}`;
      userBarRegionEl.classList.remove('unset');
    } else {
      userBarRegionEl.textContent = '📍 點此設定';
      userBarRegionEl.classList.add('unset');
    }
  }

  // 語言
  if (userBarLangEl) {
    const li = langInfo(sttLang);
    userBarLangEl.textContent = `${li.flag} ${li.label}`;
  }

  // 想找（性別 + 語言）
  const targetEl = document.getElementById('user-bar-target');
  if (targetEl) {
    const tg = localStorage.getItem(ONB_TARGET_GENDER_KEY) || 'any';
    const tgLabel = tg === 'male' ? '👨 男生' : tg === 'female' ? '👩 女生' : '😊 都可以';
    targetEl.textContent = `想找：${tgLabel}`;
  }
  const tlEl = document.getElementById('target-lang-value');
  if (tlEl) {
    const tl = getTargetLangs();
    if (tl.length === 0) {
      tlEl.textContent = '所有語言';
    } else {
      tlEl.textContent = tl.map(c => langInfo(c).flag).join(' ');
    }
  }
}

// 整列可點 → 直接開設定 overlay
userBarEl?.addEventListener('click', openSettings);
userBarEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openSettings();
  }
});

// ─── 「想找講語言」過濾 ─────────────────────────────
//
// 用戶選的目標語言陣列存在 localStorage。
// 配對時送進 server，server 在 isCompatible 多檢查一條：
//   「對方的 lang 必須在我的 targetLangs 內」（或我的 targetLangs 是空 = 不過濾）
//
// 預設空陣列 = 不過濾 = 跟現在行為一樣（不破壞既有用戶）

const TARGET_LANGS_KEY = 'kaitalk.targetLangs';

function getTargetLangs() {
  try {
    const raw = localStorage.getItem(TARGET_LANGS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function setTargetLangs(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    localStorage.removeItem(TARGET_LANGS_KEY);
  } else {
    localStorage.setItem(TARGET_LANGS_KEY, JSON.stringify(arr));
  }
}

const targetLangBarEl = document.getElementById('target-lang-bar');
const targetLangValueEl = document.getElementById('target-lang-value');
const targetLangPicker = document.getElementById('target-lang-picker');
const targetLangGrid = document.getElementById('target-lang-grid');
const btnTargetLangSave = document.getElementById('btn-target-lang-save');
const btnTargetLangCancel = document.getElementById('btn-target-lang-cancel');
const btnTargetLangClear = document.getElementById('btn-target-lang-clear');

let pickerSelectedLangs = [];

function renderTargetLangBar() {
  if (!targetLangValueEl) return;
  const langs = getTargetLangs();
  if (langs.length === 0) {
    targetLangValueEl.textContent = '所有語言';
  } else {
    // 列出國旗
    const flags = langs.map(code => langInfo(code).flag).join(' ');
    targetLangValueEl.textContent = flags;
  }
}

function applyPickerSelection() {
  if (!targetLangGrid) return;
  targetLangGrid.querySelectorAll('.target-lang-btn').forEach(btn => {
    const selected = pickerSelectedLangs.includes(btn.dataset.lang);
    btn.classList.toggle('selected', selected);
  });
}

function openTargetLangPicker() {
  if (!targetLangPicker) return;
  // 預載當前選擇
  pickerSelectedLangs = [...getTargetLangs()];
  applyPickerSelection();
  targetLangPicker.classList.add('active');
}

function closeTargetLangPicker() {
  targetLangPicker?.classList.remove('active');
}

function saveTargetLangs() {
  setTargetLangs(pickerSelectedLangs);
  renderTargetLangBar();
  closeTargetLangPicker();
  log(`想找講語言: ${pickerSelectedLangs.length === 0 ? '所有語言' : pickerSelectedLangs.join(', ')}`);
}

// Wire 上 picker 的按鈕 click 行為（支援多選 toggle）
targetLangGrid?.querySelectorAll('.target-lang-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const code = btn.dataset.lang;
    const idx = pickerSelectedLangs.indexOf(code);
    if (idx >= 0) {
      pickerSelectedLangs.splice(idx, 1);
    } else {
      pickerSelectedLangs.push(code);
    }
    applyPickerSelection();
  });
});

targetLangBarEl?.addEventListener('click', openTargetLangPicker);
targetLangBarEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openTargetLangPicker();
  }
});

btnTargetLangSave?.addEventListener('click', saveTargetLangs);
btnTargetLangCancel?.addEventListener('click', closeTargetLangPicker);
btnTargetLangClear?.addEventListener('click', () => {
  pickerSelectedLangs = [];
  applyPickerSelection();
});

// 暱稱：強迫輸入 + localStorage 持久化（onboarding 完成後 disable）
const NICKNAME_KEY = ONB_NICKNAME_KEY; // 同 key
const savedNickname = localStorage.getItem(NICKNAME_KEY) || '';
if (savedNickname) nameInput.value = savedNickname;

// 既有用戶 (onboarding 已做過)：暱稱直接鎖
const onboardingDone = localStorage.getItem(ONB_DONE_KEY) === 'true';
if (onboardingDone && savedNickname) {
  nameInput.disabled = true;
  nameInput.title = '暱稱已鎖定（升級會員可修改）';
}

function updateStartBtnState() {
  // 讀 localStorage 的暱稱（input 已 hide）
  const stored = (localStorage.getItem(NICKNAME_KEY) || '').trim();
  // 兼容：如果 input 還在顯示（例如 onboarding 還沒做完的舊 path），也讀它
  const fromInput = nameInput && !nameInput.disabled && nameInput.value
    ? nameInput.value.trim()
    : '';
  const v = stored || fromInput;
  const empty = v.length === 0;
  btnStart.disabled = empty;
  if (btnNearby) btnNearby.disabled = empty;
  if (btnSpecific) btnSpecific.disabled = empty;
}
nameInput.addEventListener('input', () => {
  const v = nameInput.value.trim();
  if (v) localStorage.setItem(NICKNAME_KEY, v);
  updateStartBtnState();
});
updateStartBtnState();

// 主畫面初始化：渲染 user bar + target lang bar
renderUserBar();
renderTargetLangBar();

// ─── 豆知識破冰 ────────────────────────────────────
// 配對成功時顯示隨機一張，給兩個陌生人一個話題開頭
let triviaData = [];

async function loadTrivia() {
  try {
    const r = await fetch('/content/trivia.json');
    triviaData = await r.json();
    log(`📚 載入 ${triviaData.length} 條豆知識`);
  } catch (err) {
    log(`豆知識載入失敗: ${err.message}`);
  }
}

function showRandomTrivia(myRegion, peerRegion) {
  const cardEl = document.getElementById('trivia-card');
  const headerEl = cardEl?.querySelector('.trivia-header');
  const zhEl = document.getElementById('trivia-text-zh');
  const jaEl = document.getElementById('trivia-text-ja');
  if (!cardEl || !zhEl || !jaEl || triviaData.length === 0) return;

  // 1. 先找跟兩人地區相關的 trivia
  let pool = [];
  let headerText = '💡 今日話題';

  if (myRegion || peerRegion) {
    pool = triviaData.filter(t =>
      Array.isArray(t.regions) && t.regions.length > 0 &&
      t.regions.some(r => r === myRegion || r === peerRegion)
    );
  }

  if (pool.length > 0) {
    // 有在地化的 → 用在地化的，標出「關於 XX」
    const item = pool[Math.floor(Math.random() * pool.length)];
    // 判斷是哪個地區的
    const matchedRegion = item.regions.find(r => r === myRegion || r === peerRegion);
    const regionInfo = BIG_REGIONS.find(r => r.id === matchedRegion);
    if (regionInfo) {
      headerText = `💡 關於 ${regionInfo.flag} ${regionInfo.name}`;
    }
    zhEl.textContent = item.zh;
    jaEl.textContent = item.ja;
  } else {
    // 沒在地化的 → fallback 到通用池
    const universal = triviaData.filter(t => !t.regions || t.regions.length === 0);
    const fallback = universal.length > 0 ? universal : triviaData;
    const item = fallback[Math.floor(Math.random() * fallback.length)];
    zhEl.textContent = item.zh;
    jaEl.textContent = item.ja;
  }

  if (headerEl) headerEl.textContent = headerText;
  cardEl.classList.add('active');
}

function hideTrivia() {
  const cardEl = document.getElementById('trivia-card');
  if (cardEl) cardEl.classList.remove('active');
}

loadTrivia();
renderBottomTabs();
applyGenderTheme();

// 沒做過 onboarding → 顯示
if (!onboardingDone) {
  onbStart();
}

// 初始化按鈕（用偵測到的或記住的設定）
updateLangBtn();
updateSubtitleBtn();

if (!isSTTSupported()) {
  log('⚠️ 此瀏覽器不支援即時字幕（請用 Chrome / Edge / Safari）');
}

setStatus('連接 server...');

// 先做匿名 Auth，再連 socket
// initSupabaseAnonAuth() 是 graceful 的，任何失敗都會 fallback 到「沒 token」
// 連線本身永遠會發生
initSupabaseAnonAuth().finally(() => {
  connectSocket();
});
