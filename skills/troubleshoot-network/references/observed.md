# 本机实测记录：哪些网络动作会挂、挂成什么样、怎么绕过去

来源：一次真实的 E2E 会话（改插件 → 发版 → 更新组合包 pin）。记下来是因为**同一台机器上会反复撞**，
而"换姿势"这件事每次都要重新想一遍。

## 现象一：`git push` 反复 reset（而 `gh api` 同时是通的）

**原文**（连续 5 次，退避 5/10/15/20/25 秒，全部失败）：

```
fatal: unable to access 'https://github.com/laituli/dsh-cloudware-renting/': Recv failure: Connection was reset
fatal: unable to access '...': Failed to connect to github.com port 443 after 21061 ms: Could not connect to server
```

**判读**：同一个会话里 `gh api repos/...`（走 API 链路）一直正常，`git ls-remote` / `clone` / `push` 全挂。
所以这不是"GitHub 挂了"，是**这条 git 链路**挂了。

**处置**：

1. 需要"读" → 全用 `gh api`（`contents`、`git/ref`、`git/trees`）；
2. 需要"**写**" → **只有 `git push`**。不通就停手、报告、等链路恢复（见 SKILL.md §2 的红线）；
3. 实测恢复时间**很短**：同一批命令先全部 reset/超时，几分钟后 `git ls-remote`、`git push`、
   `git push --force` 又都通了——所以**别急着宣布"永远不通"，也别急着换姿势**。

**别做的事**：

- 反复重试同一个 `git push`（要有界退避，2s→4s→8s，最多 3–5 次）；
- **用 Contents API 去"写"**：它给每个文件单独造一个 commit，远端立刻变成另一条历史——
  **这就是分叉**，而分叉是不可接受的（见下一条真实事故）。

### 事故记录：用 Contents API 发版 → 制造了真分叉

一次 v0.1.6 发布里，`git push` 连续失败后改用了 Contents API（当时这条 skill 把"每个文件一个 commit"
写成"代价"，等于默许了分叉）。结果：

- 远端多出 **16 个 `release(v0.1.6): <file>` 提交**，从 `4afacc9` 那串长出来，与本地 `cc24ae4` **同源分叉**
  （共同祖先 `e2de0d70`，两边都不是对方的后代）；
- 而且这串提交**不是**叠在发布前的远端头上，所以"远端头是发布前那个提交"这个假设也是错的；
- 收尾时 `git fetch && git reset --hard` 这条"对齐"建议也执行不了——`git fetch` 同样走 git 链路。

**修法**（顺序有讲究，试错记录如下）：

| 尝试 | 结果 |
|---|---|
| `PATCH git/refs/heads/master` 指向本地 commit | ❌ `422 Object does not exist` —— 本地对象还没上传 |
| `DELETE git/refs/heads/master` 再 push | ❌ `422 Cannot delete the default branch` |
| 普通 `git push` | ❌ 非快进被拒（远端确实有你没有的东西） |
| **`git push --force origin master`** | ✅ `392d3e8...cc24ae4 master -> master (forced update)` |

**教训**：`--force` 会**先传对象再更新 ref**，一步到位；那两条 API 绕路都走不通，别试。
修完再 `git tag -d && git tag -a && git push origin <tag>`，并核对
`git ls-remote origin 'refs/tags/<tag>*'` 的 `^{}` 行是否等于目标 commit。

**验证标准**（唯一一条）：`git ls-remote origin <branch>` 与 `git rev-parse HEAD`
两个 40 位 SHA **完全相同**。


## 现象二：huggingface.co 不可达（模型权重下载）

**原文**：`curl: (28) Connection timed out after 20014 milliseconds`（`hf-mirror.com` 同时 200）。

**处置**：声明 `HF_ENDPOINT=https://hf-mirror.com`（cloudware-renting 的 plan 里是
`algorithm.env` + `algorithm.models[].endpoint`）。**不要去猜"本机通不通"**——
执行环境是另一台机器/另一个网络，你在这边测出来的结论对它没有效力。

