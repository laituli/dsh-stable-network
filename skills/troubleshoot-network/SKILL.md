---
name: troubleshoot-network
description: "网络通道抖动/被墙时用它——现象（逐字可搜）：`Recv failure: Connection was reset`、`Failed to connect to github.com port 443 after N ms: Could not connect to server`、`fatal: unable to access 'https://github.com/...': ...`、`could not read Username for 'https://github.com'`、`error: cannot create standard input pipe for remote-https: Permission denied`（exit 255）、`curl: (28) Operation timed out`、`curl: (7) Failed to connect`、`Connection timed out after N milliseconds`、`TLS handshake timeout`、`Client.Timeout exceeded`、`registry-1.docker.io: dial tcp: i/o timeout`。**只适用于链路抖动/不可达**；如果错误是 `Permission denied`/`403`/`404`/`Authentication failed`（权限或凭据问题），或宿主里子进程「没输出、没退出码」（沙箱问题），不要用这一条。"
whenToUse: "当 git/curl/pnpm/npm/pip/docker 这类**网络动作**报连接被 reset、超时、连不上，或半途卡住时，先读这一条再重试。核心纪律：**不允许静默降级或跳过**——先看平台的网络状态，再用有界的退避重试；git 远端写操作在本机常走不通时，改用 GitHub REST API（`gh api`）发布，而不是反复重试同一条注定失败的姿势。换镜像、换协议、换姿势都可以，唯独不能假装做过了。"
---

# 网络抖动：先看状态，再按纪律重试，最后换姿势

这一条治的是**链路**（抖动、被墙、超时）。判据先分清邻居：

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

### push 失败时的动作，只有三步

1. **有界退避重试**（§1 的纪律：2s→4s→8s，最多 3–5 次）。链路**会**自己恢复——
   实测同一批命令先全部 reset/超时，几分钟后 `git ls-remote` 与 `git push --force` 又都通了；
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
