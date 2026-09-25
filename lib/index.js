/**
 * dsh-stable-network —— 专治网络问题（个人插件）。
 *
 * v0.1.0 第一切片：周期 TCP 可达性探测 + 熔断离线模式 + 状态读取。
 *   - 探测目标默认 github.com:443 / api.github.com:443（任一可达即在线）；
 *   - 连续失败进入离线，退避重试，成功即恢复；
 *   - 对外：ctx.set('networkState') 与可选路由 GET /dsh-stable-network/status（仅 loopback）；
 *   - 纯逻辑在 lib/breaker.js，可离线单测。
 *
 * 约束：任何失败都不得影响宿主启动或其它插件（全部 try/catch）；本切片无副作用。
 */
import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { createPendingQueue } from './queue.js';
import { createMirrorRegistry } from './mirrors.js';
import { policyForMinutes, describePolicy, retriesForWindow, LLM_RETRY_DEFAULTS } from './llm-retry.js';
import { runStrict, createRetryPolicy, RETRY_DEFAULTS } from './retry.js';
import { createBreaker, BREAKER_DEFAULTS } from './breaker.js';
import { PROVIDER_NAME, SKILLS_DIR, SKILL_SOURCE, loadSkills, readSkillBundle, skillMainFile, toCandidate } from './skills.js';

export const name = 'dsh-stable-network';
export const inject = [];

export const DEFAULTS = Object.freeze({
  targets: ['github.com:443', 'api.github.com:443'],
  intervalMs: 30000,
  probeTimeoutMs: 4000,
  failThreshold: BREAKER_DEFAULTS.failThreshold,
  baseCooldownMs: BREAKER_DEFAULTS.baseCooldownMs,
  maxCooldownMs: BREAKER_DEFAULTS.maxCooldownMs,
});

/** 解析插件数据目录：优先 launchEnvironment.DSH_HOME，其次 env，最后 ~/.dsh。 */
function dshDataDir(ctx) {
  let home = null;
  try { home = ctx.get('launchEnvironment')?.get('DSH_HOME')?.value ?? null; } catch (e) { /* 忽略 */ }
  if (!home) home = process.env.DSH_HOME ?? null;
  if (!home) home = String(process.env.USERPROFILE || process.env.HOME || '') + '/.dsh';
  return String(home).split('\\').join('/') + '/dsh-stable-network';
}

function parseTarget(spec) {
  const s = String(spec == null ? '' : spec).trim();
  const i = s.lastIndexOf(':');
  if (i <= 0) return null;
  const host = s.slice(0, i);
  const port = Number(s.slice(i + 1));
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return { host: host, port: port };
}

