/**
 * 网络熔断状态机（纯逻辑、无 IO）：连续失败 N 次进入离线，退避重试，成功即恢复。
 * 抽出来是为了可离线单测（scripts/smoke.mjs 直接驱动它验证状态迁移）。
 */

export const BREAKER_DEFAULTS = Object.freeze({
  failThreshold: 3,
  baseCooldownMs: 30000,
  maxCooldownMs: 600000,
});

export function createBreaker(options) {
  const opt = options || {};
  const failThreshold = Number.isFinite(opt.failThreshold) ? opt.failThreshold : BREAKER_DEFAULTS.failThreshold;
  const baseCooldownMs = Number.isFinite(opt.baseCooldownMs) ? opt.baseCooldownMs : BREAKER_DEFAULTS.baseCooldownMs;
  const maxCooldownMs = Number.isFinite(opt.maxCooldownMs) ? opt.maxCooldownMs : BREAKER_DEFAULTS.maxCooldownMs;

  let consecutiveFails = 0;
  let offline = false;
  let offlineSince = null;
  let lastOkAt = null;
  let lastFailAt = null;
  let nextProbeAt = 0;
  let cooldownMs = baseCooldownMs;

  function shouldProbe(now) {
    return now >= nextProbeAt;
  }

  function recordOk(now) {
    const recovered = offline;
    consecutiveFails = 0;
    offline = false;
    offlineSince = null;
    cooldownMs = baseCooldownMs;
    lastOkAt = now;
    nextProbeAt = now;
    return { recovered: recovered };
  }

  function recordFail(now) {
    consecutiveFails += 1;
    lastFailAt = now;
    if (consecutiveFails >= failThreshold) {
      const becameOffline = !offline;
      offline = true;
      if (becameOffline) offlineSince = now;
      cooldownMs = Math.min(maxCooldownMs, cooldownMs * 2);
      nextProbeAt = now + cooldownMs;
      return { becameOffline: becameOffline };
    }
    nextProbeAt = now;
    return { becameOffline: false };
  }

  function state(now) {
    return {
      online: !offline,
      consecutiveFails: consecutiveFails,
      offlineSince: offlineSince,
      lastOkAt: lastOkAt,
      lastFailAt: lastFailAt,
      nextProbeAt: nextProbeAt,
      cooldownMs: cooldownMs,
      skipNetwork: offline && now < nextProbeAt,
    };
  }

  return { shouldProbe: shouldProbe, recordOk: recordOk, recordFail: recordFail, state: state };
}
