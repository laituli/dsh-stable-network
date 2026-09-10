# DSH LLM 重试策略：能否配置、怎么配置、插件侧能做什么

调研对象：本机 DeepSeek Harness（`@deepseek-ai/dsh` 0.1.2-rc.1，`dsh web` profile）。
调研方式：**只读**代码/配置/会话日志；未修改 `~/.dsh/**`、未改 profile、未装依赖、未重启进程。
背景需求：issue laituli/dsh-personal#2 —— 当前是「5 次重试、末次上限 8s」，希望可配置，且默认语义是「30 分钟内 N 次重试」。

---

## 1. 概述（结论速览）

| 问题 | 结论 |
|---|---|
| 能否配置？ | **能。** 重试策略是 **provider（adapter）自有配置**，字段名 `retryPolicy`；本机 `deepseek-official` 路由由 `@deepseek-ai/dsh-llm-deepseek` 拥有，其配置 namespace 是 `llm-deepseek`。 |
| 配置在哪写？ | 三个 seam 都可用且都**热生效**：① `$DSH_HOME/settings.yaml` 的 `llm-deepseek:` 分节（推荐）；② `$DSH_HOME/profiles/web/cordis.patch.yml` 里 id 为 `llm-deepseek` 的行；③ 家目录层 `$DSH_HOME/cordis.patch.yml`（当前不存在）。 |
| 有没有环境变量？ | **无。** `dsh-llm-deepseek` 与 `dsh-llm-retry` 都不读任何与重试策略相关的环境变量。 |
| 插件侧能否覆写？ | **能，两条路**：(a) 运行时写设置 `ctx.settings.update('llm-deepseek', { retryPolicy: {...} })`（官方公开 API，会持久化并热重载）；(b) 自己监听 `agent/request-error` waterfall 自行实现策略（`@deepseek-ai/dsh-llm-retry` 自己就是这么做的）。**不能**通过重新 `registerAdapter` 抢路由（`DUPLICATE_ADAPTER`）。 |
| 「30 分钟窗口内 N 次」能原样表达吗？ | **不能原样表达。** 策略只有「次数上限 + 指数退避 + 上限封顶 + 抖动」，**没有时间窗字段**。可近似（见 §5.1），要精确时间窗语义必须走插件侧 listener（§4.2）。 |
| 现网实际值（实测） | `["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]`，即 5 次、首次退避 500ms、封顶 10000ms、抖动 10%。第 5 次退避 `min(500·2⁴, 10000)=8000ms`，所以观感是「末次约 8s」。 |
| LLM 不可用时会话会卡住吗？ | **不会永久卡住，但会「原地断掉」**：预算耗尽后当前 turn 以 `turn/end {reason:{kind:'error'}}` 结束、没有 assistant 消息，用户必须手动再发一句（实测日志里紧接着就是用户发 "continue"）。详见 §6。 |

---

## 2. 策略定义位置

### 2.1 策略类型与默认值（provider 无关的公共定义）

`C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm\lib\types\retry-policy.js`

```js
12: const DEFAULT_MAX_RETRIES = 5;
13: const DEFAULT_INITIAL_DELAY_MS = 500;
14: const DEFAULT_MAX_DELAY_MS = 10_000;
15: const DEFAULT_JITTER_RATIO = 0.1;
16: const DEFAULT_RETRYABLE_CODES = Object.freeze([
17:     EMPTY_RESPONSE_CODE, 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
22: ]);
23: const backoffSchema = z.object({
24:     initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
25:     maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
26:     jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO),
27: });
28: const normalPolicySchema = z.object({
29:     mode: z.const('normal').required(),
30:     maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
31:     retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
32:     backoff: backoffSchema,
33: });
34: const alwaysPolicySchema = z.object({
35:     mode: z.const('always').required(),
36:     backoff: backoffSchema,
37: });
39: export const RetryPolicySchema = z.union([normalPolicySchema, alwaysPolicySchema]);
```

* `mode` 是**必填**（`z.const('normal').required()` / `z.const('always').required()`）。
* `initialDelayMs` / `maxDelayMs` 上限 = `MAX_TIMER_DELAY_MS = 2147483647`（`...\dsh-timeout\lib\index.js:27`），且必须 `initialDelayMs <= maxDelayMs`（`retry-policy.js:70-72`）。
* `mode: 'always'` 时 `maxRetries` / `retryableCodes` 允许出现但被忽略（`retry-policy.js:46-51` 的注释明确说明）。
* 校验/解析入口：`resolveRetryPolicy(config, path)`（`retry-policy.js:84-126`）。
* 同义类型声明（可读版本）：`...\dsh-llm\lib\types\retry-policy.d.ts:11-65`。

### 2.2 策略的执行者

`C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm-retry\lib\index.js`（v0.1.2-rc.1）

