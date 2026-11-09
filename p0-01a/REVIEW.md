# P0-01A 独立对抗复核报告

- **复核人**:独立上下文 Reviewer(全新会话,与实现会话无共享记忆;仅依据 live 仓库 cc07804 与权威文档)
- **日期**:2026-11-09
- **被复核 HEAD**:`cc078049f29a9eff959f13b1c3dec26b1e76e878`(工作区 clean,无未解释脏状态)
- **复核人亲测**:
  - 主工作区 `/home/ubuntu/dev/relay` @ cc07804:`npm test` → **11 文件 / 34 测试全部通过**(26.0s,exit 0),`npx tsc --noEmit` → 0 错误。
  - `/tmp` 独立克隆副本(clone 自本仓库,HEAD==cc07804):`npm test` → **34/34 通过**(25.9s)。测试 PG `relay-p000-pg`(127.0.0.1:55433)运行中,测试后 `pg_namespace` 遗留 schema 计数 = 0。
  - 迁移一致性:在 /tmp 副本运行 `drizzle-kit generate`,输出 SQL 与已提交 `migrations/0000_cute_lorna_dane.sql` **逐语句 IDENTICAL**(仅文件名与 `"public".` 前缀差异)。

---

## 逐项结论表

| # | 复核项 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 提交与边界 | **VERIFIED** | cc07804 仅新增 `p0-01a/evidence/fresh-clone-repro.log`;ff0b1d1 的 41 个文件全部落在 CURRENT.md 白名单内。`git ls-files \| grep -E 'node_modules\|dist/'` 为空。`p0-00/exp-c/node_modules` 在 5901a06 中为符号链接(mode 120000 → `../exp-b/node_modules`),ff0b1d1 已从索引删除并补独立 `package.json`(依赖仅 `pg`)。备注:exp-c/package-lock.json 超白名单字面,见 F-6 |
| 2 | schema 与迁移一致性 | **VERIFIED**(1 项 MAJOR 缺口) | /tmp 副本 `drizzle-kit generate` 与已提交迁移 IDENTICAL;migrations SQL 0 处 `"public".` 硬编码(grep 无命中);`db.ts:69` 运行时再剥离 `"public".` 作双保险(search_path 隔离依赖此语义)。`AUDIT_APPEND_ONLY_GUARD`(db.ts:38-48)以 `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` 保证幂等,每 schema 迁移后附加,**但守卫不含 TRUNCATE**(F-1) |
| 3 | 状态机完整性 | **VERIFIED** | `lifecycle.ts:40-64` TRANSITIONS 覆盖架构 §3 图中全部转移:主链 7 态、`NEEDS_RECONCILE→READY/BLOCKED`、`RUNNING/VERIFYING→REWORK→READY`、`READY/RUNNING→NEEDS_DECISION/PAUSED/BLOCKED/FAILED` 全部存在;代码新增项均为指向 FAILED/CANCELLED 的收口或 LEASED/SUBMITTED/VERIFYING→NEEDS_RECONCILE 的恢复出口,**无"架构允许但代码禁止",无跳链/终态复活类"代码允许但架构禁止"**。单元测试覆盖主链、13 条非法转移、终态锁定。边界:PAUSED/NEEDS_DECISION/BLOCKED→READY 表内合法但当前公开 API 无合法执行路径(F-2) |
| 4 | Lease/Fencing 语义 | **VERIFIED**(2 项 MINOR) | 单事务:`claimTask/advanceTask/heartbeat` 全部 `FOR UPDATE` 行锁→校验→变更+审计→提交,调用方均以 `db.transaction` 包裹。校验顺序:终态(lease.ts:195)→无租约(196)→fencing(198,**先于 owner 校验**,注释说明防泄漏)→owner(199)→live(200)→fromState(201)→转移表(202)→Gate(203)。fencing 单调依赖 leases 行永不删除:schema.ts:3 声明,release 仅置 `lease_expires_at=now()`(lease.ts:214-219),UPSERT 同行 +1(132-140)。**TTL=权威窗口如实声明而非掩盖**:lease.ts:7-8 注释明示 B3b 契约,v04 测试 62-68 行正向断言"窗口内已死 Worker 旧 Token 推进成功"。heartbeat 续租(234-265):成功不写审计(高频,注释说明),拒绝全部留痕。缺口:F-3(heartbeat TOCTOU) |
| 5 | Reconcile 语义 | **VERIFIED**(1 项 MINOR) | `executeIntent`:前置核对(152-170,不匹配 ⇒ CONFLICT+REJECT_NO_FORCE_PUSH)→标 EXECUTING(172)→外部动作→COMPLETED(211);EXECUTING 重入拒绝(144-146,`already_executing_reconcile_first`)。`reconcileIntent` 三分类判定(256-278)与 CURRENT.md 一致;REMOTE_MOVED ⇒ intent CONFLICT + task BLOCKED(271-277,WHERE 集缺 SUBMITTED/VERIFYING,F-4)。**"绝不盲目重试"排查未发现违反**:①FAILED 意图重入须经前置核对(188-204,"抛错=无副作用假设"已声明,且 reconcile 对 FAILED 意图仍先查真实状态兜底);②supervisor b 步(63-140)只 reconcile 从不重做;③claimTask 拒绝含 EXECUTING 意图的任务(119-122,`executing_intents_need_reconcile`);④ABSENT 重置 RESERVED 后无任何自动重执行循环(保守正确) |
| 6 | 测试质量(对抗审查) | **VERIFIED** | 见下文"关键测试对抗审查"小节;三个重点测试断言强度经攻击后仍成立 |
| 7 | 真实运行 | **VERIFIED** | 复核人亲测两轮 34/34(主工作区 + /tmp 独立副本),tsc 干净;细节见头部 |
| 8 | 凭据/安全扫描 | **VERIFIED** | 扫描 `ghp_/github_pat_/xox/AKIA/BEGIN * PRIVATE KEY/ssh-rsa/api[_-]?key/secret/token`:唯一命中为 `fencingToken` 标识符(误报)。唯一连接串 `postgresql://postgres:relayp000local@127.0.0.1:55433`(db.ts:10、scripts/test-db-up.sh:17),与授权完全一致;URL 命中仅 127.0.0.1/localhost;mock git 用 `os.tmpdir()` mkdtemp(fault-injection.ts:117);无 gh/ssh/scp/pi install 调用;git-push 执行器刻意不带 --force(git-push.ts:28-36) |
| 9 | 诚实性 | **VERIFIED**(1 项 MAJOR 修正) | CURRENT.md 八条 Outcome 逐条兑现(第 8 条的 push/CONTINUATION 更新按合同排在本次复核之后,属既定待办,见 F-9)。B3b 契约未掩盖、拒绝路径未美化;测试自 ff0b1d1 一次性提交后零改动(cc07804 仅加证据日志),仓库内不存在放宽断言的历史。"Vitest 34 全绿、真实 SIGKILL、每文件独立 schema、全新克隆复现"均经复核人独立复现证实。修正项:append-only 承诺对 TRUNCATE 不成立(F-1) |

