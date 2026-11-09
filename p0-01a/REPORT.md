# P0-01A 交付报告:持久状态与可靠执行内核

状态:**COMPLETE(待收尾推送)**。执行:VM80 唯一 Writer 会话,2026-11-09,起点 `origin/main == 5901a06`。本报告是 P0-01A 的结果证明;实现提交 `ff0b1d1`、复现证据 `cc07804`、复核处置 `40c27a3`,最终 HEAD 以远端 `main` 为准。

## 0. 交付标识

| 项 | 值 |
| --- | --- |
| 实现 | `src/core/`(10 文件,1100 行:lease 287 / intents 303 / supervisor 248 / db 117 / schema 86 / lifecycle 84 / policy 59 / gates 37 / audit 36 / git-push 43) |
| 迁移 | `migrations/0000_*.sql`(5 表,64 行,drizzle-kit 生成后去除 "public". 硬编码限定)+ `db.ts` 幂等 append-only 守卫 |
| 测试 | Vitest **35 用例 / 11 文件**(单测 15 + 集成 20),测试代码 1330 行;运行 ~26s |
| 依赖 | 运行时仅 `drizzle-orm + pg`;dev:`typescript/vitest/drizzle-kit/@types` |
| 测试 DB | 专用容器 `relay-p000-pg`(127.0.0.1:55433,512Mi 上限,非生产);**每个测试文件独立 schema**(建→迁移→用→DROP,零残留) |
| 模型调用 | **0 次**(本包无任何 LLM 参与) |

## 1. 与 P0-00 裁决的对应(不引入新架构)

- **ADR-0007**:自研 PG 事务+租约+fencing 的正式化(exp-b 227 行 → src/core,语义一一对应,无第二 Workflow Engine)。
- **REPORT §6 建议**逐条落地:Schema 五表 / 状态机 / Worker Tick / 两阶段意图 / Vitest 化 / 独立 schema(§8.6 风险处置)。
- **边界保持**:不接入 Pi Runtime(P0-01B)、不触碰真实 GitHub(P0-02B,测试仅本地 mock git 仓)、不大量写 MVP。

## 2. 验收对照(CURRENT.md 合同)

| 验收条款 | 结果 | 证据 |
| --- | --- | --- |
| Drizzle migrations 五表(含 audit append-only) | ✅ | `migrations/0000_*.sql`;`db.ts` AUDIT_APPEND_ONLY_GUARD(UPDATE/DELETE 行级 + TRUNCATE 语句级);v04 测试实测三通道全阻断 |
| 状态机(架构 §3)+ 非法转移拒绝 + Gate 门锁 | ✅ | lifecycle TRANSITIONS 全表;单测 7 例(含 CREATED→ACCEPTED 等非法面);v08 集成(gate_not_passed→PASS→ACCEPTED→终态锁定) |
| Lease/Fencing + TTL 窗口语义 + 心跳 | ✅ | B2 集成(过期回收 fencing+1/旧 token fenced/冒充拒绝);heartbeat 4 例(续租延长/stale 拒/过期拒/终态拒);B3b 契约在 v04 中正向断言(窗口内旧 token 权威=已知语义,非掩盖) |
| Supervisor Tick(回收→Reconcile→释放→领取) | ✅ | supervisor-tick 3 例(优先级/预算耗尽拒绝留审计/NEEDS_RECONCILE 恢复);v04 全链路(RECLAIM_EXPIRED→RECONCILE_READY→CLAIM fencing=2→ACCEPTED) |
| Action Intent 两阶段 + Reconcile 三分类 | ✅ | v05-lost-receipt(EXECUTING 窗口 SIGKILL→SIDE_EFFECT_CONFIRMED→不重推→幂等 already_completed);v05-reexecute-safe(执行前 SIGKILL→ABSENT→安全重推恰一次);intent-drift(前置 CONFLICT+REJECT_NO_FORCE_PUSH,无强推) |
| exp-b/exp-c 语义升级为 Vitest + 数据隔离 + 全新克隆复现 | ✅ | 35/35;每测试文件独立 schema(建→删零残留);`evidence/fresh-clone-repro.log`(clone@ff0b1d1→npm ci→db:up→npm test 34/34[当时],Reviewer 独立克隆复测亦 34/34) |
| exp-c node_modules 符号链接修复 | ✅ | 独立 package.json + npm install;回归 `evidence/exp-c-regression.log`(C1/C2/C3 全通过);符号链接已从仓库树删除(mode 120000→删除) |
| V02/V08 最小单测 | ✅ | policy-scope 8 例(默认拒绝/段边界/穿越/配置错误拒绝);lifecycle+gate 用例 |
| 独立复核(不同上下文) | ✅ | REVIEW.md:首轮 PASS-WITH-FIXES(9 项清单,F-1 MAJOR),处置提交 40c27a3 后复验(见 §4) |