```js
21: const name = "llm-retry";
22: const inject = ["agents", "sessionProjections"];
24: const Config = z.object({});            // ← 本插件自身没有任何配置
28: 	if (key === "retryPolicy") throw new Error("llm-retry: retryPolicy belongs under each provider configuration");
44: function localDelay(config, retry, random) {
45: 	const exponent = Math.min(retry - 1, 1024);
46: 	const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs);
47: 	const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random();
48: 	return Math.min(exponential * jitter, config.maxDelayMs);
49: }
50: function retryPolicyKey(policy) {
51: 	return policy.mode === "always" ? JSON.stringify([policy.mode, initial, max, jitter])
56: 	: JSON.stringify([policy.mode, policy.maxRetries, [...policy.retryableCodes].sort(),
                        policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]);
64: }
175: const disposeListener = ctx.on("agent/request-error", (payload, next) => { ... });
```

**`policyKey` 数组语义（以代码为准，`lib/index.js:50-64`）：**

```
normal: [ "normal", maxRetries, retryableCodes(已排序), initialDelayMs, maxDelayMs, jitterRatio ]
always: [ "always", initialDelayMs, maxDelayMs, jitterRatio ]
```

与题目给出的样本完全一致：`["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]`。

重试计数**按 (provider, policyKey) 分桶**，且随 `step/start` / `turn/end` 归零（`lib/index.js:88-107` 的会话投影 `llmRetry`）——这点很重要：**预算不是「每任务」，而是「每个打开的 step」**。

### 2.3 策略挂在哪个 provider 上

`...\@deepseek-ai\dsh-llm-deepseek\lib\index.js`

```js
1822: const NS = "llm-deepseek";          // settings namespace
1825: const PROVIDER = "deepseek-official"; // 会话日志里的 provider 名
1883: 	retryPolicy: RetryPolicySchema      // ← Config schema 的字段
1986: 		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-deepseek: retryPolicy")
2037: 	ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "DeepSeek", settingsNs: NS, settingsPath: [] }]);
2043: 	const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
2044: 	let registeredPolicy = options().retryPolicy;
2045: 	const ensureRegistrationFacts = () => {          // 策略变了就重新注册路由 → 热生效
2046: 		const policy = options().retryPolicy;
2047: 		if (deepEqualJson(policy, registeredPolicy)) return;
2048: 		registration.replace([PROVIDER]);
2049: 		registeredPolicy = policy;
2050: 	};
2051: 	ctx.inject(["settings"], (settingsCtx) => {
2052: 		settingsCtx.settings.installSection(ctx, NS, Config, config, {
2053: 			setSource: (source) => { current = source; },
2056: 			onChange: ensureRegistrationFacts
2057: 		});
2058: 	});
```

多提供方适配器 `dsh-llm-pi-ai` 同理，但 `retryPolicy` 放在**每个 provider profile** 里（`...\dsh-llm-pi-ai\lib\index.js:973,1056`）。

### 2.4 默认挂载（本机生效的组合）

`...\@deepseek-ai\dsh-base\cordis.patch.yml`（`dsh web` 的第一个 bundle 层）

```yaml
 84:     - id: llm-retry
 85:       name: '@deepseek-ai/dsh-llm-retry'

 87:     # User-settings document (`$DSH_HOME/settings.yaml`, hot-reloaded): a
 88:     # `llm-deepseek:` or `llm-pi-ai:` section there overrides the adapter entries
 89:     # below without a restart, and is what the web Models page writes.
 90:     - id: settings
 91:       name: '@deepseek-ai/dsh-settings-file'
...
497:     - id: llm-deepseek
498:       name: '@deepseek-ai/dsh-llm-deepseek'   # 该行没有内联 config
```

即：**重试执行器默认已挂载**，`llm-deepseek` 行没有内联 `config`，所以「默认值」= `RetryPolicySchema` 的 schema 默认值。

### 2.5 运行时到底是哪份代码（排掉幽灵副本）

profile 的 pnpm store 里存在**旧版残留** `@deepseek-ai+dsh-llm-retry@0.1.0-rc.8`（`.pnpm` 目录，且 `C:\Users\lai\.dsh\profiles\web\pnpm-lock.yaml` 中 **grep 不到** `dsh-llm-retry`，说明已不在依赖图里）。

实际加载的是 CLI 安装里的那份，证据（junction 链）：

```
C:\Users\lai\.dsh\profiles\node_modules\@deepseek-ai\dsh-llm-retry
  → Junction → C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm-retry   (v0.1.2-rc.1)
```

同目录下 `dsh-llm` / `dsh-llm-deepseek` / `dsh-base` 也都是指向 CLI 安装的同名 junction（全部 0.1.2-rc.1）。
机制见 `...\@deepseek-ai\dsh-app-boot\lib\index.js:645-667`（"The shared `$DSH_HOME/profiles/node_modules` mirrors the dsh installation dependency closure"）与 `...\@deepseek-ai\dsh\lib\profile-boot-BTzzdrGY.js:119,162`（`INSTALL_ANCHOR`）。
**本文引用的行号均以上述 CLI 安装路径为准。**