### 关键测试对抗审查(第 6 项细节)

**v04-crash-recovery(V04/B3/B3b)**
- SIGKILL 机制可靠:`spawnHelper` 以 `spawn(process.execPath, [helper.ts])` 直接产生 node 进程(fault-injection.ts:27-30),无 shell 包装;`kill9AndAssertDead`(40-52)= `child.kill('SIGKILL')` + `exited` promise(once 'close')+ `ps -p <pid>` 轮询核验死亡。pid 复用只可能造成误报失败(安全方向),不会假绿。
- B3b 断言是**如实声明契约而非掩盖**:62-68 行正向断言窗口内已死 worker-A 以旧 token 推进成功,注释明示"已知契约,非缺陷";随后在窗口外/被接管后断言同一 token 被拒(fenced/owner_mismatch)。
- 审计断言精确到 14 步全序列(121-134),含两次 CLAIM、三次 ADVANCE_REJECTED、GATE_PASS,无法被部分通过的弱实现蒙混。
- append-only 断言为结构性验证:UPDATE/DELETE 均被拒且错误信息含 append-only,再查 `action='TAMPERED'` 计数为 0(138-145)。
- 弱点(可接受):9.5s sleep 依赖墙钟,属集成测试常规;TTL 8s 下测试时长 10.5s 合理。

