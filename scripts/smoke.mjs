/** dsh-stable-network 纯逻辑自检（不联网）：在线 → 离线 → 退避倍增 → 恢复。 */
import { createBreaker } from '../lib/breaker.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log('  ✅ ' + msg); } else { fail += 1; console.error('  ❌ ' + msg); } };

const b = createBreaker({ failThreshold: 3, baseCooldownMs: 1000, maxCooldownMs: 8000 });
const t = 1000000;

ok(b.state(t).online === true, '初始状态：在线');
b.recordFail(t); ok(b.state(t).online === true, '1 次失败仍在线');
b.recordFail(t); ok(b.state(t).online === true, '2 次失败仍在线');
b.recordFail(t);
ok(b.state(t).online === false && b.state(t).consecutiveFails === 3, '第 3 次失败进入离线');
ok(b.shouldProbe(t) === false, '离线后退避窗口内不再探测');
ok(b.shouldProbe(t + 2000) === true, '退避窗口到期后允许探测');
const before = b.state(t).cooldownMs;
b.recordFail(t + 2000);
ok(b.state(t + 2000).cooldownMs > before, '持续失败时退避倍增');
const rec = b.recordOk(t + 3000);
ok(rec.recovered === true && b.state(t + 3000).online === true, '探测成功即恢复在线');
ok(b.state(t + 3000).cooldownMs === 1000, '恢复后退避重置');
ok(b.state(t + 3000).skipNetwork === false, '恢复后不再 skip 网络操作');


// ---- 待处理队列（注入内存 IO，不落盘）----
import { createPendingQueue } from '../lib/queue.js';
const store = { text: null };
const q = createPendingQueue({ io: { read: () => store.text, write: (t) => { store.text = t; } }, now: () => 5000 });
ok(q.size() === 0, '队列初始为空');
q.add('sync', 'github-sync');
ok(q.size() === 1 && q.list()[0].kind === 'sync', '离线期间可挂起待做项');
ok(typeof store.text === 'string' && store.text.includes('github-sync'), '挂起项已持久化（可注入 IO）');
const q2 = createPendingQueue({ io: { read: () => store.text, write: (t) => { store.text = t; } } });
ok(q2.size() === 1, '重启后从持久化恢复队列');
const drained = q2.drain();
ok(drained.length === 1 && q2.size() === 0, 'drain 取出全部并清空');
q2.add('pull', null); ok(q2.remove(q2.list()[0].id) === true && q2.size() === 0, 'remove 可移除指定项');

console.log('\n结果: ' + pass + '/' + (pass + fail) + ' 通过');
if (fail) process.exitCode = 1;
