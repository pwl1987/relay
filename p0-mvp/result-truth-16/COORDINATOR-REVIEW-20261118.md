# RELAY-RESULT-TRUTH-16 · 协调方独立复核

日期：2026-11-18  
实施提交：`df3ff59bd8cc852b1af981e8f7ad6d00e66e826c`  
GitHub Actions：`44311004493`

## 裁决

**REWORK（1 Major）**。

Agent 本地 Reviewer 与 exact-head CI 均为绿，但协调方独立构造了合同未覆盖的“结果换代”反例，证明当前用户验收投影会把旧变更集的验收事实错误继承到新的当前结果。

## 已核实通过的部分

- live `main` 与 VM80 本地均为 `df3ff59bd8cc852b1af981e8f7ad6d00e66e826c`，正常 main 快进，Writer lock 空闲。
- 提交边界为 18 文件、+2595/-114；未夹带 `config/`、`soak-r3b/`、历史截图/日志/CI 回执。
- exact-head CI `44311004493` 双 job success：
  - unit 191/191；
  - 非浏览器 509 passed / 101 skipped = 610；
  - browser E2E 81 passed / 2 skipped = 83；
  - result-truth integration 10/10、browser 6/6 真跑。
- 过期“尚未接入 GitHub 推送”声明已删除；goal 时间线已按最新 changeset 判定；stub/live provenance 已进入结果面；“查看修改详情” dead control 已修复；USER_RESULT_* 使用 append-only audit_events 且不修改 task/Gate、不触发 Run。

## Major-1：旧结果验收会污染新结果

当前 `readGoalUserResult(db, goalId)` 只按 Goal 取最新一条 `USER_RESULT_ACCEPTED/REJECTED`：

```text
Goal G
  ├─ changeset A = DELIVERED
  │    └─ USER_RESULT_ACCEPTED(changesetId=A)
  │
  └─ 后续产生 changeset B = FAILED
       └─ 当前结果页 B
```

协调方在一次性真实测试 schema 中独立构造该场景后，读取：

`changesetDetailView(db, "cs-new-current")`

实际得到：

```json
{
  "currentChangeset": "cs-new-current",
  "currentDelivery": "FAILED",
  "projectedUserResult": {
    "decision": "accepted",
    "changesetId": "cs-old-accepted"
  }
}
```

即：**当前 B 已失败，但 B 的结果页会展示“用户已接受结果”，实际接受的是旧 A。**

根因不是 audit_events，而是投影维度错误：用户验收事实属于“某一版结果”，不能只按 Goal 读取。

这违反本包目标“结果页每一句结论由当前真实事实推导”，属于 Major。

## 次要真实性问题

`web/changeset.js` 第一屏仍把交付行标签写死为“GitHub”，而测试/预览允许本地 bare 或其他仓库目标。虽然值已改为“已提交到仓库”，标签本身仍可能误导。16R 一并改为中性“仓库交付/交付状态”，不另开包。

## 16R 纠偏原则

- audit_events append-only 设计保留，不加表、不迁移。
- 用户验收必须冻结到**具体结果身份**；当前已有 changeset 时不得产生无 changesetId 的“漂浮验收”。
- 历史 changeset 页面应显示该 changeset 自己的验收事实。
- Goal/workspace 当前投影只能显示“当前最新 changeset”的验收；如果只有旧 changeset 的验收，当前结果必须显示“尚未验收当前结果”，不能继承旧事实。
- 旧验收历史不删除、不覆盖，只是不再冒充当前事实。