## 现象三：`pip install` 半途超时

**原文**：`curl: (28) Operation timed out after 20007 milliseconds with 540537 out of 46387713 bytes received`
（拉 PyPI 索引/包时）。

**处置**：`-i https://pypi.tuna.tsinghua.edu.cn/simple` 或阿里镜像；容器内同理。
这一条几乎总是有效，因为瓶颈是跨境链路而不是包本身。

## 现象四：`gh` 在 Actions 里"用不了"——**不是网络**

**原文**：

```
gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.
```

**判读**：这条**容易误判成 token/权限问题**（我第一版 workflow 的报错文案就把它写成"PAT 没配"，
把人带偏了）。实际是：Actions 里 `gh` 需要 step 级 `GH_TOKEN`；请求根本没发出去。

**处置**：在该 step 的 `env:` 里加 `GH_TOKEN: ${{ secrets.<TOKEN> }}`。
**教训**：错误文案要写"最可能的原因"，别写"我猜的原因"——写错会让人去改一个本来是对的东西。

## 对照表：先分清是哪一类

| 现象 | 类别 | 一句话处置 |
|---|---|---|
| `Connection was reset` / `Could not connect to server` / `(28) timed out` | 网络 | 退避重试；**写远端**只等 git 恢复，不许用 API 绕 |
| 远端多出"每个文件一个 commit"、与本地不同号 | **分叉（事故）** | 以本地为准 `git push --force`，然后比 40 位 SHA |
| `422 Object does not exist`（PATCH git/refs） | 用法 | 对象没上传；`--force` push 一步到位，别绕 |
| `422 Cannot delete the default branch` | 用法 | 默认分支删不掉；同上 |
| `could not read Username for 'https://github.com'` | 看网络 | 链路通=凭据；链路挂=本条 |
| `403` / `404` / `Authentication failed`（链路通） | 凭据/权限 | 查 token 范围，不要重试 |
| `cannot create standard input pipe ... Permission denied`（exit 255） | 沙箱 | 见 `troubleshoot-windows-sandbox-subprocess` |
| `Access is denied` / 退出码 `3221225794`（子进程起不来） | 沙箱 | 同上 |
| `gh: ... set the GH_TOKEN environment variable` | 用法 | 补 env，不是网络也不是权限 |

---

## 本轮追加证据（2026-10-13）

> **分级口径，三级不混写**：
> **`[实测]`** = 本代理在本机亲自跑出、下面贴了原文；**`[复现失败]`** = 按某个结论去复现，但本机**没出现**该现象；
> **`[转述]`** = 只有父代理/他人的结论，本代理**未复现**（可能为真，但不作为事实采信）。

### 现象五：`~/.gitconfig` 的 `[http]` 段带 `sslBackend = openssl` + `sslVerify = false`

- `[实测]` `C:\Users\Administrator\.gitconfig` 第 12–14 行：

  ```ini
  [http]
  	postBuffer = 524288000
  	sslBackend = openssl
  	sslVerify = false
  ```

- `[实测]` `git --version` → `git version 2.50.1.windows.1`；`git config --get http.sslBackend` → `openssl`；
  `git config --get http.sslVerify` → `false`（**是生效值**，不只是文件里那么写着）。
- `[复现失败]` **没能复现** `fatal: Unsupported SSL backend 'openssl'. Supported SSL backends: schannel`：
  裸跑（**不加** `-c http.sslBackend=schannel`）
  `git ls-remote https://github.com/laituli/dsh-stable-network.git HEAD` →
  输出 `91857f485b838cb9040e03bbac07ecdc827217bb	HEAD`，`exit 0`；
  同一份"脏"配置下 `git ls-remote https://gitee.com/laituli/dsh-stable-network.git HEAD` 也 `exit 0`。
  ⇒ **只能写成"理论隐患 + 若真看到这条报错就用 `-c http.sslBackend=schannel` 绕一次"**，
  **不能**写成"本机任何 https git 命令都会 fatal"。
