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

console.log('\n结果: ' + pass + '/' + (pass + fail) + ' 通过');
if (fail) process.exitCode = 1;