---

## 3. 可配置性（逐项结论）

### 3.1 `settings.yaml` —— **有**（推荐）

* 文档路径：`<harness home>/settings.yaml`，本机 = `C:\Users\lai\.dsh\settings.yaml`
  （`...\dsh-settings-file\lib\index.js:26-32`：`config.path` 优先，否则 `<home>/settings.yaml`）
* 机制：`installSection(ctx, "llm-deepseek", Config, config, ...)` 把**组合行 config 作为 base 层**注册 namespace；解析顺序 = schema 默认值 → base → 用户分节（`...\dsh-settings\lib\index.js:508-513`）。
* 覆盖语义：**深合并**（纯对象递归合并，数组整体替换）——`...\dsh-settings\lib\index.js:205-216 mergeLayers`，所以只写 `retryPolicy` 不会挤掉 `apiKeyEnv` 等字段。
* 生效时机：**热**。settings-file 提供方 watcher 触发 `onChange` → `ensureRegistrationFacts()` 重新注册路由（`dsh-llm-deepseek\lib\index.js:2044-2057`）。
* 确切写法（本机当前 settings.yaml 里**还没有** `llm-deepseek:` 分节，可直接追加）：

```yaml
# C:\Users\lai\.dsh\settings.yaml
llm-deepseek:
  retryPolicy:
    mode: normal
    maxRetries: 64
    retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
    backoff:
      initialDelayMs: 1000
      maxDelayMs: 30000
      jitterRatio: 0.1
```

或「不放弃」语义：

```yaml
llm-deepseek:
  retryPolicy:
    mode: always
    backoff: { initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0.1 }
```

* **不要**写到别处：`retryPolicy` 放在 `dsh-llm-retry` 自己的 config 下会被**显式拒绝**
  （`dsh-llm-retry\lib\index.js:24-30`：`Config = z.object({})`，`validateConfig` 抛 `llm-retry: retryPolicy belongs under each provider configuration`）。

### 3.2 profile 的 `cordis.patch.yml` —— **有**

`C:\Users\lai\.dsh\profiles\web\cordis.patch.yml`（当前是空数组 `[]`）：

```yaml
- id: llm-deepseek
  config:
    retryPolicy:
      mode: normal
      maxRetries: 64
      backoff: { initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0.1 }
```

* patch 语义：`config` 是**整体替换**而非合并（`...\cordis-plugin-include\lib\index.js:100-103` 直接 `target[key] = value`）；`dsh-base` 的注释也明说「A patch replaces the targeted row's whole `config` rather than merging into it」（`dsh-base\cordis.patch.yml:6-7`）。当前该行本来没有 config，所以只写 `retryPolicy` 是安全的；但若以后要在同一行顺带配 `apiKeyEnv`/`baseURL`，必须一起写全。
* 本 profile 的 `package.json` 里 `dsh.profile.patchReload: "live"`，`runProfile` 会 `watchUserPatches` 监听 profile patch 与家目录 patch（`profile-boot-BTzzdrGY.js:271-288`）→ **改完即热生效，无需重启**。

### 3.3 家目录层 `$DSH_HOME/cordis.patch.yml` —— **有**（本机当前文件不存在）

* 路径解析：`homePatchPath() = join(resolveDshHome(), "cordis.patch.yml")`，本机 = `C:\Users\lai\.dsh\cordis.patch.yml`
  （`C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\profile-boot-BTzzdrGY.js:110-117`）
* 它作为「机器本地偏好」叠在**每个** profile 的自有层之上（同文件 `:176-181`），同样被 watch → 热生效。写法与 §3.2 完全相同。

### 3.4 环境变量 —— **无**

