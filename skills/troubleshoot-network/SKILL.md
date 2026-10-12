---
name: troubleshoot-network
description: "网络抖动/被墙，或「链路通、git 却失败」时用它——现象（逐字可搜）：`Recv failure: Connection was reset`、`error: RPC failed; curl 28 Recv failure: Connection was reset`、`send-pack: unexpected disconnect while reading sideband packet`、`Failed to clone ... a second time, aborting`、`fatal: unable to access 'https://github.com/...': ...`、`Failed to connect to github.com port 443 after N ms: Could not connect to server`、`fatal: Unsupported SSL backend 'openssl'. Supported SSL backends: schannel`、`fatal: remote helper 'https' aborted session`、`could not read Username for 'https://github.com'`、`error: cannot create standard input pipe for remote-https: Permission denied`（exit 255）、`curl: (28) Operation timed out`、`TLS handshake timeout`、`registry-1.docker.io: dial tcp: i/o timeout`。进来先分三岔：**链路 / git 本机配置 / 凭据（`gh auth status`）**；若错误只是 `403`/`404`/`Authentication failed` 且链路通着，就是凭据问题不是这一条；宿主里子进程「没输出、没退出码」走 troubleshoot-windows-sandbox-subprocess。★ 处置顺序：先看平台状态 → 诊断三连 → **先用普通推做有界退避**（往往就成）→ 普通推连续失败才谈换姿势，而 `http.curloptResolve` 那条 IP 绕法在 push 上**已被证伪**。"
whenToUse: "当 git/curl/pnpm/npm/pip/docker 这类**网络动作**报连接被 reset、超时、连不上、半途卡住，**或链路是通的（`gh api` 能用）而 `git` 就是失败**时，先读这一条再重试。核心纪律：**不允许静默降级或跳过**——先分三岔（链路 / git 本机配置 / 凭据 `gh auth status`），先看平台的网络状态，再用有界的退避重试；`gh api` 只用于**读**，**写远端只有 `git push`**。★ 写远端失败时**先用普通推做有界退避**（实测常常第 1 次就成），**别先改路由**——`http.curloptResolve` 那条 IP 绕法在 push 上已证伪。换镜像、换协议、换姿势都可以，唯独不能假装做过了。"
---

# 网络抖动：先看状态，再按纪律重试，最后换姿势

## 什么时候用这一条（when to use）

**症状可以先逐字搜**——下面每一串都是原文，不是转述：

**链路**（连接层失败 / 超时 / 半途断开）：

- `Recv failure: Connection was reset`
- `error: RPC failed; curl 28 Recv failure: Connection was reset`
- `send-pack: unexpected disconnect while reading sideband packet`
- `fatal: unable to access 'https://github.com/...': ...`
- `Failed to connect to github.com port 443 after N ms: Could not connect to server`
- `Failed to clone ... a second time, aborting`
- `curl: (28) Operation timed out` / `curl: (7) Failed to connect`
- `Connection timed out after N milliseconds` / `TLS handshake timeout` / `Client.Timeout exceeded`
- `registry-1.docker.io: dial tcp: i/o timeout`

**git 本机配置**（链路很可能是通的）：

- `fatal: Unsupported SSL backend 'openssl'. Supported SSL backends: schannel`
- `fatal: remote helper 'https' aborted session`（exit 128）——**常出现在"用 `-c http.curloptResolve=` 改路由"之后**，
  见 §2「IP 绕法：`[复现失败/证伪]`」
- 或者干脆**没有任何"网络"字样**：同一个 `github.com` 上 **`gh api` 通、`git` 不通** → 别急着说"是权限问题"（见 §2）

**凭据**（前提是链路已证通）：

- `could not read Username for 'https://github.com'`、`403`、`404`、`Authentication failed` → **第一手段 `gh auth status`**，不是本条

**沙箱**（不是本条）：`error: cannot create standard input pipe for remote-https: Permission denied`（exit 255）
→ `troubleshoot-windows-sandbox-subprocess`。

**进来第一步就是分三岔**，不要一律当网络：

| 岔 | 先做这个判据 | 去哪 |
|---|---|---|
| **链路** | `curl -sS -o NUL -w '%{http_code}' --max-time 15 https://github.com` 得 `000`；或 `api.github.com` 也超时 | §0 → §1 → §2「DNS 首位答案」 |
| **git 本机配置** | 链路通（`api.github.com` `200`）但 `git` 失败；`git config --get http.sslBackend` / `--get http.sslVerify` 有异常值 | §2「分三岔」 |
| **凭据** | 链路通、`gh api` 通，且报的是 `403`/`404`/`Authentication failed`/`could not read Username` | `gh auth status` + token 范围（不是本条） |

