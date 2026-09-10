# dsh-stable-network 实施计划

## 已完成（v0.1.0 第一切片）
- [x] 仓骨架（宿主侧、peer 仅 cordis，无 client → 无前端耦合）
- [x] `lib/breaker.js`：熔断状态机（纯逻辑，可单测）
- [x] `lib/index.js`：周期 TCP 探测 + 熔断 + 状态服务 + 可选 loopback 路由
- [x] `scripts/smoke.mjs`：离线状态机自检

## 下一批
- [ ] 待推队列与恢复补推（与 dsh-backup 同步原语单向对接，连通后回执“已补推 N 项”）
- [ ] CN 镜像源信息管理（npm/github 镜像集中管理、切换与校验）
- [ ] skill 热注入（与 dsh-personal-workflow 共用实现）
- [ ] 前端状态点（运维分区风格：在线/离线/退避中 + 最近成功时间）
- [ ] 与 dsh-backup 联动：离线时同步/拉取直接 skip，不再抛英文网络错误
- [ ] 断网端到端复现脚本 + 发布与从发布物复现