* `dsh-llm-deepseek\lib\index.js` 里与启动环境有关的只有两处：`DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY"`（:1823，经 credentials seam 解析）与 `BASE_URL_ENV = "DEEPSEEK_BASE_URL"`（:1885-1888，`environment?.get(...)`，:1965）。**没有任何重试相关变量。**
* `dsh-llm-retry\lib\` 下对 `process.env` / `env.` 的 grep **零匹配**。
* 间接兜底（不是官方 seam）：patch 文件允许 `!!js` 表达式（`C:\Users\lai\.dsh\profiles\web\cordis.patch.yml:1-4` 的注释），理论上可 `!!js process.env.XXX` 喂值，但这是「用 JS 表达式读环境变量」，DSH 并未定义任何 `DSH_LLM_RETRY_*` 之类的键名。

### 3.5 其它 seam

| seam | 结论 |
|---|---|
| `ctx.llm` 服务上的 setter | **无。** 只有只读 `providerRetryPolicy(provider): ResolvedRetryPolicy`（`dsh-llm\lib\types\index.d.ts:314`）。 |
| 重新注册 adapter 抢路由 | **不可行。** `ctx.llm.registerAdapter(providers, adapter)` 对已有路由抛 `LlmError` `DUPLICATE_ADAPTER`，且是 all-or-nothing（同上 :236-244）。 |
| `dsh-llm-retry` 插件自身 config | **无。** `Config = z.object({})` 且显式拒绝 `retryPolicy`（`dsh-llm-retry\lib\index.js:24-30`）。 |
| Web「Models」页面 | README 说该分节「is what the web Models page writes」（`dsh-base\cordis.patch.yml:87-89`），但 `dsh-web-app` 与第三方 `@linxin666/dsh-web-all` 的产物里 grep `retryPolicy` **均零匹配** → 该页面很可能只渲染/写入部分字段。**未证实**（见 §8）。 |

---

## 4. 插件侧可编程面

### 4.1 运行时改设置（改的是宿主既有策略，最小代价）

`ctx.settings.update(ns, patch, expectedRevision?)` 是公开 API（`...\dsh-settings\lib\types\index.d.ts:250-256`；`replace` :262-268；`mutate` :275-282）。写法：

```js
export const name = 'dsh-stable-network'
export const inject = []          // 官方 llm-deepseek 也是这么做的：settings 走可选注入（ctx.inject），不做硬依赖

export function apply(ctx, config = {}) {
  const { windowMs = 30 * 60 * 1000, maxRetries = 64 } = config
  ctx.inject(['settings'], (scope) => {
    // 深合并进用户分节并持久化到 settings.yaml；llm-deepseek 的策略变了会自动重注册
    void scope.settings.update('llm-deepseek', {
      retryPolicy: {
        mode: 'normal',
        maxRetries,
        backoff: { initialDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0.1 },
      },
    }).catch((e) => ctx.logger?.warn('set retryPolicy failed: %o', e))
  })
}
```

* 优点：零新增重试逻辑，复用宿主的持久化 `llm/retry` 事件、取消语义与计数投影。
* 代价/风险：**会写用户的 `settings.yaml`**（用户可见的副作用）；若 Models 页面用「整体 replace」写同一 namespace，可能被覆盖（**未证实**）；`expectedRevision` 未传时不做并发保护。
* 注意 `settings` 是**可选**服务，用 `ctx.inject(['settings'], ...)` 接入（与 `dsh-llm-deepseek\lib\index.js:2051-2058` 完全同款），不要硬写进 `inject`，否则没有设置服务的 profile 里插件不会加载。

### 4.2 监听 `agent/request-error` waterfall（真正的自定义策略）

这是宿主**官方暴露的失败步骤扩展点**，`dsh-llm-retry` 自己就是它的一个监听器。

事件声明（`...\dsh-agent\lib\types\runtime-types.d.ts:264-287`）：

```ts
/**
 * Handle one failed model-request attempt before the loop retries or closes
 * its step. A listener returns `{ kind: 'retry' }` without calling `next()`
 * when it owns recovery, or calls `next()` to delegate. The default
 * `undefined` leaves the failure terminal.
 * @mode waterfall
 */
