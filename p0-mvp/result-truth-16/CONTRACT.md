# RELAY-RESULT-TRUTH-16 · ACTIVE 合同

状态：**ACTIVE**  
Writer：本地开发 Agent（单 Writer）  
基线：`b50ba29f343d2ea295d0cc5c59317f3ac3e6d8b7` 的后继治理提交  
生产权限：**无**  
范围：结果真实性、用户验收事实、结果页可操作闭环；不扩生产、不改部署。

## 一、最终目标

用户在“工作区 / Goal / 验收结果”看到的每一句结论都必须能由真实事实推导；用户必须能够对一个已产生结果的 Goal/变更集明确做出“接受结果 / 拒绝结果并说明原因”的动作，而且该动作不能与内部 Gate 的 `task ACCEPTED` 混为一谈。

本包解决的是**产品真相层**，不是视觉重做。

## 二、必须先独立审计的已知问题

以下仅作为审计入口，Agent 必须读 live 代码后确认，不能直接照单修改：

1. `web/changeset.js` 仍存在静态说明“当前 Console 部署尚未接入 GitHub 推送交付”，与最新三目录/内建 delivery 能力发生事实漂移。
2. 工作区虽然已按最新 changeset 的 `delivery_state` 分档，但结果页仍需要核实是否存在任何“成功文案先于事实”的路径。
3. “验收结果”当前主要是只读展示；代码层明确区分“task ACCEPTED ≠ Goal 已被用户验收”，但缺少用户验收事实写入闭环。
4. “查看修改详情”按钮必须核实是否真的把用户带到可见、可理解的 diff/不可用原因；不能保留无效果按钮。
5. stub/demo/live/external 执行来源必须在结果卡可辨识，不能把桩执行与真实模型执行显示成同一种结果。

## 三、冻结设计原则

### 1. 结果文案必须由事实推导

至少以这些现有事实为依据：

- `candidate_changesets.delivery_state`
- Git commit / remote head（存在时）
- task / Goal 状态
- Run 的执行来源/模型/沙箱事实
- Gate evidence / reviewer verdict

禁止根据“页面已进入完成态”“按钮被点击”“有 candidate”推断“已交付”。

`NONE / FAILED / CONFLICT / DELIVERING / DELIVERED` 必须分别有诚实文案；无证据时显示“未验证/未知”，不能猜。

### 2. 用户验收是独立事实，不修改内部 Gate 含义

- `task ACCEPTED` 继续只表示内部 Gate/Reviewer 通过。
- 新增“用户接受结果 / 用户拒绝结果”事实面，优先复用 append-only `audit_events`，不得为了本包新增表或 migration。
- 建议事件语义：`USER_RESULT_ACCEPTED` / `USER_RESULT_REJECTED`（具体名称可在审计后最小调整）。
- 事件必须绑定 Goal，能绑定 changeset 时同时绑定 changeset；记录 actor/时间；拒绝必须允许简短原因。
- 重复相同操作必须幂等或产生可解释的追加历史，不能形成状态互相覆盖而无审计。
- 不自动触发新模型 Run、不自动改代码、不自动把拒绝变成 FAILED；拒绝后只提供明确的“新建后续任务/继续说明”入口。

若现有 `audit_events` 无法安全承载上述事实，**停止并报告**，不得自行扩 schema。

### 3. stub/demo 必须显式

结果卡必须能回答：

- 这是 live 模型执行、stub 演示，还是 external worker？
- 如果只能证明部分链路，明确写“演示/桩/未验证”，不能冒充真实模型交付。

优先复用已有 Run / worker mode 事实，不增加第二套来源。

### 4. 修改详情必须真的可达

“查看修改详情”只能在以下二者之一成立时出现：

- 有真实 diff，可点击后把焦点/视口带到 diff，并能读到内容；
- diff 不可用，但进入明确的“为什么不可用”说明。

无效果按钮必须删除或修复。

## 四、实施范围

允许修改：

- `src/server/api.ts`
- `src/server/views/*` 中结果/Goal/changeset 相关文件
- `web/changeset.*`
- `web/workspace.js`
- `web/goal.js`
- 必要的现有测试与新增本包定向测试
- 本包 `p0-mvp/result-truth-16/` 报告/证据

默认禁止：

- migrations / schema 新增
- 生产配置、生产数据库、服务重启
- GitHub 真实远端写入
- 重新设计三目录模型
- 大规模 CSS/视觉重做
- unrelated cleanup
- 清理 `config/`、`soak-r3b/`、历史截图/日志/CI receipts

## 五、先红后绿验收

至少覆盖这些反例：

1. `delivery_state=NONE` 时结果页绝不能出现“已提交/已交付成功”。
2. `FAILED/CONFLICT` 时必须显示失败/冲突且不给成功语气。
3. `DELIVERED` 且 remote head 存在时才能显示可验证交付信息。
4. stub 执行结果卡必须明显标“演示/桩”，live 结果不得被误标。
5. 用户接受结果：API 写入真实 append-only 事实，重新加载仍可见。
6. 用户拒绝结果：原因落审计，重新加载仍可见；不得自动改 task Gate 状态。
7. task ACCEPTED 但用户未验收时，UI 必须明确“内部复核已通过 / 用户尚未验收”。
8. “查看修改详情”真实可达；diff 不可用时明确原因，不允许 dead control。
9. 重放/重复点击不会生成互相矛盾的最终展示。
10. 既有三目录、dirty-project、Goal 创建幂等、Web journey 不退化。

## 六、验证要求

- 定向 unit/integration 先红后绿。
- 至少一条真实 PG + Web API + 浏览器 E2E，覆盖“交付事实 → 结果页 → 用户接受/拒绝 → 刷新后仍保持事实”。
- `quality:full`。
- exact-head CI 的 `test` 与 `e2e` 均 success。
- 独立 Reviewer 不得仅看测试名，必须构造至少一个“内部 ACCEPTED 但未 DELIVERED / 未用户验收”的反例。

## 七、停止条件

出现以下任一情况立即停止并报告，不自行扩大：

- 必须新增表/迁移才能实现；
- 需要生产写入/重启/凭据；
- 需要改变 Goal/Task 状态机语义；
- 发现三目录模型本身存在新的 Major；
- 工作树出现无法解释的冲突或 Writer 竞争。

## 八、完成定义

本包只有在以下全部成立后才可报 DONE：

- 结果页不再有已知静态假成功/过期能力声明；
- stub/live provenance 可见；
- 用户接受/拒绝形成真实可追溯事实；
- 内部 Gate 与用户验收语义完全分离；
- 修改详情入口可用；
- 定向反例、全回归、exact-head CI 全绿；
- 独立 Reviewer PASS；
- 生产影响仍为零。