> **注意**：`gh api` 通而 `git` 不通，**只说明这两条链路不同**，**不构成"是权限问题"的证据**——
> 本机实测过整轮都是"`api.github.com` `200` / `git` 全部 reset"。先按上表逐岔排除。

这一条治的是**链路**（抖动、被墙、超时），也顺手分诊 git 本机配置与凭据。判据先分清邻居：

| 你看到的 | 是哪一类 | 去哪 |
|---|---|---|
| 连接被 reset / 超时 / 连不上 / 半途卡住 | **网络** | 就是这一条 |
| `Permission denied`、`403`、`404`、`Authentication failed`、`could not read Username` **且网络是通的** | 凭据/权限 | 不是这一条：去查 token/权限/仓范围 |
| 子进程「没输出、没退出码、Access is denied」，或退出码 `3221225794` | 沙箱 | `troubleshoot-windows-sandbox-subprocess` |

> 注意 `could not read Username for 'https://github.com'` 有歧义：它**常见**是"网络断了导致凭据助手没跑起来"（属于本条），
> 但网络确认通着时就是凭据问题。先用下面第一步判一次。

## 0. 先看平台认不认这条链路（别急着重试）

这个宿主装了 `dsh-stable-network`，它**每 30 秒**探一次 `github.com:443` / `api.github.com:443`，
并在 loopback 上暴露状态（端口就是宿主端口，示例里是 3081）：

```bash
curl -s http://127.0.0.1:3081/dsh-stable-network/status
# {"online":true,"consecutiveFails":0,"offlineSince":null,"lastOkAt":...,"nextProbeAt":...,"pending":0}
```

| 字段 | 怎么用 |
|---|---|
| `online` | `true` = 平台认为链路可用 → 你这次的失败**多半是瞬时的**，退避重试即可 |
| `consecutiveFails` / `offlineSince` / `cooldownMs` | 已进入熔断离线模式 → 别把时间砸在重试上，**换姿势**（见 §2） |
| `pending` | 平台队列里挂起的待做项数量（>0 说明有人把活挂起来了，别重复做） |

> 拿不到这个端点（404/连不上）不是错误——说明这台机器没装那个插件，直接走 §1。

## 1. 纪律：有界退避重试，**不静默降级**

**原生命令必须是它那一行里唯一的东西**（管道/捕获/重定向会先被沙箱拒，见沙箱那条），
所以重试写成**独立脚本**跑，而不是塞进一行：

```bash
# retry.sh：最多 5 次，退避 2s→4s→8s→16s，每次失败都把原文打出来
for i in 1 2 3 4 5; do
  if <你的命令>; then echo "OK on attempt $i"; exit 0; fi
  echo "attempt $i failed"; sleep $((2 ** i))
done
echo "GIVING UP after 5 attempts"; exit 1
```

三条不能破：

- **不许静默跳过**：失败必须体现在输出/产物里（退出码非零、日志留痕），不能"假装成功了"接着往下走；
- **不许无限重试**：要有次数或时间上界（否则一个被墙的目标会把整轮预算烧光）；
- **重试之外要有第二姿势**：同一个 URL 重试 5 次和重试 50 次，成功率没有实质差别——见 §2。

## 2. git 远端写不动时：**只许读用 API，写只能等**

这台机器上**常见**的现象是：`git clone/fetch/pull/push/ls-remote` 一律 reset/超时，
而**同一时刻** `gh api` 是通的（两条链路不同）。

### 分三岔：链路 / git 本机配置 / 凭据（**别一律当网络**）

同一句 `Recv failure: Connection was reset` 可以来自三种完全不同的原因，处置也完全不同。
先看**本机实测的 `~/.gitconfig`**（`C:\Users\Administrator\.gitconfig`，2026-10-13 抄录）：

```ini
[http]
	postBuffer = 524288000
	sslBackend = openssl      # 第 13 行
	sslVerify = false         # 第 14 行

[credential "https://github.com"]
	helper =
	helper = !'C:\Program Files\GitHub CLI\gh.exe' auth git-credential   # 第 19 行
```

**岔 1 · 链路** → 就是上面 §0 / §1 那一套；DNS 层面的补充见本节「DNS 首位答案落到不通的 IP」。

**岔 2 · git 本机配置**（链路通、`git` 仍失败）：