## 3. 测试矩阵(35 用例,真实 PG + 真实故障注入)

- **V04 崩溃恢复**(2):真实子进程 SIGKILL(死亡核验:ps 轮询+exited promise)→ 窗口内权威(B3b 正向断言)→ TTL 过期 → RECLAIM_EXPIRED → RECONCILE_READY → fencing=2 重领 → 幽灵拒绝 → Gate 后 ACCEPTED → 终态锁定;**审计 15 步全序列逐一断言**;audit UPDATE/DELETE/TRUNCATE 三通道阻断。
- **V06/B1**(2):6 并发 claim 恰 1 赢家;非持有者/重复推进拒绝;拒绝审计计数断言。
- **B2**(1):过期回收、fencing 单调、旧 token/冒充拒绝。
- **heartbeat**(4):续租延长、stale fencing 拒、过期拒、终态拒(复核 F-3 处置)。
- **V05/C1**(1)+ **C2**(1)+ 幂等(1):三个故障窗口;远端恰好一次推进;单 ref 计数。
- **C3**(1):远端漂移前置拒绝,候选未覆盖外部提交。
- **supervisor-tick**(3)、**V08**(4)、**lease-basics**(2)、**V02**(8)、**lifecycle**(7)。

## 4. 独立复核(全新上下文 Reviewer,两轮)

**首轮(cc07804)**:PASS-WITH-FIXES,9 项清单中 8 项 VERIFIED;Reviewer 亲自双环境跑测(主仓+独立克隆均 34/34)并逐语句比对 drizzle-kit 生成结果与已提交迁移(一致)。发现 F-1(MAJOR)~F-10(OBSERVATION),详见 `REVIEW.md`。

**处置(40c27a3)**:

| # | 发现 | 处置 |
| --- | --- | --- |
| F-1 | **MAJOR**:TRUNCATE 可无痕清空审计(原守卫仅拦 UPDATE/DELETE) | 已修:语句级 BEFORE TRUNCATE 触发器 + 测试断言;35/35 重跑 |
| F-3 | heartbeat/reclaim 锁不同行的 TOCTOU | 已修:heartbeat 锁任务行并拒绝终态;残留面由 fencing 覆盖(回收后新 claim 使旧 token 必然 fenced),注释声明 |
| F-4 | REMOTE_MOVED 置 BLOCKED 缺 SUBMITTED/VERIFYING | 已修:WHERE 集补全 |
| F-2 | BLOCKED/PAUSED/NEEDS_DECISION→READY 无公开执行路径 | 声明:恢复动作属 Supervisor/Owner 运维,P0-01C 落地(lifecycle 注释) |
| F-5 | Gate PASS 不绑定 attempt/commit(旧 PASS 跨 attempt) | 声明:V09 绑定属 P0-02A Gate 编排(gates 注释) |
| F-8 | 守卫不入 drizzle journal | 声明:部署必须走 `applyMigrations`(db.ts 注释);REPORT §7 记录 |
| F-6/F-7/F-9/F-10 | 观察 | F-7 措辞修正(每测试**文件**独立 schema);F-9 CONTINUATION 随收尾提交更新;F-6/F-10 记录在案 |

**复验(40c27a3)**:Reviewer 亲测 35/35 + `tsc` 0 错误;TRUNCATE 阻断经独立 scratch schema + psql 直探双重实证;逐条处置 VERIFIED(F-3 PARTIAL 可接受,残余窗口移交 P0-01B,见 §6.7)。**最终总裁决:PASS(无阻断项)**,详见 `REVIEW.md` 复验章节。

