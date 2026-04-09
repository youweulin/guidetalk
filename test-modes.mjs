/**
 * test-modes.mjs — 驗證 quick/nearby/specific 三種配對模式
 *
 * 跑法：
 *   cd /Users/kevinlin911/kaitalk/app
 *   node --env-file=.env.local test-modes.mjs
 *
 * 測試案例：
 *   1. quick + quick 應該配上
 *   2. nearby + nearby 同區應該配上
 *   3. nearby + nearby 不同區應該 NOT 配上
 *   4. specific(target=jp-kanto) + nearby(在 jp-kanto) 應該配上
 *   5. specific(target=jp-kanto) + specific(target=tw-north) 不應該配上（除非雙方剛好都符合）
 */

import { io } from 'socket.io-client';

const URL = 'http://localhost:9001';

function makeClient(label) {
  return new Promise((resolve, reject) => {
    const sock = io(URL, { transports: ['websocket'] });
    sock.on('connect', () => resolve({ sock, id: sock.id, label }));
    sock.on('connect_error', reject);
  });
}

function findMatch(client, payload) {
  return new Promise((resolve) => {
    let resolved = false;
    const settle = (status) => {
      if (resolved) return;
      resolved = true;
      resolve(status);
    };
    client.sock.on('match_found', () => settle('matched'));
    client.sock.on('match_queued', () => settle('queued'));
    client.sock.emit('find_match', payload);
    setTimeout(() => settle('timeout'), 1500);
  });
}

async function reset() {
  // 簡單等一下讓 server 處理完上一輪
  await new Promise(r => setTimeout(r, 200));
}

async function test1_quick_quick() {
  console.log('\n▶ Test 1: quick + quick → 應該配上');
  const a = await makeClient('A');
  const b = await makeClient('B');

  const ra = findMatch(a, { name: 'A1', mode: 'quick' });
  await new Promise(r => setTimeout(r, 50));
  const rb = findMatch(b, { name: 'B1', mode: 'quick' });

  const [ra_, rb_] = await Promise.all([ra, rb]);
  console.log(`  A: ${ra_}, B: ${rb_}`);
  const ok = ra_ === 'matched' || rb_ === 'matched';
  console.log(`  ${ok ? '✅' : '❌'} 兩人配上`);
  a.sock.disconnect(); b.sock.disconnect();
  return ok;
}

async function test2_nearby_same_region() {
  console.log('\n▶ Test 2: nearby + nearby 同區（tw-north）→ 應該配上');
  const a = await makeClient('A');
  const b = await makeClient('B');

  const ra = findMatch(a, { name: 'A2', mode: 'nearby', myBigRegion: 'tw-north' });
  await new Promise(r => setTimeout(r, 50));
  const rb = findMatch(b, { name: 'B2', mode: 'nearby', myBigRegion: 'tw-north' });

  const [ra_, rb_] = await Promise.all([ra, rb]);
  console.log(`  A: ${ra_}, B: ${rb_}`);
  const ok = ra_ === 'matched' || rb_ === 'matched';
  console.log(`  ${ok ? '✅' : '❌'} 兩人配上`);
  a.sock.disconnect(); b.sock.disconnect();
  return ok;
}

async function test3_nearby_diff_region() {
  console.log('\n▶ Test 3: nearby + nearby 不同區（tw-north vs jp-kanto）→ 不應該配上');
  const a = await makeClient('A');
  const b = await makeClient('B');

  const ra = findMatch(a, { name: 'A3', mode: 'nearby', myBigRegion: 'tw-north' });
  await new Promise(r => setTimeout(r, 50));
  const rb = findMatch(b, { name: 'B3', mode: 'nearby', myBigRegion: 'jp-kanto' });

  const [ra_, rb_] = await Promise.all([ra, rb]);
  console.log(`  A: ${ra_}, B: ${rb_}`);
  // 兩人都應該是 queued 或 timeout（沒配上）
  const ok = ra_ !== 'matched' && rb_ !== 'matched';
  console.log(`  ${ok ? '✅' : '❌'} 不配對（正確）`);
  a.sock.disconnect(); b.sock.disconnect();
  return ok;
}

async function test4_specific_targets_other_nearby() {
  console.log('\n▶ Test 4: A specific(target=jp-kanto) + B nearby(在 jp-kanto) → 應該配上');
  const a = await makeClient('A');
  const b = await makeClient('B');

  const ra = findMatch(a, { name: 'A4', mode: 'specific', myBigRegion: 'tw-north', targetRegion: 'jp-kanto' });
  await new Promise(r => setTimeout(r, 50));
  // B 在 jp-kanto 用 nearby 模式 → 接受同區的 → 但 A 在 tw-north 不是同區
  // 所以 B 不會接受 A → 不應配上 (這 test 實際上應該驗證的是「nearby 不接受對方不在同區」)
  // 換成 B 用 quick 模式（A 找 jp-kanto，B 在 jp-kanto 用 quick）→ 應該配上
  const rb = findMatch(b, { name: 'B4', mode: 'quick', myBigRegion: 'jp-kanto' });

  const [ra_, rb_] = await Promise.all([ra, rb]);
  console.log(`  A: ${ra_}, B: ${rb_}`);
  const ok = ra_ === 'matched' || rb_ === 'matched';
  console.log(`  ${ok ? '✅' : '❌'} A specific + B quick(剛好在 A 目標區) 配上`);
  a.sock.disconnect(); b.sock.disconnect();
  return ok;
}

async function test5_specific_mismatch() {
  console.log('\n▶ Test 5: A specific(target=jp-kanto) + B specific(target=tw-north) 互相想去對方 → 應該配上');
  const a = await makeClient('A');
  const b = await makeClient('B');

  const ra = findMatch(a, { name: 'A5', mode: 'specific', myBigRegion: 'tw-north', targetRegion: 'jp-kanto' });
  await new Promise(r => setTimeout(r, 50));
  const rb = findMatch(b, { name: 'B5', mode: 'specific', myBigRegion: 'jp-kanto', targetRegion: 'tw-north' });

  const [ra_, rb_] = await Promise.all([ra, rb]);
  console.log(`  A: ${ra_}, B: ${rb_}`);
  const ok = ra_ === 'matched' || rb_ === 'matched';
  console.log(`  ${ok ? '✅' : '❌'} 互相想去對方 → 配上`);
  a.sock.disconnect(); b.sock.disconnect();
  return ok;
}

// ─── Run all ───
console.log('🧪 kaitalk 三模式配對測試\n   ─────────────────────');

const results = [];
results.push(await test1_quick_quick());
await reset();
results.push(await test2_nearby_same_region());
await reset();
results.push(await test3_nearby_diff_region());
await reset();
results.push(await test4_specific_targets_other_nearby());
await reset();
results.push(await test5_specific_mismatch());

const passed = results.filter(Boolean).length;
console.log(`\n──────────────────────`);
console.log(`${passed}/${results.length} 通過`);

process.exit(passed === results.length ? 0 : 1);