**v05-lost-receipt(V05/C1,BLOCK 级)**
- 竞态排除正确:先 `waitFor`(远端头==payloadSha)确认副作用**确实已发生**(58-61)才注入 SIGKILL,随后立即断言 intent 仍 EXECUTING(64-66)证明"回执确实丢失"——两步缺一不可,均存在。
- "不重推"证明充分:`EXECUTE_START` 恰 1 次(95)+ 远端头==payloadSha(78)+ 审计无 EXECUTE_COMPLETED(92);幂等二次 reconcile 断言 `already_completed`(81-84)。
- POST_PUSH_PAUSE_MS=20s 提供足够 kill 窗口,kill 发生在 push 完成之后(waitFor 已确认),不存在孤儿 git push 干扰判定的路径。

**v06 并发(lease-basics.test.ts,V06/B1,BLOCK 级)**
- 6 个并发 claim 经 PG 行锁串行化,断言恰 1 赢家、5 个败者且败因精确为 `state_not_claimable:LEASED`(26-33);非持有者推进全拒(reason 匹配 owner_mismatch|fenced)、持有者成功、重复推进 `state_mismatch`(36-60)。
- 审计计数精确断言:CLAIM=1、CLAIM_REJECTED=5、ADVANCE=1、ADVANCE_REJECTED≥6(63-73)。
- 注:该测试以 `Promise.all` 于同进程并发,真实双进程竞争由 v04 的真实子进程链路补足(V06 的"两个 Worker"语义由 DB 行锁层面证明,充分)。

**隔离与复现**
- `createTestDb`(testdb.ts:30-56):每测试文件独立 schema `p01a_<label>_<uuid8>` → `CREATE SCHEMA` → 专用 client `SET search_path` 后应用完整迁移(含 per-schema append-only 触发器)→ cleanup `DROP SCHEMA CASCADE`。文件间 `fileParallelism:false` + forks 隔离。复核人实测:全套跑完 PG 中 `p01a%` schema 遗留 = **0**,cleanup 真实生效。
- fresh-clone-repro.log:clone SHA 标注 ff0b1d1(其代码态==cc07804 减去证据日志本身,标注诚实)、npm ci(仅 warnings)、db:up ready、34/34、`REPRO_EXIT:0`,与复核人 /tmp 副本独立复现(34/34)交叉印证,可信。

---

## 发现清单

### MAJOR

- **F-1|append-only 守卫不拦截 TRUNCATE** — `src/core/db.ts:38-48`(AUDIT_APPEND_ONLY_GUARD)仅建 `BEFORE UPDATE OR DELETE ... FOR EACH ROW` 触发器;`TRUNCATE audit_events` 一条 SQL 即可无痕清空全部审计历史,不触发任何守卫。CURRENT.md Outcome 1 承诺"PG 触发器阻断改写",docs/PRD.md:104 NFR-02 要求"动作日志不可无痕改写"——TRUNCATE 正是无痕改写。建议处置(必须修复,改动约 2 行):守卫 SQL 追加 `CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR STATEMENT EXECUTE FUNCTION relay_forbid_audit_mutation();`,并在 v04 的结构性断言测试中补 TRUNCATE 用例。

### MINOR

