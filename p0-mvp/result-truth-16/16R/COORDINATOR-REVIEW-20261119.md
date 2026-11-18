# RELAY-RESULT-TRUTH-16R · 协调方独立复核

日期：2026-11-19  
实施提交：`6a2f51fe6d00510b7424c2dc04998447eefe2d7c`  
exact-head CI：`44340057681`

## 裁决

**PASS（0 Major）**。

本裁决基于 live main、提交边界、exact-head CI 日志、源码语义检查和协调方独立构造的真实 PG 反例，不采信 Agent 自述作为验收依据。

## 独立核验事实

- live main = VM80 HEAD = origin/main = `6a2f51fe6d00510b7424c2dc04998447eefe2d7c`。
- Writer lock 空闲；本包目标文件无未提交漂移。
- exact-head CI `44340057681`：
  - test job：success；
  - e2e job：success；
  - unit：**191/191**；
  - 非浏览器：**517 passed / 103 skipped = 620**；
  - browser：**83 passed / 2 skipped = 85**；
  - 16R integration 8/8 真跑；
  - 16R browser 2/2 真跑。
- 协调方独立复跑：
  - 16R + 16 integration：**18/18**；
  - 16R + 16 browser：**8/8**。
- 源码确认：
  - changeset 详情按自身 changesetId 读取用户验收；
  - Goal/workspace 当前验收先解析最新 changeset，再读取该版本验收；
  - 无当前版本验收即 null，不继承旧版本；
  - API 省略 changesetId 时冻结请求时最新 changeset；
  - Goal 无 changeset 时返回 result_not_available，不产生漂浮验收；
  - deliveryState 快照来自被验收的具体 changeset；
  - 结果摘要字段已改为中性“仓库交付”。

## 协调方原始 Major 反例复测

独立一次性 PG schema 构造：

1. A = DELIVERED；
2. 写入 USER_RESULT_ACCEPTED(changesetId=A)；
3. 后续新增 B = FAILED；
4. 读取 A、B、Goal 当前投影。

实际：

- A.userResult = accepted；
- B.userResult = null；
- Goal.current.userResult = null；
- audit 历史仍保留 A 的 accepted 行。

说明“旧结果验收污染新结果”已闭合，且历史事实未被覆盖或删除。

## 非阻塞观察

“最新 changeset”仍使用 `ORDER BY created_at DESC`，无次级确定性排序。当前链路为串行写入，且现有所有投影口径一致，不构成本包阻断；登记为后续正确性加固候选，不单独制造包。

## 结论

RESULT-TRUTH-16/16R 产品真相层可以冻结：内部 Gate、仓库交付、执行来源、用户验收现在是相互分离且可追溯的事实。
