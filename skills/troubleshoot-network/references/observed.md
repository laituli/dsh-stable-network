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
2. 需要"写" → Contents API 发布文件（见 SKILL.md §2 的脚本），每个文件一个 commit；
3. **收尾**：网络恢复后立刻 `git fetch && git reset --hard origin/<branch>` 对齐本地。
   实测：约 15 分钟后 `git clone` 自己就恢复了——所以别急着宣布"永远不通"。

**别做的事**：

- 反复重试同一个 `git push`（5 次和 50 次没区别）；
- 用 API 发布完又 `git push` 本地旧历史 → 会把远端那几笔提交**回退**（`dsh-custom-profiles`
  的 `scripts/ci/check-publish-base.mjs` 就是为这个坑写的）。

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
| `Connection was reset` / `Could not connect to server` / `(28) timed out` | 网络 | 退避重试 → 换链路（API/镜像） |
| `could not read Username for 'https://github.com'` | 看网络 | 链路通=凭据；链路挂=本条 |
| `403` / `404` / `Authentication failed`（链路通） | 凭据/权限 | 查 token 范围，不要重试 |
| `cannot create standard input pipe ... Permission denied`（exit 255） | 沙箱 | 见 `troubleshoot-windows-sandbox-subprocess` |
| `Access is denied` / 退出码 `3221225794`（子进程起不来） | 沙箱 | 同上 |
| `gh: ... set the GH_TOKEN environment variable` | 用法 | 补 env，不是网络也不是权限 |
