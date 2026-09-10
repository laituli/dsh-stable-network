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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPendingQueue } from './queue.js';
import { createMirrorRegistry } from './mirrors.js';
import { runStrict, createRetryPolicy, RETRY_DEFAULTS } from './retry.js';
import { createBreaker, BREAKER_DEFAULTS } from './breaker.js';

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

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const targets = (Array.isArray(cfg.targets) ? cfg.targets : DEFAULTS.targets).map(parseTarget).filter(Boolean);
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

  if (typeof ctx.interval === "function") {
    ctx.interval(function () { void probeAll(); }, cfg.intervalMs);
  } else {
    const timer = setInterval(function () { void probeAll(); }, cfg.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }
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

  return api;
}
