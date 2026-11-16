# RELAY-WEB-UX-ACCEPTANCE-11 协调方独立审计（2026-11-16）

**裁决：REWORK（Major-U1；已实现的 B1/B2/B3 修复保留，不得视为整体 UX ACCEPTED）。**

## 独立证据
- GitHub live main `48efc19cd57951e079f5744a9c63faf62049c4a6`，合同 8d53fc1、实施 3298518、收口 48efc19，exact-head [Actions 43736241816](https://github.com/pwl1987/relay/actions/runs/43736241816) test/e2e 两 job SUCCESS；实施提交 [43735509428](https://github.com/pwl1987/relay/actions/runs/43735509428) 同样双成功。真实代码 diff：Web `workspace.js` 单文件 +31/-7，另有预览脚本/浏览器 harness 与截图/证据。
- 协调方本人在 VM80 使用 `git clone --shared --no-checkout` 从本地原始 main 创建**临时独立 Git 克隆**、固定 `48efc19` 后独立运行 `RELAY_E2E=1 WEBUX11_TAG=coordinator-review npx vitest run test/e2e/webux11-firstuse-audit.test.ts --reporter=dot`：**6/6 PASS、94.94s**；与生产隔离的一次性 `p01a_*` 数据、确定性 stub、本地 bare 交付，临时克隆运行结束清理。原始仓库仍 HEAD==origin/main==live main、9 项未跟踪保护物未删改；生产进程没有重启。
- 协调方读取原始截图 `screenshots/verify/d02-workspace-empty-desktop.png`、`m02-workspace-empty-mobile.png`、`d07-decision-desktop.png`、`d09-failed-desktop.png`、`m07-decision-mobile.png`：空白态唯一「开始」、零项目中文提示、失败卡新增「下一步」、Decision 按钮和移动端布局均实在可见；Reviewer 原先发现红证据被覆盖，执行方重建差分证据后再次复核 PASS，均不再作为本轮新 Major。

## Major-U1：真实用户可见执行承诺错误
- 前端 `web/workspace.js:890-915`：renderComposer 只按有无 `state.goalId` 显示按钮；任一已有 Goal 的末尾继续显示并启用「交给 Relay 执行」，**没有按 `state.status.goalState` 区分 ACTIVE/COMPLETED/FAILED/CANCELLED/PAUSED**。协调方亲看的真实 Chromium `screenshots/verify/d09-failed-desktop.png` 明确显示 FAILED 工作块下方，蓝色「交给 Relay 执行」仍可见，和用户“点执行应开始工作”的理解冲突。
- 前端 `web/workspace.js:918-944` 的 sendMessage(true) 仅发送 POST `/api/goals/:id/messages` 携 `executionRequest:true`；后端 `src/server/api.ts:433-477` 的非 ACTIVE 分支**只插入 USER/RELAY 消息并返回 `held:true`、`followUpTaskId:null`**，不派生可执行 Task。后端状态门安全且应当保留；前端蓝色执行按钮却表现为“点击了但没有执行”，误导终态及 PAUSED 用户。**此为源码+真实浏览器截图交叉验证的可达事实**；协调方未独立用真实 UI 点出一次 held HTTP 响应，HTTP 行为由后端源代码和此前 e2e 证据支持，11R 要追加完整红绿浏览器负例。
- 当前 `MAC-ACCEPTANCE-CARD.md` 已告知用户“终态发送=已记录”，却未解释仍显示的强主操作「交给 Relay 执行」为什么不启动。因此不能仅以“用户有手册”解除问题。11 原合同要求首次使用不误导，且用户 Mac 从未 ACCEPTED；本项对真实工作流程具有阻断性。11 Reviewer 对既定 B1/B2/B3 的 PASS 不等于协调方已验收全部按钮承诺。

## 处置
- 将 11 交接结论从 Agent 的 ENGINEERING PASS 改为协调方 **REWORK**，唯一 ACTIVE `RELAY-WEB-UX-ACCEPTANCE-11R`，先构建真实 Playwright+API 负例，再最小修 ACTIVE/终态/暂停态的真行为及显式后续任务路径。以 Core 终态不可静默重启、显式用户授权、原历史不改写、项目 Scope 不扩权为硬门，禁新增状态机。
- 真 Mac/手机用户体验仍需用户本人操作验收；生产 NO-GO 四项与 D3 禁止执行条件不变；R2 F1/F2 与 Pilot 亦未验收。与生产服务/真实模型/外部 GitHub 业务提交无关，零生产操作。

**最终裁决：REWORK（11R 前不得称 WEB-UX-03 已 UX ACCEPTED）。**