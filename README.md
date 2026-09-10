# dsh-stable-network

laituli 个人插件：**专治网络问题**。第一切片 = 可达性探测 + 熔断离线模式 + 状态读取；后续补「待推队列/恢复补推」「CN 镜像源信息管理」「skill 热注入」。

## 现状（v0.1.0）

- 周期 TCP 探测（默认 `github.com:443`、`api.github.com:443`，任一可达即在线）；
- 熔断：连续 3 次失败进入**离线模式**，退避 30s→60s→…→上限 10min，成功即恢复；
- 状态：`ctx.set('networkState')` + 可选路由 `GET /dsh-stable-network/status`（仅 loopback）；
- 纯逻辑在 `lib/breaker.js`：`node scripts/smoke.mjs` 离线自检。

## 安装与生效

```bash
dsh plugin --profile web add https://github.com/laituli/dsh-stable-network.git
# 或：npm pack && dsh plugin --profile web add <绝对路径>.tgz
```

**宿主侧插件 → 必须冷重启宿主**（新增/升级 profile 依赖都属此类）。

## 配置

```yaml
- id: dsh-stable-network
  config:
    targets: ['github.com:443', 'api.github.com:443']
    intervalMs: 30000
    probeTimeoutMs: 4000
    failThreshold: 3
    baseCooldownMs: 30000
    maxCooldownMs: 600000
```

## 验证

1. 离线单测：`node scripts/smoke.mjs`（应全绿）；
2. 冷重启后：`curl http://127.0.0.1:<端口>/dsh-stable-network/status` 应返回 `online/consecutiveFails/nextProbeAt/…`；
3. 断网复现：把 `targets` 临时指向不可达地址（如 `127.0.0.1:1`）→ 连续 3 次失败应看到离线日志，且宿主与其它插件不受影响；恢复后打印「网络已恢复」。

## 设计约束

- 探测绝不阻断宿主或其它插件：全部 try/catch；
- 本切片无副作用（不自动重推、不改其它插件状态）；补推在下一切片以**单向依赖**接入 `dsh-backup` 的同步原语；
- 与 `dsh-personal-workflow` 共用「插件热注入」机制（后续切片）。
