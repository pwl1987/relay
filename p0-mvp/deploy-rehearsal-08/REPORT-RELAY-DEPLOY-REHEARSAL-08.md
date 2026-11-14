# RELAY-DEPLOY-REHEARSAL-08 最终报告(隔离增量迁移演练与 D3 决策预演)

裁决:**PASS(独立 Reviewer 隔离冷启动两轮复核:Round1 REWORK[2 Major 均证据簿记缺陷,实质面全部亲证通过]→修复→Round2 PASS 0 Major;生产切换维持 NO-GO,不构成任何 GO 提升)**
日期:2026-11-14
合同:241893d(CURRENT.md「RELAY-DEPLOY-REHEARSAL-08」ACTIVE;最低祖先 e28c386 满足;开工冷启动 live main=origin=本地 241893d,合同提交 CI 43597388421 test/e2e 双 job success 亲测)

## 1. 基线与 Writer

- 快进:e28c386(07R 收口)→ 241893d(用户合同登记,含协调方 07R 独立审计 COORDINATOR-REVIEW-07R-20261114.md[07R PASS、生产预检 NO-GO 复确认]);`git merge --ff-only`;Writer=本窗口唯一。
- 未跟踪面三类全程零触碰(合同明示):`config/`、`p0-mvp/soak-r3b/`(绝对保护)、`p0-mvp/egress-isolation-07/evidence/ci-checkruns-e28c386.json`(协调方确认为 exact-head CI 回执)。

## 2. A 项:冷启动只读差距审计(以代码为准,不以旧 REPORT 替代)

- **迁移面**:`migrations/0008`(goal_messages.execution_request boolean NOT NULL DEFAULT false,单语句+注释)、`0009`(tasks.abort_requested_at timestamptz 可空,单语句);journal 10 条目(0000..0009)。
- **既有工具缺口(红态实证,见 §3)**:`deploy/init-schema.ts` 见 goals 表即跳过 ⇒ 不适合原位升级;`src/core/db.ts::applyMigrations` 依 journal **全量重放**(0000 CREATE TABLE 撞表)且末尾追加审计守卫 ⇒ 不能用于已有 schema;0008/0009 裸重跑必撞列。**增量升级此前无任何安全入口**(preflight FAIL 明细早已写明"增量补齐须按迁移文件逐条精确执行")。
- **备份/恢复面**:`deploy/backup.sh` 四步(db dump[宿主 pg_dump 缺失 ⇒ docker exec 回退,容器/库名可 env 覆盖]/artifacts manifest[backup-manifest.mjs 跨 schema 聚合 DELIVERED]/审计索引[**F-1:回退命令硬编码 relay-p000-pg+relayp000 且 audit_events 未按 schema 限定**]/校验和);`deploy/restore-verify.sh` 隔离实例新库恢复+restore-verify-check.mjs 交叉核对 —— 恢复侧可直接复用,备份侧审计索引步骤存在生产语义缺口。
- **Gate 面**:`resolveEvidenceChecks`(worker-entry,严格校验 fail-closed)→ `dockerCheckRunner`(UID 10001/cap-drop ALL/只读根/--network none/工作区边界校验);orchestrator `functional_evidence_unconfigured→NEEDS_DECISION` 已有 DB 级测试(gate-machine-evidence),但**真实 docker 检查执行器的发布演练此前为零**。
- **真实 0007 前驱形状核验**:goal_messages(0006,actor/kind CHECK+append-only 触发器)、goal_message_consumptions(0007,UNIQUE(message_id)+3 FK+触发器)、tasks(0000+0002 列)——0008/0009 为纯加列,旧代码不引用新列。

## 3. B 项:反例先红(隔离测试 PG p01a_* schema;零生产触碰)

红态证据 `evidence/red-phase-existing-tools.log`(真实既有代码,自建 p01a_d08red_* schema+合成行,退出即清):

- **RED-a**:`node deploy/init-schema.ts <0007形状schema>` ⇒ "已存在(goals 表在),跳过迁移" ⇒ 跳过后 g8/g9 仍 0/0 ⇒ **init-schema 不适合原位增量升级**;
- **RED-b**:`applyMigrations` 全量重放对已有 schema ⇒ `relation "action_intents" already exists` 崩溃 ⇒ **全量重放不可用**;
- **RED-c**:0008 首次执行成功后裸重跑 ⇒ `column "execution_request" … already exists` 崩溃 ⇒ **不检测标记的重入必撞**;
- **RED-d(工具缺失)**:演练工具反例套件在实现前运行 ⇒ 模块不存在套件全红(`evidence/red-phase-tool-missing.log`:Failed Suites 1/no tests/vitest-exit=1;首轮运行时因管道 tee 误捕仅存 "exit=0" 且无输出,已按 Reviewer Major-2 如实重取完整红态日志 —— 经临时移出模块复现实现前状态,原样恢复,git 状态不变)。

## 4. C 项:最小实现(deploy/rehearse-migration.ts,新增 503 行;生产调用方零改动)