- **F-2|BLOCKED/PAUSED/NEEDS_DECISION 是当前 API 面下的死端** — `lifecycle.ts:57-59` 允许三者→READY,但 `claimTask`(lease.ts:124-125)不可领取这些状态,`advanceTask` 又要求活租约(lease.ts:196-200),而进入这些状态时租约通常已失效/释放 ⇒ 表内合法转移无任何公开函数可合法执行(NEEDS_RECONCILE/REWORK 有 supervisor 出口,BLOCKED/PAUSED/NEEDS_DECISION 没有)。属 P0-01A 最小边界(Decision/resume 归 P0-01C),但建议在 lifecycle.ts 注释显式声明恢复路径归属,防止被误读为已实现闭环。
- **F-3|heartbeat 与 reclaim 的行级 TOCTOU** — `supervisor.ts:18-53` 回收只锁 tasks 行,`heartbeat`(lease.ts:234-265)只锁 leases 行:回收判定与僵尸续租可交错,回收后旧 Worker 心跳仍可 ok 并把租约续活至新 claim 覆盖为止。状态权威不受影响(advance 被 state_mismatch 拒),且"窗口内旧 Token 权威"是已声明契约;建议 heartbeat 增加"任务须处 leased-chain 才可续租"校验,或注释声明该窄窗口。
- **F-4|REMOTE_MOVED 置 BLOCKED 的 WHERE 集不全** — `intents.ts:275` `state IN ('NEEDS_RECONCILE','RUNNING','LEASED','READY')` 缺 SUBMITTED/VERIFYING。supervisor 主路径只会对 NEEDS_RECONCILE 任务调用故不触发,但 reconcileIntent 是公共 API:对 VERIFYING 任务直接调用且 REMOTE_MOVED 时,task 不被置 BLOCKED,若恰好存在旧 PASS(见 F-5)仍可 ACCEPTED。建议 WHERE 集补全为全部非终态。
- **F-5|Gate PASS 不绑定 attempt/commit** — `lease.ts:93-99` countGatePass 统计任意历史 PASS,`task_gate_verdicts` 无 attempt 列:第 1 次 attempt 的 PASS 在 REWORK 后的新 attempt 仍然有效(旧证据沿用,V09 属 P0-02A 未在本包承诺,但当前实现语义即"PASS 永久有效")。建议:verdict 增记 attempt 并按当前 attempt 过滤,或在本包文档标注该边界。

### OBSERVATION

- **F-6|白名单字面 vs 实际** — ff0b1d1 提交了 `p0-00/exp-c/package-lock.json`,CURRENT.md 白名单字面仅写"p0-00/exp-c/package.json(及本地其 node_modules 修复,不提交)"。lockfile 是"独立 package.json + npm ci 可复现"的必要组成,属白名单精神内、非构建产物;建议后续合同将 lockfile 显式纳入措辞。
- **F-7|"每测试独立 schema"实为每测试文件** — `testdb.ts:30-56` 在 beforeAll 创建一次,文件内各 it 共享 schema。CURRENT.md 第 4 行措辞略强于实际;文件间不并行故语义无碍,建议措辞改为"每测试文件独立 schema"。
- **F-8|append-only 守卫不入 drizzle journal** — 守卫靠 `applyMigrations` 迁移后手工附加(db.ts:54-78,有注释);若未来环境改用 `drizzle-kit migrate` 部署则守卫缺失。建议在 README/续接文档注明"必须经 applyMigrations 应用迁移"。
- **F-9|docs/CONTINUATION.md 尚未更新** — 仍写"P0-01A(NOT_ACTIVE)"、"P0-01 尚未实施",与 CURRENT.md(P0-01A ACTIVE)暂不一致。CURRENT.md Outcome 第 8 条把该更新排在"独立复核+快进 push"之后,属既定顺序待办而非违约;**P0-01A 关闭前必须完成**。
- **F-10|测试单次提交,断言演变不可事后审计** — test/ 全部文件由 ff0b1d1 一次引入,此前开发过程中的断言强度无从查证(仅能确认提交后零弱化 + 当前断言强度足够)。不构成违规,记录在案。

---

## 总裁决:**PASS-WITH-FIXES**

- 无 BLOCKER。实现与文档声称高度一致,B3b/TTL 契约如实声明,Reconcile 三分类与"绝不盲目重试"经专项排查未发现违反路径,测试断言强度经对抗审查后成立,复核人两轮独立 34/34 复现。
- **必须修复后方可关闭本包**:F-1(TRUNCATE 绕过 append-only,约 2 行守卫 SQL + 1 条断言测试)。
- F-2~F-5 建议随下一工作包或同批小补丁处置;F-6~F-10 为记录性观察。
- 修复 F-1 并复跑 34/34(+) 后,本包可进入 Outcome 第 8 条的快进 push 与 CURRENT.md/CONTINUATION.md 收尾。

## 未覆盖项(诚实声明)

