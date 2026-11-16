# REVIEW-RELAY-GOAL-CREATE-IDEMPOTENCY-12(独立 Reviewer 终裁)

- 被审提交:`854204bd35c9c70f31a27f7f79063b5b97ab96cb`(实施;父提交 `809291f`=协调方合同登记)
- Reviewer:全新上下文隔离冷启动;工作全程在临时克隆 `/tmp/review-12-clone`(detached 854204b);零 commit/零 push/零生产触碰/零真实模型;未修改被审代码(唯一例外=红态复现的临时反向补丁 `git apply -R`,复现后 `git checkout --` 逐字恢复,`git diff` 核零残留)。
- **终裁:PASS(0 Major;4 Minor,全部登记性质/收口建议,不阻断)**

## 一、冷启动核对(授权步骤 1)

- 克隆 HEAD == `854204bd35c9c70f31a27f7f79063b5b97ab96cb`,克隆内工作区初始干净。
- `git show 854204b --stat`:**恰 16 文件**,+1746/-32:REPORT 1、evidence 6(JSON×2/日志×4)、截图 6(audit-red×3/verify×3)、`src/server/api.ts`(+195/-40)、`test/e2e/webux12-goal-idempotency.test.ts`(新增 706 行)、`web/workspace.js`(+103/-16)。改动面与授权完全一致;零受保护未跟踪物(config/、soak-r3b/、历史 CI 回执)被纳入提交。
- `CURRENT.md` 合同 12 全文(行 3-12)与 `REPORT-RELAY-GOAL-CREATE-IDEMPOTENCY-12.md` 已逐字读;REPORT 主张与合同 A-E 各项对应关系成立。
- 合同 E 要求的 MAC-ACCEPTANCE-CARD.md 过期警告修正:已在父提交 `809291f` 完成,顶部现为「12 包正在纠偏…完整接受须等 12 幂等问题关闭」口径,符合合同文本。
- 主仓只读观察(冷启动时):HEAD==854204b,`git status --porcelain` 仅 10 项未跟踪保护物/历史证据,零已跟踪修改;收口复核时再次核对一致(见 §五)。

## 二、独立红态复现(授权步骤 2)

- 操作:`git diff 809291f 854204b -- src/server/api.ts web/workspace.js > /tmp/rev12.patch`(357 行)→ `git apply -R` → 反向应用后 grep 确认两文件幂等代码(0 处 `idempotency`/`GOAL_CREATE_KEY_STORE`)。
- 第一次运行 `RELAY_E2E=1 WEBUX12_TAG=review-red npx vitest run test/e2e/webux12-goal-idempotency.test.ts`:**7 failed | 3 passed (10)**(Duration 4.48s)。
- 第二次运行(取完整失败清单+验证可重复性):**再次 7 failed | 3 passed**,失败清单两次完全一致:
  - 失败(恰 7,全部翻红断言红)= **T1**(桌面 ACK 丢失重试应同 Goal,红态 Goal 数 +2)、**T7**(刷新后重试,17≠16)、**T1m**(手机 390×844,19≠18)、**T2**(并发同键应同 goalId,红态 [201,201] 两 id)、**T3**(同键异 payload/绑定/跨会话应 409,红态全 201 新建)、**T4**(非法键应 400 零创建,红态被忽略照常创建)、**T8**(同键重放应同 id/DB 恰一套,红态 201 新 id+两套副作用)。
  - 通过(恰 3,控制组)= **T5**(旧客户端无键两建)、**T6**(不同键同文案两建)、**T9**(浏览器错误分类门)。
- 与 REPORT §2 主张(红 7/控制 3)及协调方登记的失败集合逐项一致。
- 恢复:`git checkout -- src/server/api.ts web/workspace.js` → `git diff` 为空(**零残留**),HEAD 仍 854204b。

## 三、独立绿态复现与证据亲核(授权步骤 3)

