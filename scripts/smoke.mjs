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


// ---- 严格重试（不降级）----
import { runStrict, createRetryPolicy } from '../lib/retry.js';
let sleeps = [];
let n = 0;
const r1 = await runStrict(async () => { n += 1; if (n < 3) throw new Error('flaky'); return 'pushed'; }, {
  policy: { baseDelayMs: 10, maxDelayMs: 100, windowMs: 60000 },
  sleep: async (ms) => { sleeps.push(ms); },
});
ok(r1.ok === true && r1.value === 'pushed' && r1.attempts === 2, '前两次失败、第三次成功 → 动作最终完成');
ok(sleeps[0] === 10 && sleeps[1] === 20, '退避按 10→20 递增（不放弃）');
const p = createRetryPolicy({ baseDelayMs: 1000, maxDelayMs: 8000 });
p.begin(0); const d1 = p.fail(0).delayMs; const d2 = p.fail(0).delayMs; const d3 = p.fail(0).delayMs; const d4 = p.fail(0).delayMs;
ok(d1 === 1000 && d2 === 2000 && d3 === 4000 && d4 === 8000, '退避 1s→2s→4s→8s 封顶');
const pg = createRetryPolicy({ windowMs: 100, baseDelayMs: 10, giveUpAfterWindow: true });
pg.begin(0); let step = pg.fail(50); ok(step.retry === true, '窗口内继续重试');
step = pg.fail(200); ok(step.retry === false && step.reason === 'window-exhausted', '仅显式配置 giveUpAfterWindow 时窗口耗尽才停止');
const rDefault = createRetryPolicy({}); ok(rDefault.state().windowMs === 1800000 && rDefault.state().giveUpAfterWindow === false, '默认：30 分钟窗口且不放弃');


// ---- 镜像源信息（注入内存 IO）----
import { createMirrorRegistry } from '../lib/mirrors.js';
const mstore = { text: null };
const reg = createMirrorRegistry({ io: { read: () => mstore.text, write: (t) => { mstore.text = t; } } });
ok(reg.resolve('npm') === 'https://registry.npmjs.org', '未选择时用内置首选（npm 官方源）');
const sel = reg.set('npm', 'npmmirror');
ok(sel.ok === true && reg.resolve('npm') === 'https://registry.npmmirror.com', '切换到 npmmirror 生效');
ok(typeof mstore.text === 'string' && mstore.text.includes('npmmirror'), '选择已持久化');
const reg2 = createMirrorRegistry({ io: { read: () => mstore.text, write: (t) => { mstore.text = t; } } });
ok(reg2.resolve('npm') === 'https://registry.npmmirror.com', '重启后仍记住选择');
const snap = reg2.snapshot();
ok(snap.github && Array.isArray(snap.github.candidates) && snap.github.candidates.length >= 2, '快照含各类候选（github 含直连/加速）');
ok(reg2.set('npm', '').active === null && reg2.resolve('npm') === 'https://registry.npmjs.org', '清空选择后回退内置首选');


// ---- LLM 重试策略换算 ----
import { policyForMinutes, retriesForWindow, describePolicy } from '../lib/llm-retry.js';
const p30 = policyForMinutes(30);
ok(p30.mode === 'normal' && p30.maxRetries === 64, '30 分钟窗口 → maxRetries=64（1s 起、30s 封顶）');
ok(p30.maxRetries * p30.maxDelayMs >= 30 * 60 * 1000 * 0.95, '累计退避覆盖 30 分钟量级');
ok(retriesForWindow(60000, { initialDelayMs: 1000, maxDelayMs: 30000 }) === 6, '1 分钟窗口 → 6 次（1+2+4+8+16+30=61s）');
ok(policyForMinutes(5).maxRetries < p30.maxRetries, '窗口越短次数越少（可配）');
ok(describePolicy(p30).includes('max') === false && describePolicy(p30).includes('次数=64'), '描述含次数信息');

console.log('\n结果: ' + pass + '/' + (pass + fail) + ' 通过');
if (fail) process.exitCode = 1;