- `sslBackend = openssl`：Windows 版 git 自带后端是 `schannel`，写 `openssl` **理论上是隐患**——
  理论上该看到 `fatal: Unsupported SSL backend 'openssl'. Supported SSL backends: schannel`。
  ★ **但本机没能复现**（`references/observed.md` 里标了 `[复现失败]`）：不加任何 `-c` 覆盖、裸跑
  `git ls-remote https://github.com/laituli/dsh-stable-network.git HEAD`（`git version 2.50.1.windows.1`）
  **成功，exit 0**。
  所以这里只写成"**理论隐患 + 若真看到这条报错就这么绕**"，
  **不是**"本机任何 https git 命令都会 fatal"。真撞上时临时覆盖一次即可：

  ```sh
  git -c http.sslBackend=schannel clone <url>     # 或 ls-remote / fetch / push
  ```

- ⚠️ **告警：`sslVerify = false` 是全局关掉了 TLS 证书校验。** 这是**安全风险**，不是"省事的兼容开关"：
  它让你**失去对端的身份认证**（中间人可被直接接受）。和下面「把 IP 写死」叠加时更糟——
  IP 是你指定的、证书又不校验，等于两端都不可信。要持久化改配置**只能写 `~/.gitconfig`（用户级）且先问用户**，
  **不许**写进任何仓内文件。

**岔 3 · 凭据**：本机 github 的 git 凭据交给 `gh`（上面那段 `[credential]`）。
所以判断凭据的**第一手段是 `gh auth status`**——本机实测输出：
`✓ Logged in to github.com account laituli (keyring)`，`Token scopes: 'gist', 'read:org', 'repo', 'workflow'`。
凭据侧和网络侧是**分开的两件事**：`gh api` 通、`git` 不通**不能**证明是权限问题
（更常见的是这条 git 链路挂了）。

### 红线：写远端**只有 git 直推**这一条

> **分叉是不可接受的。** 两端必须停在**同一个 commit 号**上。
> 任何"在远端另起一串提交"的写法（典型就是 Contents API，每个文件一个 commit）
> 都会立刻制造分叉——**这是已发生过的真实事故，不是假想。**
> push 不通时，**正确结果是"没推上去"**（阻塞），而不是"推上去了但是另一条历史"。

| 想做的事 | 能用 API 吗 | 怎么做 |
|---|---|---|
| 读远端文件 / 提交 / ref | ✅ 首选 | `gh api repos/<o>/<r>/contents/<path>`（`-H 'Accept: application/vnd.github.raw'`）、`git/ref/heads/<b>`、`git/trees/<sha>?recursive=1` |
| 触发 workflow | ✅ | `gh workflow run <file>.yml -R <o>/<r>` |
| **写文件 / 发提交 / 打 tag / 改 ref** | ❌ **不许用 Contents API** | 只有 `git push`。不通就 **停手、报告、等链路恢复**（见 §5） |

为什么把 `git/ref` 也算"写"：ref 只能指向**远端已有**的对象。本地 commit 还没上传时
`PATCH git/refs/heads/<b>` 会直接 `422 Object does not exist` ——**这条 422 正好证明了
"没上传就没有写"**，别把它当成"换个姿势就能绕过去"。

### 注意事项：`git submodule sync` 会改写 submodule 自己的 `remote.origin.url`

它不是只动父仓 `.git/config`——**submodule 自己的 `remote.origin.url` 也会被重写成
`.gitmodules` 里的值**。之后**随便一条 `git fetch` 就会打到远端**（本轮真因此误发过一次
github 的**只读**请求）。这是"无意出网"的经典破口。

本机实测（本地 `file://` 路径仓库、不联网）：

```
$ git -C sub remote set-url origin https://github.com.example.invalid/decoy.git
$ git -C sub config --get remote.origin.url
https://github.com.example.invalid/decoy.git
$ git submodule sync
Synchronizing submodule url for 'sub'
$ git -C sub config --get remote.origin.url     # ← 被改回去了
E:\...\sync-demo2\sub.git
```

**纪律：动 `sync` 之前先知道它会写哪些 config。**

```sh
git config -f .gitmodules --get-regexp '^submodule\..*\.(url|path)$'   # 它准备写成什么
git config --local --get-regexp '^submodule\..*\.url$'                # 当前值会不会被改掉
```

不想出网就先别 `sync`——**你以为在整理本地配置，实际在给后续每一条 fetch 换目的地。**

### DNS 首位答案落到不通的 IP（间歇性）：先普通推退避，IP 绕法**已证伪**