- `RELAY_E2E=1 WEBUX12_TAG=review-verify npx vitest run test/e2e/webux12-goal-idempotency.test.ts`:**10 passed (10)**(EXIT=0,Duration 4.45s)。运行时代码=854204b 原样(恢复后)。
- 亲看克隆内本轮生成截图 `screenshots/review-verify/`(3 张)与入库截图(3+3 张):
  - 绿态 `t1-d01`:「创建失败,请稍后重试」+草稿「T1 桌面 ACK 丢失重试幂等」保留在输入框,侧栏 T2/T3/T8 各恰一条(同键幂等生效;T5/T6 各两条=不同意图,正确);绿态 `t1-d02`:重试后进入该 Goal 详情(进行中/排队中),恰一个 Goal;`t1m-m01`:手机视口同型。
  - 入库 `audit-red/t1-d01` 直证 REPORT §2 主张:侧栏 T2×2、T8×2、T3×2 成对重复+报错+草稿同屏。入库红/绿截图与我独立复现产物同型。
- 亲核本轮 `evidence/webux12-goal-idempotency-review-verify.json`(tag=review-verify,11 步):T1 sameGoal=**true**(lost==retry=`goal-14815f60…`,afterRetry 恰 +1)、T2 **[201,200] 同 goalId**(`goal-cf80ec55…`)、T3 **[201,409,409,409] 且 Goal 数恒 8**、T4 **400×5 + mid==before(零创建)+ 合法 UUID 201**、T8 **201→200 同 id + idempotentReplay=true + DB 恰一套(1 Goal/1 Task/1 消息/1 消费/1 预算;审计 GOAL_PLANNED=1/TASK_PLANNED=1/WEB_GOAL_CREATED=1)**、T7/T1m sameGoal=true、T9 真实错误 0 且注入噪声 2+1 与注入次数对账。与入库 verify JSON(11 步)及 REPORT §4 主张完全同型。
- 入库日志抽查:`webux12-verify-green.log` 10/10;`webux12-e2e-regression.log` **56 passed | 2 skipped**(2 skipped=03C/03D 显式证据门);`webux12-quality-quick.log` lint/format/typecheck/unit **182/182** 全 PASS,总裁决 PASS——与 REPORT §4 数字一致。全量回归本 Reviewer 未独立重跑(授权限定只跑指定 harness);CI e2e job success 为独立佐证(见 §五)。

## 四、实现审查(授权步骤 4;合同 C/E 重点逐项)

以 `git diff 809291f 854204b` 全文+现行文件走查,逐项核验:

1. **键格式门与无键兼容**:✔ `x-relay-idempotency-key` 可选;空/缺省⇒`keyGoalId=undefined`⇒路径与旧代码完全一致(T5 控制实证);非 UUID 形态(8-4-4-4-12 hex RE,大小写不敏感)⇒400 `idempotency_key_invalid` 且零创建(T4 实证:400×5 且 mid==before)。定长 RE 同时限定容量。`trim()` 后过门,无绕过面。
2. **派生主键与持久性**:✔ `goalIdForCreateKey`=`goal-`+SHA-256(`relay:goal-create:v1:<key>`)切 8-4-4-4-12 UUID 形态,与既有 `goal-<uuid>` 同形;确定性⇒同键重试落同一 `goals.id` PK。持久幂等唯一载体=Goal 行本身:**零新表/零迁移/零 schema 变更/零 process-local 状态**(api.ts 仅新增纯函数+SQL 查询),跨重启为结构性结论(与 goals.ts:38 `spec.id ?? randomUUID()` 既有显式 id 能力对接,零 Core 改动)。
3. **重放一致性三要素与 409 fail-closed**:✔ `resolveGoalCreateReplay` 只读:内容=`goals.raw_input` 等值(与写入同源 `deriveDefaultPlan().rawInput`);操作者=GOAL_PLANNED 审计 `actor` 比对(与 Goal 同事务必然存在;行缺失时跳过 actor 检查,注释如实声明为保守选择);项目绑定=初始 Task `allowed_scope`(经消费映射 JOIN tasks,缺失时 GOAL_PLANNED detail.tasks 兜底)vs `expectedScope`,且**创建与比对共用同一表达式**(expectedScope 单点定义,防口径漂移)。任一不一致⇒409 `goal_create_key_conflict` 零新建(T3 三重 409 实证;SHA-256 碰撞场景内容必不一致⇒409,不会错误重放)。
4. **并发事务**:✔ 创建包 `deps.db.transaction`;INSERT 撞 PK⇒`isUniqueViolation` 查 `err.code` 与 `err.cause.code` 两级 23505(drizzle 包装+原生 pg,实测两级都查)⇒事务回滚零部分状态⇒转 `resolveGoalCreateReplay`(同内容⇒200 重放/不一致⇒409);赢家回滚⇒键未消费⇒输家 INSERT 自然成功。T2 并发 [201,200] 同 goalId 实证。非唯一约束错误原样 rethrow(不吞)。
5. **首消息+消费映射入创建同事务**:✔ `goal_messages` INSERT+`goal_message_consumptions` INSERT 从事务外移入 planGoal 同一事务,原子可见;ACK 丢失重放读到的必是完整初始事实。消息内容/actor/kind 未变(WEB-UX-03C 首条消息语义保持);WEB_GOAL_CREATED 审计保持既有事务后 best-effort 语义。
6. **禁令逐条**:✔ 不按 rawInput 去重(无键不去重,T6 实证;rawInput 仅用于同键内容比对);不 sleep/时间窗(无任何延时,唯一约束瞬时报决);无 process-local Map(纯函数派生);不吞 5xx(catch 仅识别 23505,其余 rethrow;前端 5xx 保留键);前端不冒充服务端唯一性(workspace.js 仅提供键+清键,判定全在服务端;11R `creatingGoal` 在途旗标原样保留只管同页双击)。
7. **CSRF/Registry/Operator 授权零绕过**:✔ api.ts handleApi 写方法统一先过 `verifySameOrigin`+`verifyCsrf`+`operatorAllowed`(api.ts:308-325),幂等键解析位于 rawInput 校验(400)、项目注册表解析(unknown_project 400)**之后**;浏览器提交路径仍被忽略(路径唯一来源=注册表)。键头不参与任何授权判定。
8. **11R UI 语义未推倒**:✔ workspace.js diff 仅限新增键生命周期函数+`createFromComposer` 的请求通道替换(payload 构造/成功清键/409 分支);终态「新建后续任务」/PAUSED 指引/ACTIVE 双操作/在途旗标/双按钮禁用/草稿保留全部原样;`createGoalRequest` 自持 fetch 语义与 `A.apiPost` 一致(credentials/CSRF 头/401 跳转/err.status+err.payload),不扩展 apiPost 的原因(app.js 既有 format 漂移)已如实登记。测试断言面与 REPORT 一致(10=7 翻红+3 控制;断言逐条与 §2/§4 对应,含 T8 的 facts 七项恰一套断言与 T9 的分类门上界断言)。

## 五、边界与证据(授权步骤 5)

- **生产 PID 前后一致**:基线(审查开始)relay-web=3242781 / relay-worker=3242782;收口复核同值,**零变化**。零生产读写/重启/配置触碰。
- **主仓只读复核**:`git -C /home/ubuntu/dev/relay status --porcelain` 前后均 10 项未跟踪(config/、soak-r3b/、8 份 CI 回执),HEAD 恒 854204b,零修改。Reviewer 全程未写主仓。
- **测试残留零**:授权测试 PG(relay-p000-pg,127.0.0.1:55433)内 `p01a_%` schema 0 行、临时库 0——harness 自建自毁兑现;本 Reviewer 三轮运行(review-red×2/review-verify×1)亦零残留。
- **CI 独立核验**:`gh api repos/pwl1987/relay/commits/854204b…/check-runs` → **e2e=success(completed)、test=success(completed)**,双绿已收口,满足合同 E「exact-head CI test/e2e 双成功」。
- **REPORT §2/§3/§4/§6 与克隆内证据互证**:红 7/绿 10/控制 3、T1-T8 各数字、56p|2s、quality quick 182/182、NOT_RUN 清单(第二操作者/非 ASCII 传输面/kill -9 注入/真模型/生产迁移)均与证据文件吻合;§6 NOT_RUN 如实,无冒充主张。
- 本 Reviewer 未跑 `quality:full` 与 vitest 全量(授权禁止),该面以 CI 双绿+入库日志为据,如实声明。