'agent/request-error'(this: Scoped<Agent>, payload: {
    agent: Agent; turn: number; step: number;
    provider: string; failure: LlmFailure;
    retryPolicy: ResolvedRetryPolicy | undefined; signal: AbortSignal;
}, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>;
```

返回类型：`RequestErrorAction = { kind: 'retry' } | undefined`（同文件 :59-61）。
消费点：`...\dsh-agent-loop\lib\index.js:658-671` —— 只有 `action?.kind === 'retry'` 才 `continue`，否则把 failure 抛成 `LlmError` 结束该 step。

waterfall 语义（`...\@deepseek-ai\cordis\lib\index.js:317-325`）：**最外层先跑**，不调用 `next()` 即否决其后所有监听器与内置行为。
注册顺序可用 `ctx.on(name, listener, { prepend: true })` 控制（`...\cordis\lib\types\events.d.ts:88,100-106`）。

由此有两种挂法，语义完全不同：

* **默认（追加，位于 `llm-retry` 下游）**：宿主策略「放弃」时（code 不合格 / 预算耗尽）会 `next()` 委派下去，此时才轮到你的监听器 → 天然是「在 5 次之后继续」的扩展位。适合做「30 分钟窗口」。
* **`{ prepend: true }`（位于 `llm-retry` 上游）**：你先决策，可完全接管（连 `mode`/`maxRetries` 都不再起作用）。

最小骨架（**示意，未在本机运行验证**；关键 API 与返回值均已按上面的 d.ts / 实现核对）：

```js
export const name = 'dsh-llm-window-retry'
export const inject = []

export function apply(ctx, config = {}) {
  const windowMs    = config.windowMs    ?? 30 * 60 * 1000
  const baseDelayMs = config.baseDelayMs ?? 1000
  const maxDelayMs  = config.maxDelayMs  ?? 30_000
  const seen = new Map()          // 示意：内存态，重启即丢；要持久需自注册 session projection

  ctx.on('agent/request-error', async (payload, next) => {
    const { turn, step, signal, failure } = payload
    const key = `${turn}:${step}`
    const st = seen.get(key) ?? { n: 0, startedAt: Date.now() }
    if (Date.now() - st.startedAt >= windowMs) return next()   // 窗口用尽 → 交还下游（保持失败终结）
    st.n += 1; seen.set(key, st)
    const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (st.n - 1))
    await new Promise((r) => { const t = setTimeout(r, delayMs)
      signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true }) })
    if (signal.aborted) return                                // 取消优先
    ctx.logger?.warn(`window-retry: ${failure.code} 第 ${st.n} 次，退避 ${delayMs}ms`)
    return { kind: 'retry' }
  })
}
```

* 优点：唯一能表达**时间窗**而不是次数的位置；不写用户配置。
* 代价/风险：你自己负责持久化（`sessionProjections.register(...)`，参考 `dsh-llm-retry\lib\index.js:86-107`）与 `llm/retry` 事件的可观测性；`always`/无限重试会**把 turn 一直挂住**（宿主不会替你兜底），且 token 成本按每次重试重复计费；顺序接错（prepend 到上游却直接 `return {kind:'retry'}`）会让宿主策略失效。插件属宿主侧变更 → **需要冷重启宿主**（本仓 `README.md:19`）。

---

## 5. 「无法原样配置」的部分与替代方案

需求要的语义是「**30 分钟内 N 次**」。宿主只给「次数 + 退避曲线」，**没有时间窗**（§2.1 schema 全局 grep 无任何 window/deadline 字段）。三条可行替代：

### 5.1 方案 A：用 `maxRetries` 折算 30 分钟（改配置，零代码）

`initialDelayMs=1000, maxDelayMs=30000` 时，各次退避 = 1s,2s,4s,8s,16s,30s,30s,…（`localDelay` 的实际公式见 §2.2）。
累计等待 ≈ `31s + 30s·(k−5)`，令其为 1800s → **k ≈ 64**。
即 `maxRetries: 64` + `maxDelayMs: 30000` 的观感就是「约 30 分钟、失败才停」。

* 代价：**这是次数近似，不是真时间窗**；抖动与 provider `Retry-After` 会让实际时长偏移。
* 关键坑（`dsh-llm-retry\lib\index.js:167-172`）：若 provider 回 `Retry-After` 且**大于 `maxDelayMs`**，`normal` 模式会**直接放弃**（`return next()`）。所以要「长时间坚持」时，`maxDelayMs` 应 ≥ 你愿意接受的最大 `Retry-After`（例如 60000）。
* 另一个坑：预算是**每个打开的 step**，`step/start`/`turn/end` 会归零（§2.2）——它不是「每任务 30 分钟」。

### 5.2 方案 B：`mode: always`（改配置，零代码，最接近「不放弃」）

`mode: always` = 无次数上限，直到成功 / 取消 / 插件释放；`maxDelayMs: 30000` 即「永远 ≤30s 重来一次」。

* 代价：**会重试永久性失败**（认证、配额、无效请求、上下文超限）——官方 README 把它列为已知限制（`...\dsh-llm-retry\README.zh.md:133`）；turn 会被长时间挂住，成本/延迟需部署方自控。适合「网络类瞬时故障优先、偶发永久故障可人工中止」的使用场景。

### 5.3 方案 C：任务级重放 / 窗口重试（插件，见 §4.2）

若要「严格 30 分钟窗口 + 窗口耗尽后不静默丢弃」，正确落点是把本仓既有的 `runStrict` 语义（`lib/retry.js:10-15,56-77`）搬到 **LLM 失败步骤**上：用 §4.2 的监听器做窗口判定，并把未完成的重放意图同时 `networkState.enqueue(...)` 落盘（`lib/index.js:134,143-158`），恢复后由 `onRecovered` 补做。

* 代价：插件需宿主侧改动 + 冷重启；需要自己实现持久计数；窗口耗尽后的「补做」是**重新发起同一回合/任务**，不是恢复被中断的那次请求（宿主没有「同一请求续跑」的原语）。

### 5.4 方案 D：调 provider 侧而不是重试

同一 `llm-deepseek:` 分节里还有与「网络不稳」直接相关的旋钮（`dsh-llm-deepseek\lib\index.js:1872`、默认值 `:1376`）：

* `streamIdleTimeoutMs`（默认 **300000** ms）：流空闲多久判超时 → 决定了失败到底以 `TIMEOUT` 还是更早的 `TRANSPORT` 出现；
* `baseURL`（或 `DEEPSEEK_BASE_URL`）：换网关/镜像，可能比加重试更有效；
* `DEEPSEEK_API_KEY` / `apiKeyEnv`：凭据缺失会变成**不可重试**的 `MISSING_CREDENTIAL` 类失败。

* 代价：只影响「失败如何发生」，不改变「失败重试几次」。

---

## 6. LLM 重试与 git 重试的关系（会话会不会卡住）

两者**现在是完全解耦的两套机制**，谁也不能救谁：

| | LLM 重试 | git 重试（本仓） |
|---|---|---|
| 归属 | 宿主插件 `dsh-llm-retry` + provider `retryPolicy` | 本插件 `lib/retry.js` 的 `runStrict` |
| 触发点 | `agent/request-error` waterfall，**同一 open step 内重跑同一请求** | 插件内层包裹一个 op（如 `git push`） |
| 预算 | 次数（默认 5），per step，`step/start`/`turn/end` 归零 | 时间窗（默认 30 min），窗口内不限次（`lib/retry.js:10-15`） |
| 退避 | 500ms 起指数退避，封顶 10s，±10% 抖动 | 1s 起指数退避，封顶 30s（`runStrict` 默认） |
| 失败后 | step 失败 → 抛 `LlmError` → turn 结束 | 默认不放弃；`giveUpAfterWindow:false` |

**「会不会卡住不前进」的实测结论：不会永久挂住，但会「原地断掉一次」。**

证据（`C:\Users\lai\.dsh\sessions\--C-Users-lai--\session-53073459-ce38-4fbb-80ed-5b0799782d44\session.jsonl.zstd`，多帧 zstd；行号 = 逐帧 `zstdDecompressSync` 拼接后的 JSONL 行号）：

```
line 9732  seq 188922  2026-09-10T02:09:46.227Z  llm/retry        retry=5/5 delayMs=8737 code=TRANSPORT turn=6 step=1
line 9733  seq 188923  2026-09-10T02:09:54.978Z  llm/retry-started retry=5
line 9734  seq 188924  2026-09-10T02:09:55.009Z  assistant/chunk   finish.kind="error"  failure={code:"TRANSPORT"}
line 9735  seq 188925  2026-09-10T02:09:55.009Z  step/end          turn=6 step=1
line 9736  seq 188926  2026-09-10T02:09:55.010Z  turn/end          {"turn":6,"reason":{"kind":"error","error":{"message":"DeepSeek API request to https://api.deepseek.com failed","code":"TRANSPORT"}}}
line 9737  seq 188927  2026-09-10T02:14:25.940Z  agent/inbox/spliced  …之后是用户手动发的 "continue"
```

特征：**`turn/end` 带 `reason.kind='error'`、且该 turn 内没有 `assistant/message`** → 界面表现为「这一轮没有回复就停了」，需要人再催一句才会继续（会话记录里紧接着就是用户发 "continue"）。

同一策略在预算内成功时的对照（同 session 早先 `turn=4 step=10` 的一次 `retry=1`）：重试成功后正常产出 `assistant/message` + `step/end`。以及
`C:\Users\lai\.dsh\sessions\--C-Users-lai-Documents-GitHub-dsh--\session-f924bf0c-6faa-48bd-aa0a-60bf25ef37cc\session.jsonl.zstd` line 36（seq 34，`retry=5/5 delayMs=8306`）——这次第 5 次重试救回来了，从首次失败到成功共 ≈17s。

**推论（与 issue 的契合点）**：

1. LLM 侧一旦断网，重试窗口只有 ~17s，随后整个 turn 作废；此时 **git 动作根本不会被执行**（模型没机会发出工具调用）。所以「网络抖动不得导致 git 动作降级」的刚性要求，在 LLM 侧同样需要「长时间不放弃」的语义，否则 git 的 30 分钟严格重试压根到不了执行点。
2. 反过来，git 侧 `runStrict` 在 30 分钟窗口内会占住工具调用，期间不会有 LLM 请求 → 不会互相触发重试；但若窗口内宿主 turn 被取消，`runStrict` 目前不接收 abort 信号（`lib/retry.js:56-77` 未传 signal），存在「用户已停止、插件仍在重试」的潜在不一致（**未证实是否有上层兜底**）。
3. 现有 LLM 次数上限（5）自带硬终结，所以**不会**出现「LLM 无限重试把会话永久挂住」；真正的永久挂起风险来自 `mode: always`（§5.2）——那时该风险要由使用方承担。

---

## 7. 复现证据（文件 + 行号/片段）

### 7.1 代码

| 主题 | 绝对路径 | 行号 |
|---|---|---|
| 策略默认值 / schema / 校验 | `C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm\lib\types\retry-policy.js` | 12–22、23–27、28–42、58–77、84–126 |
| 策略类型声明 | `…\dsh-llm\lib\types\retry-policy.d.ts` | 11–56 |
| 执行器：delay/`policyKey`/事件/waterfall | `…\dsh-llm-retry\lib\index.js` | 21–30、44–49、50–64、86–107、116–150、151–174、175–178 |
| 执行器文档（用户向） | `…\dsh-llm-retry\README.zh.md` | 12、28、32、50、54、132–136 |
| provider 侧 config/settings 接线 | `…\dsh-llm-deepseek\lib\index.js` | 1822、1825、1860–1884、1986、2037–2058 |
| pi-ai 的逐 profile 策略 | `…\dsh-llm-pi-ai\lib\index.js` | 973、1056 |
| 默认挂载与 settings 分节注释 | `…\dsh-base\cordis.patch.yml` | 84–85、87–91、497–498 |
| `agent/request-error` 声明 | `…\dsh-agent\lib\types\runtime-types.d.ts` | 59–61、264–287 |
| 失败后的分派与终结 | `…\dsh-agent-loop\lib\index.js` | 658–671 |
| waterfall 顺序语义 | `…\cordis\lib\index.js` | 307–325 |
| `ctx.on(..., { prepend })` | `…\cordis\lib\types\events.d.ts` | 88、100–106 |
| settings 分层/深合并/installSection | `…\dsh-settings\lib\index.js` | 205–216、327–343、505–513 |
| public 写 API | `…\dsh-settings\lib\types\index.d.ts` | 84–110、228、250–282 |
| settings.yaml 路径解析 | `…\dsh-settings-file\lib\index.js` | 26–32 |
| 家目录 patch 层 | `C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\profile-boot-BTzzdrGY.js` | 110–117、161–165、176–181、271–288 |
| profile patch 整体替换 config | `…\cordis-plugin-include\lib\index.js` | 68–105（:100–103） |
| `DUPLICATE_ADAPTER` / 只读策略查询 | `…\dsh-llm\lib\types\index.d.ts` | 236–244、314 |
| `MAX_TIMER_DELAY_MS` | `…\dsh-timeout\lib\index.js` | 27 |
| profile 共享 fallback 机制 | `…\dsh-app-boot\lib\index.js` | 645–667 |

（`…` = `C:\Users\lai\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`）

### 7.2 本机现状

| 项 | 路径 / 值 |
|---|---|
| settings 文档 | `C:\Users\lai\.dsh\settings.yaml`（10 行，**当前无 `llm-deepseek:` 分节**：只有 `ui-onboarding` / `dsh-backup` / `pet`） |
| profile patch | `C:\Users\lai\.dsh\profiles\web\cordis.patch.yml` = `[]` |
| profile 根 | `C:\Users\lai\.dsh\profiles\web\cordis.yml` = `[]` |
| bundles / 热重载 | `C:\Users\lai\.dsh\profiles\web\package.json:8-18`（bundles 含 base/web-app/backup/web-all；`patchReload: "live"`） |
| 家目录 patch | `C:\Users\lai\.dsh\cordis.patch.yml` **不存在** |
| 实际加载版本的 junction | `C:\Users\lai\.dsh\profiles\node_modules\@deepseek-ai\{dsh-llm-retry,dsh-llm,dsh-llm-deepseek,dsh-base}` → CLI 安装（均 0.1.2-rc.1） |
| 幽灵旧副本（未在 lockfile） | `C:\Users\lai\.dsh\profiles\web\node_modules\.pnpm\@deepseek-ai+dsh-llm-retry@0.1.0-rc.8_…` |
| 本仓插件是否已装 | `C:\Users\lai\.dsh\profiles\web\node_modules\dsh-stable-network` → **不存在**（尚未安装进 profile） |

### 7.3 会话日志样本

解压脚本（多帧 zstd；对下列 5 个历史会话逐帧解压，**帧成功/总数 = 1915/1915、1352/1352、15543/15543、5852/5852、1477/1477，坏帧 0**）：

```js
const magic = Buffer.from([0x28,0xb5,0x2f,0xfd]);
let offs = [], i = buf.indexOf(magic);
while (i !== -1) { offs.push(i); i = buf.indexOf(magic, i + 4); }
let text = '';
for (const off of offs) {                       // 每帧独立解压
  const t = zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8');
  if (t.endsWith('\n')) text += t;
}
```

实测到的策略键（本机 6 个含重试事件的会话，`policyKey` **全部**是同一条，证明现网就是 schema 默认值）：

```
["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]
```

| 会话文件（均在 `C:\Users\lai\.dsh\sessions\` 下） | `llm/retry` 事件数 | 观测到的最大 `retry` | 观测到的 `delayMs`（ms） |
|---|---|---|---|
| `--C-Users-lai--\session-53073459-ce38-4fbb-80ed-5b0799782d44\session.jsonl.zstd` | 9 | **5** | 546,514,471,1068,1948,3785,**8737**,467,473 |
| `--C-Users-lai--\session-ac913241-16c4-4a3d-b6f7-5d1f0cc92b74\session.jsonl.zstd` | 16 | **5** | 492,502,516,515,521,497,902,1863,486,995,479,1001,1919,3951,**8692**,507 |
| `--C-Users-lai-Documents-GitHub-dsh--\session-f924bf0c-6faa-48bd-aa0a-60bf25ef37cc\session.jsonl.zstd` | 5 | **5** | 457,966,2045,4033,**8306** |
| `--C-Users-lai--\32b3339d-e0e3-4977-a66d-e36acede7c7e\session.jsonl.zstd` | 10 | 4 | 477,511,464,1045,2121,4319,533,904,499,468 |
| `--C-Users-lai--\e55493e7-ace9-45c9-93e6-a8883f80dda5\session.jsonl.zstd` | 5 | 2 | 456,525,520,920,452 |
| `--C-Users-lai--\44ddbd18-5788-4498-ba5a-b0e46ef370bc\session.jsonl.zstd`（**本次调研会话，日志仍在增长**） | 2 | 2 | 532,934 |

首条完整事件样本（`session-53073459…`，line 9732 / seq 188922）：

```json
{"type":"llm/retry","seq":188922,"time":1789006186227,"data":{
  "retryId":"075869ed-8d7c-4a5c-b3e6-8f2be66ff343","turn":6,"step":1,
  "provider":"deepseek-official","mode":"normal",
  "policyKey":"[\"normal\",5,[\"EMPTY_RESPONSE\",\"RATE_LIMIT\",\"SERVER\",\"TIMEOUT\",\"TRANSPORT\"],500,10000,0.1]",
  "retry":5,"maxRetries":5,"delayMs":8736.686051002309,
  "failure":{"message":"DeepSeek API request to https://api.deepseek.com failed","code":"TRANSPORT"}}}
```

（`delayMs=8736.7` ≈ `min(500·2⁴, 10000)·jitter` = **8s × (0.9~1.1)** —— 与 issue 描述的「末次上限 8s」完全吻合：不是 `maxDelayMs=10s`，而是 5 次预算下指数项只到 8000。）

### 7.4 本仓相关代码（作为替代方案的落点）

| 主题 | 路径 | 行号 |
|---|---|---|
| 严格重试默认（30 min 窗口 / 1s→30s） | `C:\Users\lai\Documents\GitHub\dsh\dsh-stable-network\lib\retry.js` | 10–15、17–48、56–77 |
| `runStrict` 对外 API + 队列留痕 | `…\dsh-stable-network\lib\index.js` | 132–167 |
| 立场声明 | `…\dsh-stable-network\README.md` | 47–54 |
| 实施计划 | `…\dsh-stable-network\docs\plan.zh.md` | 1–15 |

---

## 8. 未证实项

1. **Web「Models」页面是否渲染/写入 `retryPolicy`**：`dsh-web-app` 与 `@linxin666/dsh-web-all@0.3.18` 产物中 grep `retryPolicy` **零匹配**；但这只能说明没有硬编码处理，schema 驱动的通用表单仍可能渲染它。未实测页面行为。
2. **Models 页面写入时是否会覆盖手写的 `retryPolicy`**：若页面走 `update()`（深合并）则安全；若走 `replace(ns, 整节)` 则有丢失风险。`dsh-settings\README.zh.md:140` 提到过这种「用脱敏视图整体重建」的风险场景，但本机未验证页面实际调用哪个 API。
3. **profile patch 与 settings 分节同时设置时的最终优先级**：结构上应为 `schema 默认值 → 组合行 config（含 patch）→ 用户 settings 分节`（`dsh-settings\lib\index.js:508-513`），但**未在本机实际改变配置验证**（约束要求不改 `~/.dsh/**`）。
4. **`mode: always` 与用户中止的交互**：代码上 `recover` 检查 `payload.signal.aborted`（`dsh-llm-retry\lib\index.js:154`），「停止」应能打断退避并终止重试；未做端到端断网复现。
5. **`llm-retry` 旧版残留（0.1.0-rc.8）是否曾被旧会话加载**：历史会话的 `policyKey` 格式与两版一致，无法据日志区分；当前加载的确定是 0.1.2-rc.1（junction 证据）。
6. **§5.1 的 `maxRetries≈64 ≈ 30 分钟`**：纯按 `localDelay` 公式做算术推导（忽略抖动与 provider `Retry-After`），**未实跑计时验证**。
7. **§4.1/§4.2 的示例代码**：API 名称、事件名、payload 字段与返回值均已按 `.d.ts`/实现逐一核对，但示例本身**未在本机编译/运行**。
8. **git 侧 `runStrict` 与 turn 取消的联动**：`lib/retry.js` 未接收 abort 信号，未知是否有上层兜底（未找到相关代码路径）。
