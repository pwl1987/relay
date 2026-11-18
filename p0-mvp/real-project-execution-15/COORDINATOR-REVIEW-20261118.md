# RELAY-REAL-PROJECT-EXECUTION-15 · 协调方独立复核

日期：2026-11-18  
实施提交：`b50ba29f343d2ea295d0cc5c59317f3ac3e6d8b7`  
GitHub Actions：`44293665824`

## 裁决

**PASS（0 Major）**。

本裁决不是采用 Agent 自述，而是基于 live GitHub main、提交文件清单、VM80 工作树、GitHub Actions exact-head 日志及前两轮独立反例复核形成。

## 独立核验事实

- `HEAD = origin/main = b50ba29f343d2ea295d0cc5c59317f3ac3e6d8b7`；正常 main 快进提交，未强推。
- 实施提交严格为 **19 文件，+1564/-195**；未夹带 `config/`、`p0-mvp/soak-r3b/`、历史截图/日志/CI 回执，也未提交 `scripts/webux11-preview.mjs` 的既有本地漂移。
- 三目录唯一真源已落地：Goal 创建时冻结 project binding；宿主项目目录负责来源、`/workspace` 负责隔离执行、`repo@branch` 负责交付。
- 项目种子只接受“可可靠证明为 clean 的 Git HEAD”；dirty、无提交、非 Git、Git 状态不可验证全部 fail-closed。
- 协调方曾独立构造损坏 `.git/index` 反例，旧实现错误 ALLOWED；REWORK 后同条件实测得到 `project_status_unverifiable` 并拒绝。
- Discovery HTTP 入口不再接受浏览器自带 `projectDir`，只从 Goal 冻结绑定解析。
- 登录限速键在当前无可信反代部署下使用 socket `remoteAddress`，不信任客户端可伪造的 X-Forwarded-For。

## exact-head CI

GitHub Actions run `44293665824@b50ba29f343d2ea295d0cc5c59317f3ac3e6d8b7`：

- `test`：success。
  - unit：**191/191**。
  - 全量非浏览器：**499 passed / 95 skipped = 594**。
  - `project-binding-seed` 9 tests 真跑。
  - `discovery-binding` 4 tests 真跑。
  - `login-throttle-xff` 2 tests 真跑。
- `e2e`：success。
  - **75 passed / 2 skipped = 77**。
  - `dirty-project-failclosed` **6/6** 真跑。
  - `three-dirs-consistency` **4/4** 真跑。
  - 既有 web journey / mobile / workspace / 11R / 13 lifecycle 均通过。

## 剩余边界

- 生产仍 **NO-GO**；本包未迁移、未改生产配置、未重启、未写生产凭据。
- clean Git seed 的语义有意不携带 gitignored 构建产物；submodule/嵌套仓库未在本包扩展。
- seed 先验失败目前通过租约 attempt 预算有界重试；更友好的任务级错误呈现可后续加固，但不阻断本包正确性。
- 用户 Mac/手机 UX ACCEPTED 仍只由用户本人确认。

## 结论

三目录模型与真实项目执行链已从“预览/测试能跑”推进到“生产组合层具备正确装配语义”的工程基线。后续不应再重构这一层；下一阶段优先处理用户可见的**结果真实性与验收闭环**。