## 5. 实施过程中修复的缺陷(留痕,非掩盖)

1. **drizzle-kit 生成 FK 硬编码 `"public".`** —— 会击穿每测试 schema 隔离;迁移文件已去除限定,applyMigrations 另做防御性剥离。
2. **intents rowToRef 未做 snake_case 映射** —— payloadSha/expectedRemoteSha 读为 null,drift 前置核对失效;修正 + 全量重测。
3. **子进程输出收集器双注册 close 导致挂起**(v04 首跑超时)—— 重构为 HelperChild(exited promise 一次性)。
4. **advance 校验顺序**:终态检查提至最前(终态绝对优先,双接受拒绝不再被 lease_expired 掩盖);fencing 先于 owner(不向过期持有者泄漏当前 owner)。
5. **createMockGit 参数错位**(首跑 3 文件失败)—— 修正后全绿。

## 6. 未解决风险与边界(诚实清单)

1. **Gate PASS 未绑定 attempt/commit**(F-5):同一 task 的旧 PASS 在新 attempt 仍有效;V09(候选变更证据失效)在 P0-02A 落地。当前威胁有限:attempt 重跑需经过 claim(fencing 新 token)+ SUBMITTED→VERIFYING 全链,且 PASS 由 GATE authority 写入。
2. **多 Supervisor 并发回收**未专项压测(单机单 Writer 场景;FOR UPDATE SKIP LOCKED 已防同行竞争);第二 Worker 引入前需补压测(CONSTRUCTION_PLAN §7)。
3. **executeIntent 与 reconcile 并发竞态**(执行中任务被另一进程 reconcile)未穷举;P0 单 Worker 下不触发,多 Worker 化前必须收敛(EXECUTING 意图的任务已被 claim 拒绝,风险面已缩小)。
4. **intent 的 deadline/reconcile_rule 字段**已建模但超时强制逻辑未实现(预算/超时熔断属 P0-01C V11)。
5. **NEEDS_DECISION/PAUSED/BLOCKED 的恢复 API** 未开放(F-2,P0-01C)。
6. **V10 完整语义**(集成时远端 main HEAD 改变的 ChangeSet 级拒绝)只覆盖了 intent 层;ChangeSet 聚合属 P0-02A/B。
7. **心跳残余窗口(复验 F-3 实证)**:NEEDS_RECONCILE 态心跳仍成功,僵尸可在"回收后、新 claim 前"续租;影响有界(advance 被拒、新 claim 即 fenced、窗口内属 B3b 权威契约),P0-01B 以 leased-chain 校验收口(lease.ts 注释已声明)。
8. 运行时残留:容器 `relay-p000-pg` 保留(后续包复用,可随时 `docker rm -f` 清理);/tmp 复现目录已清理。

## 7. 复现命令(全新克隆独立复现)

```bash
git clone https://github.com/pwl1987/relay && cd relay
npm ci                # 或 npm install
npm run db:up         # 拉起 relay-p000-pg(127.0.0.1:55433,512Mi;已存在则复用)
npm test              # 35 用例,~26s;每测试独立 schema,零残留
npx tsc --noEmit      # 类型检查
# 环境变量:RELAY_DB_URL 可覆盖默认测试库连接串
# P0-00 exp-c 回归(独立依赖):
cd p0-00/exp-c && npm install && RELAY_P000_PG=... ./run-exp-c.sh all
```

## 8. 证据索引

| 证据 | 内容 |
| --- | --- |
| `p0-01a/evidence/vitest-full-run.log` | 本仓全量 35/35(35 用例含复核处置新增) |
| `p0-01a/evidence/fresh-clone-repro.log` | 全新克隆(clone@ff0b1d1)→npm ci→db:up→npm test |
| `p0-01a/evidence/exp-c-regression.log` | exp-c 独立依赖修复后 C1/C2/C3 回归 |
| `p0-01a/REVIEW.md` | 独立 Reviewer 两轮复核(发现/处置/复验/总裁决) |
| 各测试文件 | 35 用例即可执行规范;断言含审计序列、进程死亡核验、远端副作用计数 |
