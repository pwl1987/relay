# RELAY-RESULT-TRUTH-16R · ACTIVE 合同

状态：**ACTIVE**  
Writer：本地开发 Agent（单 Writer）  
基线：`df3ff59bd8cc852b1af981e8f7ad6d00e66e826c` 的后继治理提交  
生产权限：**无**  
性质：RELAY-RESULT-TRUTH-16 的最小纠偏，不扩范围。

## 一、唯一 Major

修复“旧 changeset 的用户验收被 Goal 级投影继承到新 changeset”的错误。

### 必须先红复现

构造同一 Goal：

1. changeset A = DELIVERED；
2. 用户接受 A，审计写入 `USER_RESULT_ACCEPTED{goalId, changesetId:A}`；
3. 后续产生 changeset B，且 B=FAILED 或 NONE；
4. 读取 B 的 changeset 详情、Goal 当前状态、workspace 当前结果。

**修复前必须证明错误：**
- B 不能显示 A 的“用户已接受结果”；
- Goal/workspace 当前结果也不能把 A 的验收当成 B 的验收。

## 二、冻结修复语义

### 1. 验收属于结果版本，不只属于 Goal

保留现有 append-only audit_events，不新增表/迁移。

推荐最小实现：

- `readGoalUserResult` 增加 changeset 维度，或拆出 `readChangesetUserResult`；
- changeset 详情按自身 `changesetId` 读取匹配验收；
- Goal/workspace 先确定**最新 changeset**，再读取该 changeset 对应验收；
- 若最新 changeset 没有对应 USER_RESULT_*，当前投影返回 null / “用户尚未验收当前结果”，即使旧 changeset 曾被接受或拒绝。

历史 audit_events 全保留，可用于历史追溯。

### 2. 写入时必须冻结当前结果身份

- UI 已有 changesetId 时继续显式提交。
- API 若 Goal 已存在 changeset：
  - 请求带 changesetId：验证必须属该 Goal；
  - 请求不带 changesetId：必须安全解析并冻结到当时最新 changeset，再把解析后的 changesetId 写进 audit detail；不得再写“有结果但无 changesetId”的漂浮验收。
- 若 Goal 完全没有 changeset，本包默认返回明确的 `result_not_available`（409 或等价 4xx），不要创建无版本身份的用户验收事实。
- deliveryState 快照必须来自被验收的那个 changeset，而不是“Goal 当前最新 changeset”与请求 changesetId 两套来源混用。

### 3. 当前结果换代后验收失效为“当前未验收”

A 被接受后出现 B：

- A 历史页面：仍正确显示 A 已接受；
- B 当前页面：显示用户尚未验收 B；
- Goal/workspace：按 B 显示尚未验收当前结果；
- 不自动生成 reject，不删除 A 的接受事件，不改变 task/Gate 状态。

## 三、顺手修正一个产品真相 Minor

`web/changeset.js` 第一屏结果摘要中的字段标签不得硬编码“GitHub”；改成中性的“仓库交付”或“交付状态”。具体 target/repo/branch 继续从现有 delivery proposal 事实展示。

不要扩展到 system 页或大规模文案重构，除非定向测试证明同一结果卡路径必须改。

## 四、验收矩阵

至少新增：

1. A accepted → 新 B FAILED：B changeset.userResult = null。
2. 同场景 Goal status/detail 当前 userResult = null。
3. 同场景 workspace 当前结果显示“用户尚未验收当前结果”。
4. 回看 A：仍显示 accepted。
5. A accepted → B accepted：当前投影只显示 B 的 acceptance。
6. A accepted → B rejected：当前投影只显示 B rejected + B 原因。
7. API 有 changeset 但省略 changesetId：冻结到请求时最新 changeset，并在审计 detail 写入解析后的 id。
8. API 无任何 changeset：拒绝写入 result acceptance，审计零新增。
9. 请求显式指定旧 A：允许对历史 A 留验收事实，但不得改变当前 B 的投影。
10. deliveryState 快照与被绑定 changeset 一致。
11. 结果摘要字段不再硬编码“GitHub”。
12. 16 原有 result-truth 10 integration + 6 browser、three-dirs、dirty-project、goal idempotency、web journey 不退化。

必须至少有一条真实 PG + Web API + Browser E2E 覆盖“A 验收后出现 B，B 不继承 A”。

## 五、边界

禁止：

- 新表 / migration；
- 修改 Goal/Task 状态机；
- 生产写入/重启/凭据；
- 重构三目录模型；
- unrelated UX/CSS 重做；
- 清理历史 dirty/protected 文件；
- `git add -A`。

## 六、完成定义

只有在“验收事实与结果版本身份”严格一致、旧验收不再污染新结果，并且定向反例、quality:full、exact-head test/e2e、独立 Reviewer 全绿后，16 才可真正收口。