/** 单次 TCP 可达性探测：连上即 ok；超时/报错都算失败（不会抛）。 */
function probeOnce(target, timeoutMs) {
  return new Promise(function (resolve) {
    let settled = false;
    let sock = null;
    const done = function (okFlag) {
      if (settled) return;
      settled = true;
      try { if (sock) sock.destroy(); } catch (e) { /* 忽略 */ }
      resolve(okFlag);
    };
    try {
      sock = net.connect({ host: target.host, port: target.port });
    } catch (e) {
      done(false);
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.on('connect', function () { done(true); });
    sock.on('timeout', function () { done(false); });
    sock.on('error', function () { done(false); });
  });
}

function logInfo(ctx, msg) { try { if (ctx.logger && ctx.logger.info) ctx.logger.info(msg); } catch (e) { /* 忽略 */ } }
function logWarn(ctx, msg) { try { if (ctx.logger && ctx.logger.warn) ctx.logger.warn(msg); } catch (e) { /* 忽略 */ } }

/** LLM 重试策略快照（供 restore 还原）。 */
let llmRetryPrevious = null;
let llmRetryApplied = false;

/** 由插件配置算出要写进宿主的 llm retryPolicy（默认 30 分钟窗口的等价参数）。 */
function llmPolicyFromCfg(cfg) {
  const raw = cfg && cfg.llmRetry && typeof cfg.llmRetry === 'object' ? cfg.llmRetry : {};
  const minutes = Number(raw.targetMinutes);
  return policyForMinutes(Number.isFinite(minutes) && minutes > 0 ? minutes : LLM_RETRY_DEFAULTS.targetMinutes, raw);
}

/**
 * 把「窗口内不放弃」写进宿主的 llm 重试设置（settings 命名空间 llm-deepseek）。
 * 文件级约束：任何失败都不得影响宿主启动，所以这里不抛异常、只返回结果。
 * 设置服务通过 ctx.get('settings') 取（方法调用安全；直接读 ctx.settings 会因为
 * 未声明 inject 而抛 cannot get property，把整个插件树打挂——真宿主踩过）。
 */
async function applyLlmRetryPolicy(ctx, cfg) {
  try {
    const svc = typeof ctx.get === 'function' ? ctx.get('settings') : null;
    if (!svc || typeof svc.update !== 'function') return { ok: false, reason: '宿主没有可用的 settings 服务' };
    const policy = llmPolicyFromCfg(cfg);
    if (!llmRetryApplied) {
      try {
        const desc = typeof svc.describe === 'function' ? svc.describe('llm-deepseek') : null;
        llmRetryPrevious = desc && desc.user && Object.prototype.hasOwnProperty.call(desc.user, 'retryPolicy')
          ? desc.user.retryPolicy : null;
      } catch (e) { llmRetryPrevious = null; }
    }
    await svc.update('llm-deepseek', { retryPolicy: policy });
    llmRetryApplied = true;
    logInfo(ctx, '[dsh-stable-network] 已应用 LLM 重试策略: ' + JSON.stringify(policy));
    return { ok: true, policy };
  } catch (e) {
    logWarn(ctx, '[dsh-stable-network] 应用 LLM 重试策略失败（不影响宿主与其它插件）: ' + String((e && e.message) || e));
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/** 还原上一次的 llm retryPolicy（插件卸载/用户要求时）。 */
async function restoreLlmRetryPolicy(ctx) {
  try {
    const svc = typeof ctx.get === 'function' ? ctx.get('settings') : null;
    if (!svc || typeof svc.update !== 'function') return { ok: false, reason: '宿主没有可用的 settings 服务' };
    await svc.update('llm-deepseek', { retryPolicy: llmRetryPrevious === null ? undefined : llmRetryPrevious });
    llmRetryApplied = false;
    return { ok: true, restored: llmRetryPrevious };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/** 装配期调用：绝不让 LLM 重试策略的问题影响宿主启动。 */
function safeApplyLlmRetry(ctx, cfg) {
  try { return applyLlmRetryPolicy(ctx, cfg); } catch (e) {
    logWarn(ctx, '[dsh-stable-network] LLM 重试策略装配异常（已忽略）: ' + String((e && e.message) || e));
    return Promise.resolve({ ok: false, reason: 'threw' });
  }
}

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});  const targets = (Array.isArray(cfg.targets) ? cfg.targets : DEFAULTS.targets).map(parseTarget).filter(Boolean);
  const breaker = createBreaker(cfg);

  // 插件自有数据目录：<DSH_HOME>/dsh-stable-network/（只在需要落盘时才创建）
  const dataDir = dshDataDir(ctx);
  const queue = createPendingQueue({
    storePath: join(dataDir, 'pending.json'),
    io: {
      read: () => { try { return readFileSync(join(dataDir, 'pending.json'), 'utf8'); } catch (e) { return null; } },
      write: (text) => { try { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, 'pending.json'), text, 'utf8'); } catch (e) { /* 忽略 */ } },
    },
  });
  /** 镜像源注册表：与队列共用同一数据目录（mirrors.json）。 */
  const mirrors = createMirrorRegistry({
    io: {
      read: () => { try { return readFileSync(join(dataDir, 'mirrors.json'), 'utf8'); } catch (e) { return null; } },
      write: (text) => { try { mkdirSync(dataDir, { recursive: true }); writeFileSync(join(dataDir, 'mirrors.json'), text, 'utf8'); } catch (e) { /* 忽略 */ } },
    },
  });

  /** 恢复回调：由上层（如 dsh-backup 的同步编排）注册，网络恢复时被调用。 */
  const recoveredHandlers = [];
  logInfo(ctx, "[dsh-stable-network] 探测目标 " + targets.map(function (t) { return t.host + ":" + t.port; }).join(", ") + "，间隔 " + cfg.intervalMs + "ms");

  async function probeAll() {
    const now = Date.now();
    if (!breaker.shouldProbe(now)) return;
    let anyOk = false;
    for (const t of targets) {
      if (await probeOnce(t, cfg.probeTimeoutMs)) { anyOk = true; break; }
    }
    const at = Date.now();
    if (anyOk) {
      const r = breaker.recordOk(at);
      if (r.recovered) {
        logInfo(ctx, "[dsh-stable-network] 网络已恢复（待处理 " + queue.size() + " 项）");
        for (const h of recoveredHandlers) { try { h({ pending: queue.list() }); } catch (e) { /* 回调异常不影响探测 */ } }
      }
    } else {
      const r = breaker.recordFail(at);
      if (r.becameOffline) logWarn(ctx, "[dsh-stable-network] 连续探测失败，进入离线模式（网络类操作应跳过）");
    }
  }

  // 不要写 `typeof ctx.interval === "function"` 这种探测：Cordis 的 ctx 属性是
  // “未声明 inject 就抛 cannot get property ... without inject”的 getter，探测本身
  // 就会把插件树打挂（真宿主实测：loader entry 应用失败 → 整个 dsh web 起不来）。
  // 改用平台原生定时器 + unref，零 ctx 依赖。
  const timer = setInterval(function () { void probeAll(); }, cfg.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  void probeAll();

  const api = {
    /** 离线期间挂起一个待做项（例如一次同步请求）。 */
    enqueue: function (kind, label) { return queue.add(kind, label); },
    pending: function () { return queue.list(); },
    pendingCount: function () { return queue.size(); },
    drainPending: function () { return queue.drain(); },
    /**
     * 严格完成一个网络动作：**重试到成功为止**（默认 30 分钟窗口内不限次数；
     * 不降级、不跳过 —— issue laituli/dsh-personal#2 的刚性要求）。
     * 用法：await networkState.runStrict('git-push', () => doPush())
     */
    runStrict: async function (label, op, opts) {
      const queued = queue.add('strict:' + String(label || 'op'), null);
      try {
        const r = await runStrict(op, {
          policy: Object.assign({}, RETRY_DEFAULTS, (opts && opts.policy) || {}),
          onRetry: function (info) {
            logWarn(ctx, "[dsh-stable-network] " + label + " 第 " + info.attempt + " 次失败，退避 " + info.delayMs + "ms 后继续（不降级，直到成功）: " + (info.error && info.error.message ? info.error.message : info.error));
            if (opts && typeof opts.onRetry === 'function') { try { opts.onRetry(info); } catch (e) { /* 忽略 */ } }
          },
        });
        if (r.ok) queue.remove(queued.id);
        return r;
      } catch (e) {
        return { ok: false, error: e, attempts: 0 };
      }
    },
    retryPolicy: function (opts) { return createRetryPolicy(opts || {}); },
    /** LLM 重试策略：apply() 立即应用 / restore() 还原 / policyFor(minutes) 试算 / describe() 说明。 */
    llmRetry: {
      apply: function () { return applyLlmRetryPolicy(ctx, cfg); },
      restore: function () { return restoreLlmRetryPolicy(ctx); },
      policyFor: (minutes) => policyForMinutes(minutes, (cfg.llmRetry && typeof cfg.llmRetry === 'object') ? cfg.llmRetry : {}),
      retriesForWindow: retriesForWindow,
      describe: describePolicy,
    },
    /** 镜像源：list(kind) / set(kind, id|url) / resolve(kind) / snapshot()。 */
    mirrors: mirrors,
    /** 注册“网络恢复”回调（上层用它补做挂起项）。 */
    onRecovered: function (handler) { if (typeof handler === 'function') recoveredHandlers.push(handler); },
    get: function () { return Object.assign({}, breaker.state(Date.now()), { pending: queue.size() }); },
    targets: targets.map(function (t) { return t.host + ":" + t.port; }),
    probeNow: probeAll,
  };
  try { if (typeof ctx.set === "function") ctx.set("networkState", api); } catch (e) { /* 宿主无该能力 */ }

  try {
    if (typeof ctx.inject === "function") {
      ctx.inject(["webServer"], function (scope) {
        scope.webServer.register({
          kind: "exact",
          path: "/dsh-stable-network/status",
          handler: function (req, res) {
            const host = String((req.headers && req.headers.host) || "");
            if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) { res.writeHead(403); res.end("forbidden"); return; }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(api.get()));
          },
        });
      });
    }
  } catch (e) { /* 无 webServer 的 profile 静默跳过 */ }

  void safeApplyLlmRetry(ctx, cfg);

  // 把包内的 skill 交给宿主（troubleshoot-network 等）。
  // 用 `ctx.inject(['skills'])` 而不是写进顶层 `inject`：没有 skills 服务的组装里，
  // 插件其余部分（探测/熔断/状态端点）照常工作。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['skills'], (scope) => {
        try {
          registerSkills(scope);
        } catch (e) {
          try { scope.logger.warn('[dsh-stable-network] skills 未注册: ' + (e && e.message ? e.message : e)); } catch (e2) { /* 忽略 */ }
        }
      });
    }
  } catch (e) { /* 宿主无 inject 能力 */ }

  return api;
}