- ⚠️ **告警**：`sslVerify = false` = 全局关闭 TLS 证书校验，**失去对端身份认证**（安全风险）；
  与"把 IP 写死"叠加时等于两端都不可信。要改就走 `~/.gitconfig`（用户级）并先问用户，**不许**写进仓内文件。

### 现象六：`github.com` 的 DNS 首位答案可能落到不通的 IP（间歇性）

- `[实测]` 2026-10-13 本代理复核时链路是**通的**：
  `curl -sS -o NUL -w '%{http_code}' --max-time 15 https://github.com` → `200`；
  `https://api.github.com` → `200`（`%{time_total}` = `0.337381`）；
  `Resolve-DnsName github.com -Type A` 首位答案 = `20.205.243.166`；
  `curl --resolve github.com:443:20.205.243.166` → `200`（`0.686636`）；
  裸跑 `git ls-remote https://github.com/laituli/dsh-stable-network.git HEAD` → `exit 0`。
- `[转述]` 父代理在同一台机器上遇到的原文（本代理**未复现**，但与"间歇"结论一致）：

  ```
  fatal: unable to access 'https://github.com/<o>/<r>/': Recv failure: Connection was reset
  error: RPC failed; curl 28 Recv failure: Connection was reset
  send-pack: unexpected disconnect while reading sideband packet
  Failed to connect to github.com port 443 after 21108 ms: Could not connect to server
  ```

- `[转述]` 父代理的判读：当时 `api.github.com` 是通的（curl 200 / 0.5s），于是 `gh api` 能用而 `git` 不能用——
  这**不能**证明是权限问题；三个候选 IP 里两个时通时断 ⇒ **单 IP 不可靠，长期应上稳定代理**。
- `[实测]` `gitee.com` 可达：裸跑 `git ls-remote https://gitee.com/laituli/dsh-stable-network.git HEAD`
  → `91857f485b838cb9040e03bbac07ecdc827217bb	HEAD`，`exit 0`。
  （**未核实** gitee 上那份是不是镜像/同一内容，只记"可达、可当备用远端"。）
- `[实测]` 绕法要用的配置键存在：`git help --config` 输出里含 `http.curloptResolve`。
- ★ `[复现失败/证伪]` 绕法本身：`git -c http.curloptResolve=github.com:443:<ip> push`——
  **2026-10-13 在 push 上被证伪**（`fatal: remote helper 'https' aborted session`，exit 128），
  而**同一个 IP** 的 `curl --resolve` 是 `200`。逐字读数见下面「现象八」。

### 现象七：`git submodule sync` 会改写 submodule 自己的 `remote.origin.url`

- `[实测]` 本代理在临时目录用本地 `file://` 仓库复现（**全程不联网**）：
  `git -C sub remote set-url origin https://github.com.example.invalid/decoy.git` 之后
  `git -C sub config --get remote.origin.url` = decoy；执行 `git submodule sync`
  （输出 `Synchronizing submodule url for 'sub'`）之后，同一条命令**又变回 `.gitmodules` 里的值**
  （本地路径 `E:\dev\Github\.dsh-tmp\p62skill\sync-demo2\sub.git`）。
  ⇒ 确认：`sync` **不只动父仓**，submodule 自己的 `remote.origin.url` 一起被改写。
- `[转述]` 后果描述（父代理）：之后**随便一条 `git fetch` 就会打到远端**，本轮真因此误发过一次
  github 的**只读**请求。本代理未复现这条"误出网"的具体现场。

### 对照表补充