`github.com` 的 DNS **首位答案**可能落到一个连不上的 IP（本轮见过一个不通的首位答案，具体读数见
`references/observed.md`；同一轮里 `api.github.com` 是通的）⇒ **`gh api` 能用、`git` 不能用，这不代表是权限问题。**

症状原文（本轮）：

```
fatal: unable to access 'https://github.com/<o>/<r>/': Recv failure: Connection was reset
error: RPC failed; curl 28 Recv failure: Connection was reset
send-pack: unexpected disconnect while reading sideband packet
Failed to connect to github.com port 443 after 21108 ms: Could not connect to server
```

★ **处置顺序（2026-10-13 修正，别跳步）**：

1. §0 看平台状态（`online` / `consecutiveFails`）——平台说 `online:true` 就说明这次多半是瞬时的；
2. 诊断三连（下面）；
3. ★ **先用普通推做有界退避**（§1 那条：2s→4s→8s，最多 3–5 次）——**这一步往往就成**。
   同一次故障里的实测：`github.com` 直连 `curl` = **`000`**（`curl: (28) Connection timed out after 15008 ms`）、
   DNS 首位答案那个 IP **不通**，可是 **`git push origin master:master` 第 1 次就成功**
   （`7b4554a..25cfb2b`）——同一时刻 `api.github.com` `200`、`gitee` `200`、`ls-remote origin` 能读回；
4. ✅ **只有普通推连续失败之后**，才考虑下面的 IP 绕法——**而它本次已被证伪**（见下），所以连"第二姿势"都算不上。

**诊断三连**（都可逐条跑，判读看输出）：

```powershell
curl.exe -sS -o NUL -w '%{http_code}' --max-time 15 https://github.com        # 不通时是 000
Resolve-DnsName github.com -Type A                                            # 看首位答案
curl.exe --resolve github.com:443:<ip> -sS -o NUL -w '%{http_code}' --max-time 15 https://github.com   # 逐个 IP 试
```

**IP 绕法：`[复现失败/证伪]`（2026-10-13 实测，别再当成解法）**

```sh
git -c http.curloptResolve=github.com:443:<ip> push
```

- ❌ **在 push 上被证伪**：`git -c http.curloptResolve=github.com:443:<ip> push`
  ⇒ **`fatal: remote helper 'https' aborted session`（exit 128）**；
- ⚠️ **同一个 IP** 上 `curl.exe --resolve github.com:443:<ip> -o NUL -w '%{http_code}' https://github.com`
  却是 **`200`**（被测 IP 的实测读数见 `references/observed.md`）；
- ⇒ 结论：**这个键能让 curl 通、不能让 git push 通**。别再把"curl 通了"当作"push 能过"的证据；
- ★ **操作坑**：**不要同时传两个 `http.curloptResolve`**——第一个若没写全 IP，会直接 abort。

> 该配置键确实存在（`git help --config` 里有 `http.curloptResolve`），但它**现在是一条被证伪的绕法**：
> 只验到"诊断三连 + 某个 IP 用 curl 能通"，**没有任何一次 push 靠它成功过**。
> 先老老实实走第 3 步的普通推有界退避。

**三条硬规矩**：

1. **绝不许**把 IP / 代理 / `curloptResolve` 写进**任何仓内文件**（`.gitmodules`、代码、README 都不行）。
   要持久化**只能写 `~/.gitconfig`（用户级），且先问用户**；
2. 这条路由**会抖**：本轮见过的三个 IP 里两个时通时断，**单 IP 不可靠**，长期应上稳定代理；
3. 这是**间歇**故障：父代理随后**裸跑直连又成功了**（本代理复核：`curl https://github.com` → `200`，
   裸跑 `git ls-remote` 也 exit 0）。**不要写成「github 一定不通」。**
   ★ 更硬的一条读数：同一次故障里 **`git push` 第 1 次就成功**（见上面的处置顺序第 3 步）——
   ⇒ **"诊断三连全红"不等于"推不上去"**，先推一次再谈换姿势。

**顺手记下的现成事实**：`gitee.com` 实测可达（裸跑 `git ls-remote https://gitee.com/<o>/<r>.git HEAD`
成功），可以当**镜像 / 备用远端**；但它**不能**用来"把写操作绕过去"（那会制造分叉，见上面的红线）。

### push 失败时的动作，只有三步

> ★ 这三步**先于**任何 IP / 路由类绕法：第 1 步就是普通推退避，**别跳过它直接去改路由**。

