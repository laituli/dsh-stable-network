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