1. p0-00/exp-a/b/d 实验脚本自身语义未复审(仅核验 exp-c 依赖修复、其回归日志存在性及 C1/C2/C3 在 Vitest 中的等价覆盖)。
2. 提交前(开发过程中)的断言演变无法从 git 历史审计(单 commit 引入全部测试)。
3. 未实际运行 `p0-00/exp-c/run-exp-c.sh` 原脚本,采信其回归日志 + 等价 Vitest 覆盖。
4. 未对 PG 容器/宿主 Docker 配置做安全评估(权限边界内只读观察:512Mi 上限、127.0.0.1 绑定由脚本声明并经 `docker ps` 证实运行中)。
5. V08 完整 Gate 编排(证据绑定 commit/environment)、V09、V10 的完整验收属后续包;本复核仅核验"最小门锁/最小单测"级别的声称(合同本身如此限定,未发现夸大)。
6. 未复核 npm 依赖供应链(仅核对根 package.json 直接依赖 5 项与 exp-c 独立依赖 1 项的合理性与 lockfile 存在性,未逐包审计)。

---

# 复验(40c27a3)

- **复验人**:同一独立上下文 Reviewer(第二轮)
- **日期**:2026-11-09
- **被复验 HEAD**:`40c27a340c6b4004257226506535331b8b041b46`(父 cc07804;工作区仅含写者正在准备的收尾改动:CURRENT.md、docs/CONTINUATION.md、p0-01a/evidence/vitest-full-run.log,均为未提交状态,src/ 与 test/ 相对 HEAD 干净——即本轮亲测覆盖的就是 40c27a3 的代码)
- **复核人亲测**:
  - `npm test` @ 40c27a3 → **11 文件 / 35 测试全部通过**(26.28s,exit 0);heartbeat 3→4 例、v04 的 append-only 测试内新增 TRUNCATE 断言,与处置声明一致;`npx tsc --noEmit` → 0 错误。
  - **TRUNCATE 阻断独立实证**(不依赖新测试):在测试库自建 scratch schema `rv_truncate_check`,手工应用已提交迁移表结构 + db.ts 的守卫 SQL 原文后直连 psql 实测——`TRUNCATE audit_events` → `ERROR: audit_events is append-only: TRUNCATE is not allowed`(探针行存活未被清除);UPDATE/DELETE 同样被拦;`pg_trigger` 确认 `audit_events_append_only` 与 `audit_events_no_truncate` 双触发器就位。
  - **F-3 运行时探针**(scratch schema `rv_hb_probe`,经领域层 claim 后直改状态模拟):`heartbeat@ACCEPTED` → `{"ok":false,"reason":"state_terminal:ACCEPTED"}`(新校验生效);`heartbeat@NEEDS_RECONCILE` → `{"ok":true,...}`(残余窗口实证,见下)。
  - 提交版 `p0-01a/REVIEW.md`(89 行)与本复核人原稿**逐字一致,未被改动**。

## 逐条处置结论

