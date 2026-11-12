# pi-web 参考登记(WEB-UX-01 §4.1;用户指令 2026-11-12)

- 性质:第三方 UI/UX 参考源台账。pi-web **仅作 UI/UX 交互模式、响应式、PWA 思路参考**;其 Session 状态模型/后端/Provider 凭据体系一律不引入 Relay。
- 核验时间:2026-11-12 11:4x+0800(GitHub API 实测;剥代理直连)。

## 1. 源登记

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/agegr/pi-web`("Web UI for the pi coding agent") |
| 当前版本基准 | default branch `main`,HEAD commit **`b96b28b9ced615db0ad847f9c77c7dab1902bedb`**(2026-11-11T06:31:19Z,fix(compaction) #1542) |
| 主语言 | TypeScript |
| 创建/最近推送 | 2026-03-22 / 2026-11-11 |
| **License** | **MIT**(LICENSE,spdx_id=MIT,sha `99fe3367e544`,1062 bytes;GitHub /license 端点实测) |
| 人气参考 | 8181 stars(仅背景,非采用依据) |

## 2. 借鉴边界声明(先借设计,不 copy 代码)

**设计借鉴(允许,无需 notice)**:

- App Shell 信息组织:左侧固定/可折叠导航 + 中央工作区 + 右侧信息抽屉;
- running / unread / awaiting 的信息密度与状态视觉标记思路(Relay 语义重定义:Running/Waiting/Needs Decision/Failed/Completed);
- mobile bottom sheet 交互思路(Decision 单手操作);
- PWA manifest/standalone/移动 viewport 思路;
- 会话工作区"顶部摘要 + 中部时间线 + 细节折叠"的信息分层(语义改为 Relay:Goal 原始需求/Project/状态/阶段/Model/elapsed/Budget + Timeline Discovery→Planning→Coding→Testing→Reviewing→Gate→Delivery)。

**代码移植(如发生)**:本包**优先零移植**。若实施中发生实质复制(预计仅可能出现在极小工具函数/manifest 结构样例),必须:(a)保留 MIT copyright/license notice 于文件头;(b)在下方"移植台账"逐文件登记;(c)不引入其依赖树。

### 移植台账(动态维护;当前为空 = 零移植)

| 文件(Relay 侧) | 来源(pi-web 文件/commit) | 移植内容 | notice 位置 |
| --- | --- | --- | --- |
| (暂无) | — | — | — |

## 3. 禁止项(重申,全程有效)

- 不得 fork pi-web 作为 Relay Web 主仓;不得引入 pi-web 后端;
- 不得把 Pi Session 状态模型作为 Relay 状态源(权威对象保持 `Project → Goal → Task → Run → Decision → Gate → Changeset → Delivery`);
- 不得绕开 Relay Core 直接操作 Pi;不得复制其 Provider 凭据管理体系;不得引入第二 Lifecycle。

## 4. 权威链(不变)

`Relay Web → Relay API → Relay Core → Policy / Lifecycle / Budget / Gate → Pi Runtime`