1. **有界退避重试**（§1 的纪律：2s→4s→8s，最多 3–5 次）。链路**会**自己恢复——
   实测同一批命令先全部 reset/超时，几分钟后 `git ls-remote` 与 `git push --force` 又都通了；
   ★ 而同一次故障里 `git push origin master:master` **第一次就成功**——所以"诊断三连全红"时也要真推一次；
2. 还不通 → **停手**，把「本地 HEAD / 远端 HEAD / 失败的原文」写进报告，明确标成**未完成、已阻塞**；
3. 等链路恢复后**先比号再推**：

   ```sh
   git ls-remote origin <branch>     # 远端 SHA
   git rev-parse HEAD                # 本地 SHA
   ```

   两个 40 位 SHA **完全相同**才算对齐。

### 万一分叉已经发生了（这次就是这么修的）

先判关系（本地 HEAD 与远端 HEAD 各自是不是对方的后代），再按情况处置：

- **远端 HEAD 是本地 HEAD 的祖先** → 正常 `git push`（快进）；
- **两者都不是对方的后代（真分叉）** → 以**本地那份为准**强制对齐，并**留下证据**：

  ```sh
  git push --force origin <branch>   # 传对象 + 强制更新 ref，一步到位
  git ls-remote origin <branch>      # 必须等于 git rev-parse HEAD
  ```

  前提是工作区干净、且你确认本地树是权威的那份（逐文件比过）。
  > 顺序很重要：`--force` 会先把对象传上去再更新 ref。先删 ref 再重建那条路走不通
  > ——默认分支删不掉（`422 Cannot delete the default branch`）；反过来先 `PATCH git/ref`
  > 又会 422，因为对象还没上传。**别绕，直接 `--force`。**

修完把 tag 也重新指一次（旧 tag 可能还挂在作废的提交上）：
`git tag -d <tag> && git tag -a <tag> -m … && git push origin <tag>`，
然后 `git ls-remote origin 'refs/tags/<tag>*'` 看解引用行（`^{}`）是否等于目标 commit。

## 3. 挂起而不是丢掉：队列不是给你用的，但纪律是

插件暴露了 `enqueue/pending/drainPending/onRecovered` 与 `runStrict`（重试到成功、不放弃）。
**这些只能由宿主侧代码调用，agent 没有可达入口**（DSH 没有把插件 service 暴露成工具）。
所以对你的实际含义是：

- **别指望自动补做**：挂起/补推目前不会替你发生；你要么现在完成，要么把"未完成"**明确写进交付物**（报告里写清哪一步没做成、原因、下一步）；
- 如果你能改宿主侧插件/代码，正确的接法是 `await networkState.runStrict('git-push', () => doPush())`——
  它在窗口内重试到成功，失败时把挂起项留在队列里，`onRecovered` 时补做。

## 4. 换姿势：镜像源（有时是解法，有时是噪音）

插件里维护了一份候选镜像：`npm` 有 `registry.npmmirror.com`，`pypi` 有阿里/清华，
`github` 有 `direct` 与 `ghfast.top`（公共加速前缀）。
**它们是信息，不是自动生效的开关**——本机没有东西替你自动改 git/npm 配置。

- `pip` 卡住 → 直接 `-i https://pypi.tuna.tsinghua.edu.cn/simple` 试一次（这一条实测有效且省事）；
- `npm` 卡住 → `--registry https://registry.npmmirror.com`；
- `github` 的加速前缀**只对下载类可用性不一**，且**不要**拿它去推送（推送它多半不支持）；
- **模型权重**别用 github 通道：走 `HF_ENDPOINT=https://hf-mirror.com`（见 cloudware-renting 那套）。

## 5. 什么时候该停手

- 目标在**另一台机器/另一个网络**里（云主机、容器）——你在这边测出来的通断对它没有效力，别替它下结论；
- 连续 2 轮换姿势都失败 → 停下，把「试过什么、原文是什么、还差什么」交给使用方，而不是继续烧时间；
- **写远端的动作（push / tag）不通 → 停在"未推送"这个状态本身就是合格结果**（见 §2）。
  用换姿势的方式把它"推上去"会制造分叉，比分叉更糟的是**没人发现**；
- 拿不准是网络还是权限 → 先 `curl -sS -o /dev/null -w '%{http_code}' https://api.github.com/user`：
  `200` = 链路通（那就是权限）；超时/reset = 链路（就是本条）。

## 细节

- 本机实测的完整复现、每条命令的原文与处置 → [`references/observed.md`](references/observed.md)
- 和邻居怎么划界（凭据 / 沙箱 / 供应商侧）→ 本文开头的表 + 各方自己的 skill