| 发现 | 处置结论 | 证据 |
| --- | --- | --- |
| F-1(MAJOR)TRUNCATE 绕过 append-only | **VERIFIED(已修复)** | db.ts 守卫追加 `BEFORE TRUNCATE ... FOR EACH STATEMENT` 触发器(`audit_events_no_truncate`),幂等性与原守卫一致(DROP IF EXISTS + CREATE);v04 append-only 测试补 `TRUNCATE audit_events` 阻断断言(测试标题同步更新);复核人以独立 scratch schema 直连 psql 复现阻断。承诺"NFR-02 不可无痕改写"现已覆盖 UPDATE/DELETE/TRUNCATE 三条路径 |
| F-2 死端状态无恢复路径 | **VERIFIED(已声明边界)** | lifecycle.ts 在 NEEDS_DECISION/PAUSED/BLOCKED 行上方注释声明"恢复属 Supervisor/Owner 运维动作,P0-01C Goal Loop 落地;P0-01A 仅承载转移表合法性本身"。与建议一致 |
| F-3 heartbeat 与 reclaim TOCTOU | **PARTIAL(处置可接受,残余窗口仍在)** | heartbeat 现先 `lockTask` 并拒绝终态(与 reclaim 在任务行上串行化 + 终态不可续租,均为真实硬化,测试覆盖);**但 NEEDS_RECONCILE 态的心跳仍会成功**(复核人运行时探针实证)——reclaim 提交后僵尸 Worker 仍可在新 claim 覆盖前续活租约。影响不变且有界(advance 被 state_mismatch 拒、新 claim 即 fenced、窗口内动作=B3b 已声明契约),且原建议允许"注释声明窄窗口"的替代方案;lease.ts 新注释声称"F-3 TOCTOU 处置"但未明示该残余窗口。非阻断;建议 P0-01B 引入真实 Worker 心跳循环前补 leased-chain 校验或在注释中如实标注 |
| F-4 REMOTE_MOVED WHERE 集不全 | **VERIFIED(已修复)** | intents.ts:275 WHERE 集已补 `'SUBMITTED','VERIFYING'`,与建议完全一致 |
| F-5 Gate PASS 不绑定 attempt/commit | **VERIFIED(已声明边界)** | gates.ts 顶部注释声明"PASS 尚不绑定 attempt/commit——旧 PASS 跨 attempt 有效;V09 的绑定在 P0-02A Gate 编排中落地"。与建议的"文档标注"选项一致 |
| F-6 exp-c lockfile 白名单字面 | **处置中(待 REPORT.md 落盘)** | 按处置声明将记入即将撰写的 p0-01a/REPORT.md;复验时点该文件尚未存在,以最终收尾提交为准 |
| F-7 "每测试独立 schema"措辞 | **VERIFIED(措辞已改,在未提交的 CURRENT.md 中)** | 工作区 CURRENT.md(收尾提交内容)已改为"每测试文件独立 schema";提交后即兑现 |
| F-8 守卫不入 drizzle journal | **VERIFIED(已声明)** | db.ts 守卫注释已注明"部署必须使用 applyMigrations(db.ts),不得裸跑 drizzle-kit migrate(否则守卫缺失)",并补注 TRUNCATE 走语句级触发器的原因。与建议一致 |
| F-9 CONTINUATION.md 未更新 | **处置中(更新已在工作区,待提交)** | 工作区 docs/CONTINUATION.md 已改写为"P0-01A 完成 + P0-01B(唯一下一任务,NOT_ACTIVE)",引用 p0-01a/REPORT.md 与 REVIEW.md,内容与 CURRENT.md 一致且无夸大表述;复验时点为未提交状态,**P0-01A 关闭前必须随收尾提交落地** |
| F-10 测试单 commit 断言演变不可审计 | **处置中(待 REPORT.md 落盘)** | 按处置声明将记入 REPORT.md;另注:40c27a3 对测试的改动均为**纯增量**(新增断言/用例,未弱化任何既有断言,标题更新除外),已逐行核对 |

## 遗漏与处置不当检查

- **提交边界**:40c27a3 仅触碰 8 个文件(src/core 5、test 2、p0-01a/REVIEW.md),全部在白名单内;无构建产物/依赖目录。
- **断言强度**:新增均为收紧性断言,无放宽;v04 审计序列断言未变。
- **未发现新问题**:本轮复查 5 个源文件 diff + 全量测试,无新增 BLOCKER/MAJOR/MINOR。
- **唯一保留项**:F-3 残余窗口(NEEDS_RECONCILE 态心跳可续租)——已实证存在,非阻断,移交 P0-01B 处置(见逐条表)。
- **写者并发注意**:复验期间工作区存在写者正在准备的收尾改动(CURRENT.md/CONTINUATION.md/vitest-full-run.log);其内容经只读核对与处置声明一致、无越界路径,但**在本复验报告落盘时点尚未提交**,本裁决以"收尾提交包含上述三个文件 + p0-01a/REPORT.md"为前提。

## 更新总裁决:**PASS**

- F-1(MAJOR,唯一必须修复项)已修复并经复核人独立于新测试的双重实证(psql 直连 + 运行时探针);F-2/F-4/F-5/F-8 按建议处置到位;测试 34→35 全绿且纯增量。
- 无阻断项。附带条件(收尾步骤,均为合同 Outcome 8 既定动作,非复核发现):收尾提交须落地 CURRENT.md / docs/CONTINUATION.md / p0-01a/REPORT.md(F-6/F-7/F-9/F-10 的处置承诺);F-3 残余窗口移交 P0-01B(Worker 心跳循环落地时补 leased-chain 校验或注释明示)。
- 复核人在本报告头部与首轮结论中对 cc07804 的全部其余判断(状态机/Lease/Reconcile/测试质量/安全扫描)经 40c27a3 增量复核后均不受影响,维持 VERIFIED。