## 六、发现分级

**Major:无。**

**Minor(4,全部不阻断;给出消化建议):**

- **Minor-1(绑定比对顺序敏感)**:`resolveGoalCreateReplay` 以 `JSON.stringify(scope ?? []) !== JSON.stringify(expectedScope)` 比较数组,顺序敏感。当前 `expectedScope` 恒为单元素数组(绑定=[path]/未绑定=["/workspace"]),不可达;若未来默认计划变多任务/多作用域且顺序在不同路径漂移,会产生误 409(方向 fail-closed,不会错误重放)。建议收口后登记:排序后比较或集合比较。
- **Minor-2(actor 检查的不可达降级分支)**:GOAL_PLANNED 审计行缺失时跳过操作者比对(代码注释已如实声明)。该审计与 Goal 同事务写入,现路径必然存在;若未来审计写法改变,该检查会静默降级。单操作者模型下风险极低,登记即可。
- **Minor-3(23505 识别深度)**:`isUniqueViolation` 查两级 cause;若 drizzle 未来加深包装,识别失效会退化为 500(结果未知)——前端保留键+重试⇒重放面兜底仍收敛到幂等语义,fail-safe 方向。登记即可。
- **Minor-4(MAC 卡口径时点)**:MAC-ACCEPTANCE-CARD.md 顶部现为「12 包正在纠偏…等 12 幂等问题关闭」(809291f 按合同 E 修正,当时准确)。854204b 合入 main 后该表述略滞后于事实(修复已在 main)。属收口流程自然时点问题:按合同 E 在收口提交更新 CURRENT/CONTINUATION 时一并把 MAC 卡口径刷新为「12 已实现、待用户实机验收」即可,历史证据不重写。

红轮演进三项(夹具登录缺陷修复/T9 分类门/T4 ASCII 化)REPORT §2 已如实登记,不列为新发现。

## 七、终裁理由

合同唯一可交付结果(POST /api/goals 跨回执丢失/并发重发/刷新后重试的持久幂等,同键异内容/绑定/操作者 fail-closed,无键兼容,不按纯文本永久去重)已由独立红绿复现、DB 事实核验、实现逐行走查三路证实;设计为最小实现(两文件,零新表/零迁移/零 Core/零新 API),持久性结构性成立;全部硬禁令逐条核对未违反;生产零触碰(PID 前后一致)、保护物零纳入、测试零残留;CI exact-head 双 success 独立核验。4 项 Minor 均为登记/收口建议性质,不构成 REWORK 依据。

**终裁:PASS。** 本 REVIEW 为独立复核意见;Agent 的 DONE 不是验收,用户 Mac 实机 UX ACCEPTED、生产 GO、真模型/24h 等验收层归属不变(生产预检 NO-GO 维持,生产切换须用户按 D3 单独批准)。

---

### 关键数字摘要(Reviewer 亲跑)

| 项 | 结果 |
| --- | --- |
| 冷启动 | HEAD==854204b;16 文件改动面=授权面;保护物零纳入 |
| 红态(review-red,两次) | **7 failed | 3 passed**,失败集两次一致=T1/T7/T1m/T2/T3/T4/T8;通过=T5/T6/T9 |
| 绿态(review-verify) | **10/10 passed**(EXIT=0) |
| T1/T7/T1m | sameGoal=true,Goal 数恰 +1 |
| T2 | [201,200] 同 goalId(`goal-cf80ec55…`) |
| T3 | 201,409,409,409;Goal 数恒 8(零新建) |
| T4 | 400×5+零创建+合法 UUID 201 |
| T8 | 201→200 同 id+replayFlag=true;DB 恰 1/1/1/1+审计 3 项各 1 |
| 恢复零残留 | `git diff` 空;PG p01a_% schema 0 |
| 生产 PID | 3242781/3242782 前后一致 |
| CI(gh 独立核验) | 854204b:e2e success+test success(completed) |
| Reviewer 边界 | 零 commit/零 push/零生产写入;反向补丁已逐字恢复 |