- **plan 模式(只读)**:仅 information_schema+聚合计数(preflight 同口径,零原始数据);对任意可读 schema 可用(基座表缺失 ⇒ unsupported_shape 如实);输出**拟执行 SQL(取自真实迁移文件)+前置/后置条件+回滚审批材料**;对生产 relay_console 输出 `evidence/production-plan-relay-console.json`(实测 markers 1/1/0/0、行数 1/2 聚合)。
- **apply 模式(hard-guard)**:`assertApplyTargetAuthorized` 在**任何连接/写入之前**同步拒绝:保留 schema(relay_console/public/soak24h/dbos/p002b_probe)、非 `p01a_` 前缀、非回环主机、未显式端口、库名为空(实测 4 类拒绝 exit=2,`evidence/guard-refusal-prod.log`)。
- **增量语义**:形状不受支持(缺 0006/0007 基座/列定义异常)⇒ fail-closed 拒绝;逐步事务(BEGIN→SET LOCAL search_path 钉死→标记检测[已应用 ⇒ skipped_already 不盲撞]→执行真实 SQL→事务内后验标记→COMMIT);`--fail-at <tag>` 注入真实半迁移;总后验 `verifyPostMigrationState`(列定义/旧行默认回填/append-only 触发器≥2+1+1/FK=3/形状标记)。
- **断点定位不假 GO**:半迁移状态 verdict=`incremental_upgrade_available`(0008 applied+0009 pending 如实列出),绝不输出"已完成"。
- 复用纪律:不引入通用迁移框架/不建第二真相源;search_path 语义与 applyMigrations 一致(剥离 `"public".`);schema 隔离纪律与 testdb(p01a_ 前缀+回环三元组)同源。

## 5. D 项:红绿与隔离演练证据

- **单元/集成行为规范**(`test/integration/deploy-rehearsal.test.ts`,9/9 绿):形状构造精确性(plan 只读)/plan 输出真实 SQL+前置后置/apply 逐步+后验(列定义 boolean/NO/false、timestamptz/YES、旧行回填全 false、审计触发器、行数守恒)/重复执行 skipped_already 零 ALTER/failAt 注入⇒断点定位⇒续跑完成/守卫矩阵(6 目标拒绝+授权目标通过+URL 守卫)/跨 schema 隔离(兄弟 schema 与 public 逐标记不动)/损坏检测(撤审计触发器⇒后验如实失败)。
- **备份→迁移→恢复 E2E**(`test/integration/deploy-rehearsal-e2e.test.ts`,1/1 绿,一次性 postgres:17-alpine 容器 relay-test-d08-*):备份(backup.sh 步骤1 同命令形态 pg_dump + 真实 backup-manifest.mjs[DELIVERED=1]+schema 限定审计索引+校验和)→ 真实演练工具迁移 0008/0009 → 代码回退兼容 INSERT(旧行为写入成功且默认 false)→ 同实例新库恢复(restore-verify.sh 容器路径形态)+ **真实 restore-verify-check.mjs 交叉核对"一致 ✓"** → 回退边界断言(恢复库 g8/g9=0/0+合成行逐条保真[含中文]+触发器/FK 完好)。
- **Gate 真实 docker 演练**(`test/integration/evidence-gate-rehearsal.test.ts`,3/3 绿):sample.json 经真实 resolveEvidenceChecks(合法+5 类非法变异 fail-closed);真实 dockerCheckRunner(UID=10001/network=none/mode=docker 实证)+漂移真实失败;orchestrator 三场景——未配置⇒NEEDS_DECISION(functional_evidence_unconfigured)/有效配置+真实 docker 检查通过⇒ACCEPTED(证据含真实 deterministic_test)/检查失败⇒evidence_failed 保守阻断(零放行裁决)——**检查执行零 stub**(stub 仅生成合成候选)。
- **汇总**:`evidence/targeted-08-final.log` **13/13 绿**(11.9s);`evidence/quality-quick-08.log` PASS;tsc 干净;biome 干净。
- **零残留复核**:每轮后 `p01a_d08*` schema=0、relay-test-d08-*/relay-check-* 容器=0;生产服务 PID 3242781/3242782 未变;relay_console 迁移标记仍 0/0(零写入实证)。

## 6. 实现迭代记录(如实)

①verifyPostMigrationState 首版 FK 计数用 referential_constraints⋈constraint_table_usage 连接被乘行 ⇒ 改 table_constraints 精确计数。②行数聚合对缺基座表 schema 规划期报错(PG 不因 CASE 短路跳过缺失关系规划)⇒ 拆两段先判存在再查。③真实 docker 检查首跑 exit=2:mkdtemp 0700 + VM80 umask 0007(writeFileSync mode 参数同样被 umask 过滤)⇒ 候选文件对 UID 10001 不可读 ⇒ 测试夹具按生产 runner 同口径 chmod(root 0755/ws 0777/文件写后 0644);**环境约束如实登记**:生产 docker 沙箱候选文件属主即 UID 10001 无此问题;host-fallback+umask≥0077 宿主须 o+rX(fail-closed 阻断,不假 PASS)。④范围应用 journal 解包笔误(.entries 二次访问)首轮红即修。⑤E2E sha 插值笔误(JS 串进 SQL)红即修。

