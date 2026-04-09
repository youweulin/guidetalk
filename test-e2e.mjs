/**
 * End-to-end test: 模擬兩個客戶端做完整 kaitalk 配對 + WebRTC 訊令交換
 *
 * 證明：
 *   1. 兩人配對成功
 *   2. host 發 fake offer → server 轉到 guest
 *   3. guest 回 fake answer → server 轉回 host
 *   4. ICE candidates 雙向交換
 *   5. 對方掛斷可以正常通知
 *
 * 不需要瀏覽器，純 Node 跑。
 */

import { io } from 'socket.io-client';

const URL = 'http://localhost:9001';

const events = [];
const log = (who, what) => {
  const line = `${who.padEnd(6)} → ${what}`;
  events.push(line);
  console.log(`  ${line}`);
};

const alice = io(URL, { transports: ['websocket'] });
const bob = io(URL, { transports: ['websocket'] });

let aliceState = { peerId: null, isHost: false };
let bobState = { peerId: null, isHost: false };

function attachClient(client, state, name) {
  client.on('match_queued', ({ position }) => {
    log(name, `queued at #${position}`);
  });

  client.on('match_found', ({ roomCode, isHost, peer }) => {
    state.peerId = peer.id;
    state.isHost = isHost;
    log(name, `match_found! room=${roomCode} isHost=${isHost} peer=${peer.name}`);

    if (isHost) {
      // 模擬 createOffer + setLocalDescription + emit
      const fakeOffer = { type: 'offer', sdp: 'v=0\r\no=fake-host\r\n...' };
      client.emit('webrtc_signal', { target: state.peerId, signal: fakeOffer });
      log(name, `sent fake OFFER`);

      // 模擬 ICE candidate
      setTimeout(() => {
        client.emit('webrtc_signal', {
          target: state.peerId,
          signal: { candidate: 'candidate:fake-host-1', sdpMid: '0', sdpMLineIndex: 0 },
        });
        log(name, `sent fake ICE candidate`);
      }, 50);
    }
  });

  client.on('webrtc_signal', ({ from, signal }) => {
    if (signal.type === 'offer') {
      log(name, `received OFFER from ${from.slice(0, 8)}`);
      // 模擬 setRemoteDescription + createAnswer
      const fakeAnswer = { type: 'answer', sdp: 'v=0\r\no=fake-guest\r\n...' };
      client.emit('webrtc_signal', { target: from, signal: fakeAnswer });
      log(name, `sent fake ANSWER`);

      // 模擬 guest 也送 ICE
      setTimeout(() => {
        client.emit('webrtc_signal', {
          target: from,
          signal: { candidate: 'candidate:fake-guest-1', sdpMid: '0', sdpMLineIndex: 0 },
        });
        log(name, `sent fake ICE candidate`);
      }, 50);
    } else if (signal.type === 'answer') {
      log(name, `received ANSWER from ${from.slice(0, 8)}`);
    } else if (signal.candidate) {
      log(name, `received ICE candidate from ${from.slice(0, 8)}`);
    }
  });

  client.on('peer_hangup', () => {
    log(name, `received peer_hangup`);
  });
}

attachClient(alice, aliceState, 'alice');
attachClient(bob, bobState, 'bob');

// 連線
await new Promise(r => alice.on('connect', () => { log('alice', `connected`); r(); }));
await new Promise(r => bob.on('connect', () => { log('bob', `connected`); r(); }));

// 兩人都進佇列
console.log('\n--- 兩人按下「開始配對」---');
alice.emit('find_match', { name: 'Alice' });
setTimeout(() => bob.emit('find_match', { name: 'Bob' }), 100);

// 等訊令交換完成
await new Promise(r => setTimeout(r, 1500));

// 模擬 alice 掛斷
console.log('\n--- alice 掛斷 ---');
alice.emit('hangup', { target: aliceState.peerId });
await new Promise(r => setTimeout(r, 500));

// 結果分析
console.log('\n========== 驗證結果 ==========');
const checks = [
  ['兩人都連到 server',        events.filter(e => /connected/.test(e)).length === 2],
  ['兩人都進入配對佇列',       events.filter(e => /queued/.test(e)).length === 2],
  ['兩人都收到 match_found',   events.filter(e => /match_found/.test(e)).length === 2],
  ['有一人是 host',             events.some(e => /isHost=true/.test(e))],
  ['有一人是 guest',            events.some(e => /isHost=false/.test(e))],
  ['host 發出 OFFER',          events.some(e => /sent fake OFFER/.test(e))],
  ['guest 收到 OFFER',         events.some(e => /received OFFER/.test(e))],
  ['guest 回覆 ANSWER',        events.some(e => /sent fake ANSWER/.test(e))],
  ['host 收到 ANSWER',         events.some(e => /received ANSWER/.test(e))],
  ['ICE candidate 雙向交換',   events.filter(e => /received ICE candidate/.test(e)).length >= 2],
  ['掛斷通知傳到對方',         events.some(e => /received peer_hangup/.test(e))],
];

let pass = 0;
for (const [desc, ok] of checks) {
  console.log(`  ${ok ? '✅' : '❌'}  ${desc}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通過`);

if (pass === checks.length) {
  console.log('\n🎉 整條訊令架構驗證成功');
  console.log('   server 純轉發訊令、配對佇列正常、雙向交換完整');
  console.log('   接下來只要在真實瀏覽器測試音訊就完成 Phase 0\n');
}

alice.disconnect();
bob.disconnect();
process.exit(pass === checks.length ? 0 : 1);
