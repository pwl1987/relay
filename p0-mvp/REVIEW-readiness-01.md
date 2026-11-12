# RELAY-MVP-READINESS-01 子包①独立复核

- 复核对象：`02c19f2`（父提交 `9b05cfb`）中的 `p0-mvp/readiness-01/DEPLOY-VERIFY-01.md` 及其证据。
- 复核方式：重新核对 live `main`、提交变更范围、VM80 进程/监听、HTTP、Chromium 双端脚本、代表性截图、生产 PostgreSQL；未启动真实模型、未重启服务、未触碰 `config/` 和 `p0-mvp/soak-r3b/`。
- 结论：**PASS-WITH-FINDINGS**。没有发现需要返工的产品代码或安全边界问题。

## 已独立确认

1. live `main` 为 `02c19f2810346f2a085ea0d79601dc46702d0155`，本地 HEAD 与 `origin/main` 一致。提交只新增 readiness 报告、冒烟脚本、9 张截图和结果 JSON，未改 `src/`、`web/`、迁移或包配置。
2. VM80 relay-web 进程工作目录为 `/home/ubuntu/dev/relay`，产品代码工作树为 `02c19f2`，服务监听 `10.30.5.80:8787`，未观察到 `0.0.0.0` 监听。
3. 重新执行 Chromium 冒烟得到 **17/17 PASS、9 张截图、0 页面错误**。桌面 1440×900 与移动 390×844 的登录、工作区、会话、失败块、抽屉、技术详情、Composer 未发送路径均通过。
4. 代表性截图已亲看。桌面空白态、会话态、失败态和移动抽屉、技术详情、Composer 截图与报告描述一致，中文主路径清晰，内部字段只在技术详情出现。
5. R2 零模型独立门通过：`npm run typecheck` 通过，`npx vitest run test/unit/max-output-tokens.test.ts` 为 7/7，通过源码扫描未发现 `maxTokens:8192` 写入点。
6. 生产数据库直接查询确认 `relay_console.goal_messages` 与 `relay_console.goal_message_consumptions` 存在，各 1 行。

## Findings

- **F-1 证据口径**：`DEPLOY-VERIFY-01.md` 写“relay_console 17 表”。独立查询到当前普通表为 16 张，两个新增会话表存在且数据完整。应在后续报告维护中改正计数，不能把 17 作为验收依据。
- **F-2 时间锚点**：执行报告形成时以 `8fe0f7f`/`9b05cfb` 作为产品代码锚点，结果提交为 `02c19f2`。报告已说明时间关系，但后续证据应优先记录结果提交 SHA。
- **F-3 CI**：GitHub 连接器对 `02c19f2` 返回空 workflow/status，无法独立确认该结果提交的 exact-head CI。已有 CI `43280551759` 对应 `8fe0f7f`，不能替代 `02c19f2` 的 CI 证据。此项属于验证通道缺口，不构成产品代码 REWORK。
- **F-4 未验证项保持有效**：真实 iPhone Safari A2HS、Android HTTPS 后安装、生产 Follow-up 发送和真实 Decision 动作仍留给用户实机验收。冒烟脚本刻意不发送消息，符合零模型消耗约束。
- **F-5 视觉取舍**：`d-04-tech-pane.png` 是桌面右栏折叠后的截图，移动技术详情 sheet 已实际打开并截图。该命名/动作不影响移动技术详情结论。

## 独立裁决

- READINESS-01 子包①可以进入收口，不需要修改产品代码。
- 不能把本子包升级为“用户体验已验收”或“PWA 已验证”。Mac、手机 VPN、HTTPS/PWA 和生产写动作仍未完成。
- R2 工程配置修复可继续作为已完成项保留。F1/F2 真实能力对照仍是 `UNRESOLVED`，上游 502 尝试已消耗，合同禁止自动重跑。
- 下一安全工作包是补齐本子包的 CI/证据时间锚点并准备 Mac 与手机 VPN 实机入口。不得因此启动 REAL-PILOT、MODEL-POLICY-01 或公网开放。
