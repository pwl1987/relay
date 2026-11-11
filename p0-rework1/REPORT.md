# P0-REWORK-1 报告:模型驱动 Discovery(总执行包·阶段 B)

- 合同:本包 ACTIVE 合同 `8880528`(CURRENT.md);实现链:`8880528..HEAD`
- 日期:2026-11-11;环境:VM80,Node v24.21.0,真实 PG(独立 schema),真实模型 = magpie 本地路由(`127.0.0.1:3425`,本地假密钥,零真实成本)
- 裁决目标:闭合 P0-ACCEPT 遗留缺口 ①(US-02 P0 最小 Discovery 未实现 / US-01 模型面缺失)

## 1. 交付面

| 项 | 内容 | 证据 |
| --- | --- | --- |
| `discoveries` 表(迁移 0005) | id/goal_id/run_id/outcome/reason/report(jsonb)/content_sha256/model_ref/sandbox——**结果持久化,不依赖聊天上下文**;失败行如实保留 reason | `migrations/0005_discovery.sql`(仅增量;0003/0004 手工迁移的 snapshot 漂移已重新对齐) |
| Runtime 只读会话 | `src/runtime/discovery.ts`:role=discovery 独立 Run;`allowedCommands: []`(禁一切 exec,仅 relay_read);docker 模式 workspace 强制 FS 只读挂载(G-4 同款);预算经同一账本 reserve/settle;回合硬顶 + wall 双限;结构化围栏 ```relay-discovery(JSON)解析+最小 schema 校验(缺项即拒,不用默认值伪造);stub 注入口仅 host-fallback 测试用 | `src/runtime/discovery.ts` |
| Core 编排 | `src/core/discovery.ts:runGoalDiscovery`:goal 存在性+首任务校验(runs.task_id NOT NULL ⇒ 挂首任务)、**预算 FAIL-CLOSED**(无 model_calls 账本行/无上限 ⇒ 拒绝)、SUCCEEDED 落 report+SHA256、**FAILED 落 reason 不伪造**、审计 DISCOVERY_SUCCEEDED/FAILED;`latestDiscovery` 视图面 | `src/core/discovery.ts` |
| 三入口 | CLI `relay goal analyze <goalId> --project-dir <dir> [--budget-calls] [--stub]`(operator 门+预算声明+provider env 门);API `POST /api/goals/:id/discovery`(写门同口径;未配置 provider ⇒ 501 显式);**worker tick 不自动触发**(P0 显式调用,预算人控) | `src/cli.ts`、`src/server/api.ts` |
| 视图/来源徽章 | goalDetailView 新增 `discovery` 块:三态——model(模型报告+SHA+回放指针)/rules(失败或未运行;note 如实含失败原因)/failed 落记;Web Goal 页 Discovery 区块(来源徽章,规则面兜底不冒充) | `src/server/views.ts`、`web/goal.js`、`web/goal.html` |
| 能力登记表 | `goal.discovery.model`→IMPLEMENTED(P0 最小;本地调查;公网 Search/Crawler P1 仍 NOT_IMPLEMENTED)、`goal.recommendation.model`→IMPLEMENTED(有记录=模型;无/失败=规则面标注) | `src/server/capabilities.ts` |
| 注入抵抗(结构层) | 系统指令只由本层构造;工作区文件内容=被调查数据(prompt 显式声明+工具白名单空+OS 只读挂载三层强制);stub 测试断言 INSTRUCTIONS.md 注入语料后项目面原样、零 exec | `discovery.test.ts` 注入抵抗例 |

## 2. 真模型验收(RELAY_DISCOVERY_E2E=1 门;预算声明:reserveCalls=6/轮,goal 账本 8,wall 300s;3 例 188s)

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | **模糊 UX 需求**(F1 前身:"新增任务的页面不好用。"+ 真实示例项目) | ✅ SUCCEEDED:问题陈述/带置信度假设/**一个推荐行动**/可判定验收/来源文件;持久化 SHA 回放 |
| 2 | **不合理方案反驳**("用 eval 解析输入+同步加载大文件,就这么做。") | ✅ SUCCEEDED:报告指出 eval/同步阻塞/安全面(risks 非空;可核查反驳,持久化可回放) |
| 3 | **不完整需求**("把数据导出。"——无格式/字段/规模) | ✅ SUCCEEDED:形成可判定验收 + openQuestions 显式 + sources 可核查(不编造业务答案) |
| 4 | **预算耗尽自动停止** | ✅ 实锤:首轮 reserveCalls=3 时 3 例全部 `budget_turns_cap` 诚实止损(FAIL-CLOSED 不烧超预算调用;降行落 FAILED) |
| 5 | **断线恢复不伪造隐状态** | ✅ 语义面:run 失败如实 FAILED 落记;重跑=追加新记录(幂等追加测试 2 行实证),零伪造模型隐状态 |
| 6 | **注入抵抗** | ✅ 结构层恒真(白名单空+只读挂载):模型无论读到什么都无法 exec/写;真模型级注入语料化(T01)按登记并入阶段 D F3 |

## 3. 测试账

- `test/integration/discovery.test.ts`:**9 例**(6 stub 常跑 + 3 真模型门控)——解析校验 3 断言组/正链持久化+SHA+审计+runs(role=discovery)/降级 FAILED+视图徽章/预算 FAIL-CLOSED+账本核算/注入抵抗/幂等追加+CLI 全链+operator 门+provider 门。
- 全量回归:见提交信息(216+9=225 例;tsc 0)。
- 真模型调用统计:首轮 3×3=9 次(全部 budget_turns_cap 止损,如实落 FAILED)+ 终轮 3×6=18 次内(3 例 SUCCEEDED;账本 reserve/settle 核算)——全部经 budget_ledger,零真实成本。

## 4. 如实边界(不夸大)

- P0 最小 = 本地项目目录只读调查一次;**公网 Search/Crawler 未实现**(P1,登记表如实 NOT_IMPLEMENTED)。
- Discovery 不领取任务/不推进状态/不产生代码写入(零第二状态机);推荐采纳属 operator(D3 语义不变)。
- 真模型注入语料化测试(T01)未在本包语料化——结构层防线(白名单空+只读挂载)已实测恒真;语料化并入阶段 D(F3)。
- worker tick 自动 Discovery 触发未实现(P0 显式调用;自动触发属部署包编排)。

## 5. 遗留

无新增阻断;阶段 B 闭合 US-01 模型面 + US-02 P0 最小。下一步:阶段 C(GitHub 补验;PAT 权限单点)。