/**
 * 注册包内 skill：**一个 provider 供一个目录 bundle**（不是逐个 `ctx.skills.register()`）。
 *
 * 三条宿主契约（都是从 cloudware-renting 那份踩过来的，别改）：
 *   1. `list()` / `get()` **必须是 async**：宿主带 signal 时会对返回值 `.then()`，
 *      返回普通数组会炸 `promise.then is not a function`（目录里有它、`skill` 工具却加载失败）。
 *   2. `source` / `provider` 必须是字符串，`invocation` 两个布尔都要给全。
 *   3. 交 `resourceBase`（目录）与 `path`（主文档）：DSH 据此解析相对路径，治理 UI 据此定位文件。
 */
function registerSkills(ctx) {
  let catalog = loadSkills();
  const baseDirs = new Map(catalog.map((skill) => [skill.name, skill.baseDir]));
  ctx.skills.registerProvider((control) => {
    watchSkills(ctx, control, () => { catalog = loadSkills(); });
    return {
      name: PROVIDER_NAME,
      list: async () => catalog.map(toCandidate),
      get: async (candidate) => {
        const baseDir = baseDirs.get(candidate && candidate.name);
        if (baseDir === undefined) return undefined;   // 认不出的名字如实返回，别抛进 catalog
        const fresh = readSkillBundle(baseDir);
        return {
          name: fresh.name,
          description: fresh.description,
          ...(fresh.whenToUse === undefined ? {} : { whenToUse: fresh.whenToUse }),
          invocation: fresh.invocation,
          content: fresh.content,
          source: SKILL_SOURCE,
          provider: PROVIDER_NAME,
          resourceBase: { kind: 'directory', path: baseDir },
          path: skillMainFile(baseDir),
        };
      },
    };
  });
  for (const skill of catalog) {
    try {
      ctx.logger.info('[dsh-stable-network] skill "' + skill.name + '" via provider ' + PROVIDER_NAME +
        ' (base ' + skill.baseDir + ', ' + skill.references.length + ' references)');
    } catch (e) { /* 忽略 */ }
  }
}

/** 目录改动即失效：`list()` 读的是内存 catalog，`control.invalidate()` 通知宿主重列（best-effort）。 */
function watchSkills(ctx, control, reload) {
  if (typeof ctx.effect !== 'function') return;
  let timer;
  let watcher;
  try {
    watcher = watch(SKILLS_DIR, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { try { reload(); control.invalidate(); } catch (e) { /* 忽略 */ } }, 200);
    });
  } catch (e) {
    return;   // 平台不支持 recursive watch：改正文仍即时（get() 现读），只是 catalog 摘要要重启
  }
  ctx.effect(() => () => {
    try { clearTimeout(timer); watcher.close(); } catch (e) { /* 忽略 */ }
  }, 'dsh-stable-network: skill watcher');
}
