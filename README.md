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

## 第二切片（已就绪）：离线挂起 + 恢复钩子

- `api.enqueue(kind, label)`：网络不可达期间挂起待做项（落盘 `<DSH_HOME>/dsh-stable-network/pending.json`，重启后仍在）；
- `api.pending() / pendingCount() / drainPending()`：查看与取出；
- `api.onRecovered(handler)`：注册“网络恢复”回调 —— 上层（如同步编排）在这里补做挂起项；
- 状态里带 `pending` 计数；**探测/队列本身不执行任何网络动作、不反向依赖其它插件**。

## 立场（重要，来自 issue laituli/dsh-personal#2）

**网络波动不得导致 git 动作降级或跳过** —— 刚性要求是：

- `networkState.runStrict(label, op)`：把动作**重试到成功为止**（默认 30 分钟窗口内不限次数，退避 1s→2s→…→30s 封顶；不放弃）；
- 只有显式 `giveUpAfterWindow: true` 才会在窗口耗尽后返回失败，且此时**挂起项保留在队列里**（不被静默丢弃）；
- 探测的退避只用于“少打几次”，**不是**“跳过工作”的许可；
- 队列记录每一次严格动作：成功即移除，未成功即保留（重启后仍在）。

## 设计约束

- 探测绝不阻断宿主或其它插件：全部 try/catch；
- 本切片无副作用（不自动重推、不改其它插件状态）；补推在下一切片以**单向依赖**接入 `dsh-backup` 的同步原语；
- 与 `dsh-personal-workflow` 共用「插件热注入」机制（后续切片）。
