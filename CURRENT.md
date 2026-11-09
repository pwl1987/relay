# Relay 当前执行契约

- 状态：**ACTIVE / P0-00**（可行性、安全与恢复语义实验包）。激活时间：2026-11-09（Asia/Shanghai）。激活授权：用户本轮消息明确授权。
- 写者：**唯一 ACTIVE Writer = VM80（ubuntu2604）本 ZCode 会话**。Mac 及其他会话只读。激活前已核验：`origin/main == HEAD == 575ae25`、工作区 clean、reflog 无并行写入、无 CI、仅 `main` 分支。
- 起点 SHA：`575ae25ac7527783399b8fe12f9df91b33b2be01`。集成时必须校验快进条件。

## P0-00 唯一 Outcome

产出五件套（POC 代码是临时受控实验代码，**不等于产品实现开始**）：
1. `p0-00/REPORT.md`：实验 A–D 的真实命令、环境标识、原始输出引用、失败归因。
2. ADR-0003（Pi 集成方式）与 ADR-0007（durable workflow 选型）的裁决草案。
3. P0-01A 最小执行契约建议。
4. 独立复核记录（不同上下文 Reviewer）。
5. 更新 `CURRENT.md`（完成态）与 `docs/CONTINUATION.md`。

## 实验顺序与边界

按 **A → B → C → D** 顺序实施：
- **A**：Pi SDK/RPC 工具权限隔离（`--no-tools`/`--tools`/extension 路径）+ OS 沙箱独立验证。
- **B**：PostgreSQL 并发 Tick/Lease/fencing token/SIGKILL 崩溃恢复。
- **C**：外部写"成功但回执丢失"的 Reconcile（先用本地 Mock Git 仓库 + 本地 Mock HTTP，再决定是否需要专用 GitHub 测试仓）。
- **D**：最小 PG Tick/Lease 实现与 DBOS 的真实对比（代码量/依赖/恢复语义/可维护性）。

## 可写路径（白名单）

- `/home/ubuntu/dev/relay` 内：`p0-00/**`、`ADR/0003-*`、`ADR/0007-*`、`CURRENT.md`、`docs/CONTINUATION.md`、`.gitignore`。
- `/home/ubuntu/dev/relay/.p0-00-lab/**`（gitignored 运行时隔离区：沙箱 HOME、哨兵密钥、临时工作区、实验日志）。
- Docker 资源：仅限 `relay-p000-*` 前缀命名的容器/卷/网络；专用 PostgreSQL 端口 `127.0.0.1:55433`。
- Git 提交：仅本仓库 `main`，快进推送。

## 禁止路径

- 修改 VM80 其他项目（dev-agent-kit、LoopX 注册表、nms91 等一切 `/home/ubuntu/dev` 其他目录）。
- 共享 Pi 配置（`~/.pi`）写入、`pi install` 到共享环境、不受信任扩展。
- 生产凭据：真实 GitHub token 不进入沙箱/实验代码/模型上下文；SSH Agent、Docker Socket 不暴露给被测 Pi 进程。
- 强推、非快进、额外长期分支、生产部署、自动 RSI。

## 预算

- 实验 A 模型调用 ≤ 30 次（小模型优先）；实验代码保持最小（PG 实现目标 < 400 行）。
- 单实验墙钟超 2 小时未出结论 → 记录阻塞原因，暂停该实验并报告。
- PG 容器内存 ≤ 512Mi；实验结束后容器/卷保留至验收复核完成，随后可清理。

## 停止与回滚条件（触发即停止受影响实验并报告，不扩大授权）

1. 发现 Pi 层或 OS 层任一权限旁路且无法以现有手段阻断 → 实验 A 停止，P0-00 记 BLOCK。
2. Lease/fencing 出现双重有效写者且不可修复 → 实验 B 停止，记 BLOCK。
3. 任何真实凭据/生产数据暴露风险 → 立即全部停止。
4. 远端 `main` 被并行推进（fetch 后 HEAD ≠ 575ae25 系）→ 全部停止，保持只读。
5. 外部副作用无法确认 → 实验 C 停止于 NEEDS_RECONCILE 语义记录，不猜测。

## 验收标准（来自用户授权，逐条可判定）

1. Pi 不得绕过 Relay Policy 与 OS 沙箱访问未授权资源（每项绕过尝试留命令+原始输出）。
2. Lease 竞争不得出现双重有效 Writer。
3. Worker 崩溃后恢复必须保留证据与执行历史（audit 序列完整）。
4. 外部写成功但响应丢失 → 必须先 Reconcile 目标真实状态，禁止盲目重试。
5. DBOS vs 原生 PG 结论必须来自实测对比，非预设。
6. 所有实验保存原始输出、环境标识、复现命令、失败归因。

## 完成条件

独立复核通过安全门禁后：快进提交推送 `main` → 核验 `origin/main == HEAD` 且 worktree clean → 本文件改写为完成态并指向下一包（P0-01A，NOT_ACTIVE）。
