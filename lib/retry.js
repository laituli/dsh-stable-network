/**
 * 严格重试策略（纯逻辑，可离线单测）。
 *
 * 立场（issue laituli/dsh-personal#2）：网络波动**不得**导致 git 动作降级或跳过——
 * 只有“一直重试到成功”才是合格的默认；退避只是避免打爆链路，不是放弃的理由。
 *
 * 默认语义：默认窗口 30 分钟、窗口内不限次数；每次退避 base→2×→…→max 封顶；
 * 窗口用尽后由上层决定（默认继续重试，只是把节奏放到 maxDelayMs）。
 */
export const RETRY_DEFAULTS = Object.freeze({
  windowMs: 30 * 60 * 1000,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  giveUpAfterWindow: false,
});

export function createRetryPolicy(options) {
  const opt = options || {};
  const windowMs = Number.isFinite(opt.windowMs) ? opt.windowMs : RETRY_DEFAULTS.windowMs;
  const baseDelayMs = Number.isFinite(opt.baseDelayMs) ? opt.baseDelayMs : RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = Number.isFinite(opt.maxDelayMs) ? opt.maxDelayMs : RETRY_DEFAULTS.maxDelayMs;
  const giveUpAfterWindow = opt.giveUpAfterWindow === true;
  let attempt = 0;
  let startedAt = null;

  function begin(now) { attempt = 0; startedAt = now; }

  /** 第 attempt 次失败后的退避（attempt 从 1 起）。 */
  function delayFor(n) {
    const raw = baseDelayMs * Math.pow(2, Math.max(0, n - 1));
    return Math.min(maxDelayMs, Math.round(raw));
  }

  /** 记录一次失败，返回下一步：{ retry:true, delayMs, attempt } 或 { retry:false, reason }。 */
  function fail(now) {
    attempt += 1;
    if (startedAt == null) startedAt = now;
    const elapsed = now - startedAt;
    if (giveUpAfterWindow && elapsed >= windowMs) {
      return { retry: false, reason: 'window-exhausted', attempt: attempt, elapsedMs: elapsed };
    }
    return { retry: true, delayMs: delayFor(attempt), attempt: attempt, elapsedMs: elapsed };
  }

  function state() { return { attempt: attempt, startedAt: startedAt, windowMs: windowMs, giveUpAfterWindow: giveUpAfterWindow }; }

  return { begin: begin, fail: fail, delayFor: delayFor, state: state };
}

/**
 * 严格执行器：把 op 重试到成功为止（默认不放弃）。
 * @param op async () => T —— 要完成的动作（例如 git push）
 * @param hooks { onRetry({attempt,delayMs,error,elapsedMs}), sleep(ms), now() } —— 可注入，便于单测
 * @returns { ok:true, value, attempts } 或（giveUpAfterWindow 且窗口耗尽时）{ ok:false, error, attempts }
 */
export async function runStrict(op, options) {
  const opt = options || {};
  const policy = createRetryPolicy(opt.policy || {});
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now();
  const sleep = typeof opt.sleep === 'function' ? opt.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  policy.begin(now());
  let attempts = 0;
  for (;;) {
    try {
      const value = await op();
      return { ok: true, value: value, attempts: attempts };
    } catch (error) {
      attempts += 1;
      const step = policy.fail(now());
      if (!step.retry) return { ok: false, error: error, attempts: attempts };
      if (typeof opt.onRetry === 'function') {
        try { opt.onRetry({ attempt: step.attempt, delayMs: step.delayMs, error: error, elapsedMs: step.elapsedMs }); } catch (e) { /* 忽略 */ }
      }
      await sleep(step.delayMs);
    }
  }
}