## 7. 独立 Reviewer(隔离上下文;原文入库=REVIEW-RELAY-DEPLOY-REHEARSAL-08.md)

**Round1 裁决:REWORK(2 Major,3 Minor;实质面全部亲证通过)。** 守卫亲测 7 类目标全 exit=2 且差分实证拒绝先于任何连接(不可达 URL:p01a_ 报 ECONNREFUSED 真连 vs relay_console 零连接痕迹)+ 代码序 assertApplyTargetAuthorized 先于 pool 创建;迁移语义自建 6 个 p01a_rev08_* schema 亲测(构造/apply/后验/重复跳过/fail-at 双方向断点/跨 schema 隔离);RED-a/b/c 逐字独立复现;测试 13/13+回归 19/19+quality:quick 亲跑;真实 docker 检查/真实 manifest-restore 脚本/真实一次性容器确认;F-1 从 backup.sh 源码直接证实;边界(零 diff 于 preflight/src/migrations、保护面 mtime 未动、PID 未变)全过;清理终核计数 0。两个 Major 均为**证据簿记缺陷**:Major-1=REPORT/D3 引用的 production-plan-relay-console.json 未落盘(--out 仅 --json 分支生效的 CLI bug;实质数字 Reviewer 已独立复现为真)→ 修复 CLI --out 双态生效+真实生成入库(1944B,markers 1/1/0/0);Major-2=red-phase-tool-missing.log 仅 7 字节"exit=0"与声明不符 → 临时移出模块如实复现红态重取完整日志(vitest-exit=1),原样恢复。Minor-1=CLI 失败路径措辞"(零写入)"与 fail-at 部分提交矛盾 → 已改(拒绝路径零写入;执行中失败以断点为准不假 GO);Minor-2=行数 430→503 已改(R2-Minor-1:首轮叙述曾误留中间态 497,已更正);Minor-3=D3 "0.3 万行级表"与实测(全 15 表合计 66 行)不符 → 已改。**Round2 终裁:PASS(0 Major;R2-Minor-1 登记非阻断)。** 五项修复全部亲证:①CLI writeOut 双态落盘(守卫拒绝+--out 无文件生成 exit=2;apply 成功路径 --json --out 落盘 exit=0);②入库证据文件与 Reviewer 独立重跑**逐字段相等**;③RED-d 完整红态与描述逐项一致(vitest-exit=1);④失败路径两行式措辞 4 场景亲测(fail-at 0009 实测 g8=1 部分提交与措辞一致);⑤503/66 行数字一致;守卫矩阵/迁移语义在修复后代码回归通过;13/13 复跑绿+tsc/biome 干净;生产 g8/g9=0/0、PID 未变、保护面未动。R2-Minor-1(497 中间态残留)已随手更正。终裁原文=REVIEW-RELAY-DEPLOY-REHEARSAL-08.md R2-1~R2-7。

## 8. 生产影响、回滚与边界

- **生产影响=零**:零生产写入(relay_console 迁移标记 0/0 前后一致)/零服务重启(PID 未变)/零默认 egress/iptables 资源触碰/零模型调用/零迁移;本包只读面=information_schema+聚合计数(preflight 同口径);隔离面=p01a_* schema+一次性容器。
- 回滚:`git revert` 本包提交即还原(新增文件+测试+文档,无迁移/schema 变更)。
- 边界:main-only 单 Writer;禁强推;保护目录与未跟踪 CI 回执零触碰;**本包不执行 D3**;生产切换材料=D3-DECISION-PACK.md(三选项,绝不自动选择/执行)。

## 9. 登记(后续候选,均不阻断、均未实施)

- **F-1(本包新登记)**:`deploy/backup.sh` 审计索引回退硬编码 relay-p000-pg/relayp000 且 audit_events 未按 schema 限定 ⇒ 生产(relay_console.audit_events)索引可能为空/读错表;切换窗口备份须 schema 限定人工核对,或后续小包修复(本包未改该脚本,避免未经 D3 变更生产工具语义)。
- host-fallback+真实容器检查在 umask≥0077 宿主的候选文件权限约束(见 §6③;生产 docker 沙箱不受影响)——如需消除可立"检查执行器权限预检"小包。
- Minor(演练工具):plan 对 production 规模的行数聚合为全表 count(大表时耗可测;当前 relay_console 行数 1/2 无影响)。
- 既有登记不变(Minor-3/4[07R]、生产切换 D3、POC 池、各包 Minor)。

## 10. NOT_RUN/未验证(如实)

- quality:full/release 本地 NOT_RUN(隔离 CI 口径;推送后以 exact-head CI 为权威)。
- 真实模型 Run/真实外部交付/生产重启自愈横幅:严格 NOT_RUN(D3 未授予)。
- 生产规模迁移/恢复耗时:未实测(合成小库秒级数字不得引用,见 D3 材料边界节)。
- backup.sh 审计索引行为在生产 env 下的实际输出:未验证(需读生产 env 值,禁止)——F-1 为静态代码审计结论。
