# 需求发现、交付阶段与质量门

状态：**FROZEN（交付语义）**；各任务默认阈值 OPEN。

## 一、DISCOVER：接住模糊需求而非反问用户

输入可能只是“感觉不好用”“不知道怎么做”。可使用 `Understand → Challenge → Research → Alternatives → Recommend → Experiment → Decide` 作为**思考方法**，不是七个强制子系统。

1. 先查看目标项目代码、已有 Issue、已知运行证据与真实用户路径；区分问题/约束与用户随口提出的解决方法。
2. 主动挑战：是否真有该痛点？实现后哪些用户行为改变？有更简单的方案吗？不能仅复述用户建议。
3. 可自动调查的信息由 Relay 调查；只有业务目标、预算、法律或不可逆风险才提出简短关键问题。
4. 提供**带理由的单一推荐**，必要时列 1–2 个备选；未知则制作最小原型、运行 Benchmark 或 A/B 实验。未经测量不得声称效果更好。
5. 记录被采用/推迟/否决的决策与可验证成功条件；无证据时明确假设、预期损失及实验步骤。

## 二、六阶段 Lifecycle

| 阶段 | 进入条件 | 代表性产出 | 常见跳过场景 |
| --- | --- | --- | --- |
| DISCOVER | 目标不清、体验争议或高不确定性 | 问题、证据、推荐及假设 | 已明确的小缺陷 |
| DESIGN | 行为/影响需要约束 | 范围、验收、数据/权限边界 | 小修复 |
| BUILD | 受授权的工作包可执行 | 限界的 Diff、变更记录 | 仅调研任务 |
| VERIFY | 有候选实现及精确提交 | Review、测试、真实观察 | 不可跳过交付所需验证 |
| DELIVER | 质量门及权限满足 | Git commit/受控发布/回滚记录 | 调研结论 |
| OPERATE | 交付需运行或维护 | 健康、回归、反馈、新 Goal | 非运行型产物 |

Bug：BUILD→VERIFY→DELIVER。Feature：DESIGN→BUILD→VERIFY→DELIVER。复杂或模糊目标：DISCOVER→DESIGN→BUILD→VERIFY→DELIVER→OPERATE。阶段裁剪不等于跳过权限和需要的 Gate。

## 三、独立质量与 Reality Check

`Coder → SUBMITTED → Reviewer(独立 Run) → Test → Gate → ACCEPTED`；模型“已完成”只是申请，不是裁决。Review 需读取实际 Diff/需求/失败记录，不可仅阅读 Coder 总结。

- G0 Requirement：有问题定义/验收（模糊目标先做 Discovery）。
- G1 Impact：仓库/配置/用户数据/安全影响与回滚。
- G2 Build：构建、静态检查、类型检查。
- G3 Independent Review：独立上下文找出缺陷与修复证据。
- G4 Test：合适范围的单元/集成/回归。
- G5 Reality：Web 用真实 Playwright 点击、输入、网络请求和截图；API 用真实进程/HTTP/DB；部署在授权目标检查健康与 smoke。
- G6 Release：检查 SHA、批准、发布及回滚边界。
- G7 Runtime：运行监测及回归（只对需要运营的交付）。

P0 的样例交付至少 G0/G2/G3/G4/G5，涉及 GitHub 写入还需 G6 权限检查；高风险可增加 Gate，低风险不得免除必要的现实验证。失败留证据，返回 REWORK；超限 BLOCK/ESCALATE。Task Gate、ChangeSet Gate、Project Acceptance 分层裁决；多仓暂不宣称跨仓原子性。

### 本地与远端一致的质量工作流（ADR-0012）

quick/full/release 三级本地质量入口已实现（QUALITY-LOCAL-01，`npm run quality:quick|full|release`；格式+Lint+类型+单测；集成/容器安全门/浏览器；按风险触发安全、恢复、备份-恢复与真实环境核查）：格式+Lint+类型+相关单测；完整集成/真实用户旅程+独立 Review；按风险增加安全、性能、恢复及实际部署核查。
不新增质量服务器。机器测试证据以实际命令、退出结果、候选 SHA、环境指纹为准；必需测试未执行、跳过或失败不能视为 PASS。
普通代码质量采用多维评价，不以单一分数或代码行数放行。只有确定性规则可标记明确不适用的检查。

## 四、模型能力分级

模型越弱：任务越小、边界越窄、验收越清晰、Review 更密、确定性 Gate 更严格。复杂 Discovery/架构/安全可升级强模型；升级受预算与授权约束，强模型也不能取消真实验证。不要使用未经实测的单一“模型智力分数”替代任务适配性。

## 五、Method Pack

OpenSpec 的 change/proposal/spec/tasks、Superpowers 的 TDD/debug/review/verify、BMAD 的 PRD/UX/elicitation、Comet 的 phase guard/recovery/evidence 仅可吸收为**可选方法包**。它们不得持有 Relay Workflow State，不得为使用方法论强迫所有任务生成固定数量的文档。
