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
      if (r.recovered) logInfo(ctx, "[dsh-stable-network] 网络已恢复");
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
    get: function () { return breaker.state(Date.now()); },
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
