/**
 * LLM 重试策略（纯逻辑，可离线单测）。
 *
 * 背景（issue laituli/dsh-personal#2 第 1 项）：宿主默认是 5 次重试、末次退避上限 10s，
 * 实测整段窗口仅 ~17s；断网时 turn 会直接以 TRANSPORT 结束，用户只能手动再发一次。
 * 目标：默认“30 分钟内持续重试”，且次数/退避可配。
 *
 * 现实约束（调研结论）：策略只有 次数 + 指数退避 + 封顶 + 抖动，**没有时间窗字段**，
 * 因此用等价的次数近似；且预算是“每个 open step”，step/turn 边界会归零。
 */
export const LLM_RETRY_DEFAULTS = Object.freeze({
  targetMinutes: 30,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  jitterRatio: 0.1,
  mode: 'normal',
});

/** 累计退避时长达到 targetMs 所需的最小重试次数（指数退避 + 封顶）。 */
export function retriesForWindow(targetMs, options) {
  const opt = options || {};
  const initial = Number.isFinite(opt.initialDelayMs) ? opt.initialDelayMs : LLM_RETRY_DEFAULTS.initialDelayMs;
  const cap = Number.isFinite(opt.maxDelayMs) ? opt.maxDelayMs : LLM_RETRY_DEFAULTS.maxDelayMs;
  if (targetMs <= 0) return 0;
  let total = 0;
  let delay = initial;
  let n = 0;
  while (total < targetMs && n < 100000) {
    n += 1;
    total += delay;
    delay = Math.min(cap, delay * 2);
  }
  return n;
}

/** 由“目标窗口分钟数”算出可直接写入 provider 的 retryPolicy。 */
export function policyForMinutes(minutes, options) {
  const opt = options || {};
  const targetMinutes = Number.isFinite(minutes) ? minutes : LLM_RETRY_DEFAULTS.targetMinutes;
  const initialDelayMs = Number.isFinite(opt.initialDelayMs) ? opt.initialDelayMs : LLM_RETRY_DEFAULTS.initialDelayMs;
  const maxDelayMs = Number.isFinite(opt.maxDelayMs) ? opt.maxDelayMs : LLM_RETRY_DEFAULTS.maxDelayMs;
  const jitterRatio = Number.isFinite(opt.jitterRatio) ? opt.jitterRatio : LLM_RETRY_DEFAULTS.jitterRatio;
  const maxRetries = retriesForWindow(targetMinutes * 60 * 1000, { initialDelayMs: initialDelayMs, maxDelayMs: maxDelayMs });
  return {
    mode: opt.mode || LLM_RETRY_DEFAULTS.mode,
    maxRetries: maxRetries,
    initialDelayMs: initialDelayMs,
    maxDelayMs: maxDelayMs,
    jitterRatio: jitterRatio,
  };
}

/** 人话描述（用于状态/日志）。 */
export function describePolicy(policy) {
  if (!policy) return '（未设置，用宿主默认）';
  const mins = (policy.maxRetries * policy.maxDelayMs) / 60000;
  return 'mode=' + policy.mode + ' 次数=' + policy.maxRetries + ' 初始=' + policy.initialDelayMs + 'ms 上限=' + policy.maxDelayMs + 'ms（≈' + mins.toFixed(0) + ' 分钟量级）';
}