| 现象 | 类别 | 一句话处置 |
|---|---|---|
| `fatal: Unsupported SSL backend 'openssl'...` | git 本机配置 | **`[复现失败]`** 本机没出现；真出现就 `-c http.sslBackend=schannel` 绕一次 |
| `gh api` 通、`git` 不通（且无 `403/404/Authentication failed`） | 链路（很可能是） | **不能**判成权限；先按 SKILL.md §2「分三岔」逐岔排除 |
| `error: RPC failed; curl 28 ...` / `send-pack: unexpected disconnect ...` | 网络 | 与 `Recv failure` 同级：有界退避 + 查 DNS 首位答案 |
| `git submodule sync` 之后 fetch 打到了别的远端 | git 本机配置 | `sync` 会改 submodule 的 `remote.origin.url`；动之前先 `git config -f .gitmodules --get-regexp` |
| `fatal: remote helper 'https' aborted session`（exit 128） | **换姿势失败（不是网络本身）** | 多半是 `-c http.curloptResolve=` 改路由导致；**改用普通推重试**（见现象八） |

---

## 第二轮追加证据（2026-10-13，父代理实测，P78 回灌）

> ★ **这两条是历史实测读数，不是配置建议**：里面的 IP 只用于说明"当时测到的是哪些地址"，
> **不得**据此写死到任何 `~/.gitconfig`、`.gitmodules`、代码或代理设置里。

### 现象八：`http.curloptResolve` 的 IP 绕法**在 push 上被证伪**（curl 通 ≠ git push 通）

- `[实测]` 命令与原文（exit 128）：

  ```
  $ git -c http.curloptResolve=github.com:443:20.27.177.113 push
  fatal: remote helper 'https' aborted session
  ```

  （同一条命令对被测 IP `20.27.177.113` / `4.237.22.38` 都是这个结果，`exit 128`。）

- `[实测]` **同一个 IP** 走 curl 却是通的：

  ```
  $ curl.exe --resolve github.com:443:20.27.177.113 -o NUL -w '%{http_code}' https://github.com
  200
  ```

- ⇒ **判读**：这个配置键**能让 curl 通、不能让 git push 通**。
  它**不是** push 的解法——"curl 试通了某个 IP"**推不出**"git push 能过"。
  （键本身存在：`git help --config` 里有 `http.curloptResolve`；问题在它和 git 的 https remote helper 配合不上。）
- ★ `[实测]` **操作坑**：**不要同时传两个 `http.curloptResolve`**。
  第一个若没写全 IP，`git` 会**直接 abort**（父代理踩过；报错同上）。
- **正确的先后顺序**：push 不通时 ★ **先普通推做有界退避**（见现象九），
  **只有普通推连续失败之后**才轮到"换姿势"，而这条姿势已经出局。

### 现象九：同一次故障里，"普通推"**第 1 次就成功**

- `[实测]` 同一轮的链路读数（这是**间歇**故障的现场，别读成"github 一定不通"）：

  | 探针 | 读数 |
  |---|---|
  | 平台状态端点 | `{"online":true,"consecutiveFails":0,...}` |
  | `curl https://github.com`（直连） | **`000`**，`curl: (28) Connection timed out after 15008 ms` |
  | `Resolve-DnsName github.com -Type A` 首位答案 | **`20.205.243.166`** ⇒ 该 IP **不通** |
  | `curl https://api.github.com` | **`200`** |
  | `curl https://gitee.com` | **`200`** |
  | `git ls-remote origin` | 能读回 |
  | ★ **`git push origin master:master`** | ✅ **第 1 次就成功**：`7b4554a..25cfb2b` |

- ⇒ **判读**：诊断三连**全红**（`github.com` 直连 `000` + 首位答案 IP 不通）**并不等于"推不上去"**。
  平台状态 `online:true` / `consecutiveFails:0` 与"普通推一次就成"是一致的——
  所以**先把普通推试掉**，再谈换姿势。
- **口径修正（已写回 SKILL.md §2）**：处置顺序 = §0 平台状态 → 诊断三连 → ★ **普通推有界退避（往往就成）**
  → **普通推连续失败后**才考虑 IP 绕法，而 IP 绕法在本轮**被证伪**。

