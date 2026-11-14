# RELAY-DEPLOY-REHEARSAL-08 独立复核报告(隔离上下文冷启动)

- **Reviewer**:独立上下文冷启动(与实现者零共享记忆;仅凭 AGENTS.md→CURRENT.md ACTIVE 合同→REPORT→D3-DECISION-PACK→工作区 diff 重建)
- **日期**:2026-11-14
- **基线核验**:`git rev-parse HEAD origin/main` = `241893d` = `241893d`(双方一致);工作区=未提交实现(见 §6);`git branch` 仅 main;reflog 无强推痕迹
- **裁决(Round1)**:REWORK(2 Major,3 Minor,观察项 4;实质面全部亲证通过——缺陷集中在交付文档的证据簿记,修复指令见 §7)
- **终裁(Round2)**:**PASS(0 Major;R2-Minor-1 登记 1 项,随收口随手改;详见 §10)**

## 0. 冷启动挑战结论

仅凭 CURRENT.md ACTIVE 合同 + REPORT + D3-DECISION-PACK + 工作区代码,可以**独立重建演练语义**并逐条对照实证;REPORT 的绝大多数声明经亲测属实(见 §2 逐项表)。发现两处交付文档证据簿记与事实不符(Major-1/2)与三处数字/措辞失准(Minor-1~3),不涉及守卫语义、迁移行为、测试真实性与边界合规的任何实质缺陷。

## 1. 关键拓扑事实(复核中自行澄清,影响守卫评估权重)

`docker ps`:生产容器 `relay-p000-pg` 端口映射 `127.0.0.1:55433->5432`,即**测试三元组 127.0.0.1:55433/relayp000 与生产 relay_console 同一 PG 实例**(与 testdb.ts 注释、rehearse-migration.ts 守卫文案一致)。因此 apply 守卫的 schema 检查(保留 schema + `p01a_` 前缀)就是防生产写入的**唯一闸门**——本复核按最高权重亲测(§2-2)。生产 URL 形态 `postgresql://…@10.30.5.80:5432/…` 属非回环,同样被 apply 守卫拒绝。

## 2. 逐项证据表(任务清单 1~10)

| # | 任务项 | 结果 | 亲证证据(命令→输出摘要) |
| --- | --- | --- | --- |
| 1 | 冷启动挑战 | **通过(带 2 处簿记缺陷)** | 见 §0;REPORT §3 RED-a/b/c 三项全部独立复现成功(探针 P9);§4/§5 实质声明全部亲测一致;§3 RED-d 与 §4 证据文件引用两处不符(Major-1/2) |
| 2 | **守卫(最重要)** | **通过,7 类拒绝全 exit=2,先于任何连接** | G1 `node deploy/rehearse-migration.ts apply --schema relay_console` → exit=2「保留 schema…未执行任何连接或写入」;G2 public/G3 soak24h 同;G4 `--schema mytest` → exit=2 非 p01a_ 前缀;G5 `--target-url postgresql://…@10.30.5.80:5432/…`(p01a_ schema)→ exit=2「主机非回环」(即时拒绝,无超时);G6 `postgresql://…@127.0.0.1/relayp000`(无端口)→ exit=2「未显式端口」;G7 空 schema → exit=2 用法。**先于连接的差分实证**:同一不可达 URL(127.0.0.1:59998)下,`plan --schema p01a_rev08_probe` 报 `connect ECONNREFUSED`(证明守卫通过时会真连),而 `apply --schema relay_console` 同 URL 仅守卫拒绝、**零连接痕迹**;代码序佐证:rehearse-migration.ts:479 `assertApplyTargetAuthorized(schema,url)` 在 :480 `new pg.Pool` 之前,:294 守卫为 applyIncrementalMigration 首语句。生产 g8/g9 前后 0/0、PID 3242781/3242782 全程未变 |
| 2b | 生产 schema 只读复核 | **通过** | `docker exec relay-p000-pg psql …information_schema…` 实测 g8=0/g9=0(基线与终核一致);`systemctl --user show` MainPID=3242781(web)/3242782(worker) 未重启 |
| 3 | plan 只读性 | **通过** | `node deploy/rehearse-migration.ts plan --schema relay_console --json` → exit=0;markers=g6/g7/g8/g9=1/1/0/0,rowCounts=goal_messages 1/tasks 2,verdict=incremental_upgrade_available——与 REPORT §4「markers 1/1/0/0、行数 1/2」**实质一致**;steps[0].statements=真实迁移文件原文 `ALTER TABLE "goal_messages" ADD COLUMN "execution_request" boolean NOT NULL DEFAULT false;`;代码审计:plan 路径仅 information_schema+count(*) 聚合(preflight.ts:342-345 同口径),零 ALTER/写语句;生产 g8/g9 运行前后不变。**但 REPORT/D3 引用的落盘证据文件不存在**(Major-1) |
| 4 | 迁移演练行为亲测 | **通过(全部语义亲证)** | 自建 `p01a_rev08_*` 探针 schema,详见 §3 P1~P9:0007 形状构造 1/1/0/0 → apply 两步 applied、verification 11 项全 ok、0008 列定义 boolean/NO/false 实测、旧行回填 false 1/1、append-only 触发器 audit_events≥2+goal_messages≥1+consumptions≥1、FK=3;重复 apply ⇒ skipped_already×2、statements=0、information_schema 列快照逐字节一致(零 ALTER);fail-at 0009 ⇒ 0008 已提交/0009 pending、verdict=incremental_upgrade_available(不假 GO)、续跑 skipped+applied 完成;fail-at 0008(CLI)⇒ exit=2 且 markers 0/0(零提交);空 schema ⇒ unsupported_shape fail-closed;非法标识符 `p01a_x"; DROP SCHEMA public;--` ⇒ quoteIdent 拒绝;跨 schema 隔离:对 fail schema apply 后 ctrl schema 1/1/0/0 不动、public 无新表、未触碰的 probe schema 1/1/1/1 不变 |
| 5 | 测试复跑 | **通过** | `npx vitest run` 三套件 → **13/13 绿**(11.85s;REPORT 称 11.9s);回归 `deploy-preflight.test.ts`+`worker-entry.test.ts` → **19/19 绿**;`npm run quality:quick` → **PASS**(unit exit=0) |
| 6 | Gate 演练真实性 | **通过** | 源码审计 `src/runtime/check-sandbox.ts`:`relay-check-<uuid>` 一次性容器、`--rm`、`--cap-drop ALL`、默认 `network:"none"`、UID 10001;测试断言取自真实运行 env 字段(user=10001/network=none/mode=docker)与 rawOutput(`sample deterministic check ok`/漂移 `exit=[23]`);配置经真实 `resolveEvidenceChecks`(5 类非法变异 fail-closed 断言);检查执行零 stub(stub 仅用于生成合成候选 pi 会话);本轮复跑时无 relay-check-* 容器残留 |
| 7 | 备份/恢复演练真实性 | **通过** | E2E 真实 `docker run -d postgres:17-alpine` 一次性容器(relay-test-d08-*,-P 随机端口),非复用同实例;备份=docker exec pg_dump(backup.sh 步骤1 同命令形态)+**真实** `deploy/backup-manifest.mjs`(DELIVERED=1 断言)+schema 限定审计索引+sha256;迁移=真实演练工具;恢复=容器内 `psql -v ON_ERROR_STOP=1 -f -`(restore-verify.sh 容器路径同形态,已对照源码)+**真实** `deploy/restore-verify-check.mjs` 交叉核对「一致 ✓」断言;回退边界断言齐全(恢复库 g8/g9=0/0、合成行含中文逐条保真、触发器/FK 完好、DELIVERED=1);复用脚本均为既有跟踪文件(git log a8adcab,非本包新增) |
| 8 | 敏感数据脱敏 | **通过(1 观察项)** | grep 新文件+证据目录:无任何真实凭据形态;证据日志中连接串仅 `postgresql://127.0.0.1:55433/relayp000`(host:port/db);工具输出实测(`report.target`/拒绝消息)零密码;测试文件中的 `u:p@` 为守卫测试向量非真实凭据。观察项:release: red-setup-0007-shape.mjs:13 硬编码 `relayp000local`(与 src/core/db.ts、deploy/init-schema.ts、scripts/test-db-up.sh 既有跟踪默认测试凭据同串,非新增暴露面) |
| 9 | D3 决策材料完整性 | **实质通过(1 数字失准)** | 三选项 A/B/C 齐备且含执行序/风险/门槛/回滚(选项 A);边界标注齐备(§四「隔离合成数据 PASS ≠ 生产真实数据验证 ≠ Mac 用户 UX ACCEPTED ≠ 真实模型/24h 运维完成」);F-1 如实登记且附人工核对命令;「本文件只是决策材料,不是授权,更不是执行」明示不自动选择/执行;批准后首日监测清单齐备;耗时数字边界标注正确。失准处:选项A「0.3 万行级表」与实测不符(Minor-3);§一 引用悬空证据文件(Major-1 连带) |
| 10 | 边界合规 | **通过** | tracked diff 仅 `deploy/README-deploy.md`(+2/-1,含 F-1 登记);`deploy/preflight.ts`/`src/`/`migrations/` **零 diff**(`git diff HEAD --` 空);受保护未跟踪面 `config/`、`p0-mvp/soak-r3b/`、`ci-checkruns-e28c386.json` mtime 均早于实现窗口(`find -newermt "2026-11-14 22:00"` 空);无新分支/强推(origin/main 仍 241893d);零模型调用/零 systemd 操作/零 egress iptables 触碰(本复核全程只读生产面+隔离探针);backup.sh 未改(F-1 声明「本包未改它」属实) |

## 3. Reviewer 自建探针表(全部清理完毕,§5 证明)

| 探针 | 内容 | 结果 |
| --- | --- | --- |
| G1~G7 | apply 守卫矩阵(relay_console/public/soak24h/mytest/非回环 10.30.5.80/无端口/空 schema) | 全部 exit=2 拒绝,输出零凭据零连接痕迹 |
| G8 | 差分:同不可达 URL(127.0.0.1:59998),p01a_ 前缀 vs relay_console | 前者 ECONNREFUSED(真连),后者守卫拒绝——**守卫先于任何连接**实证 |
| P1 | applyMigrationRange 构造 0007 形状(p01a_rev08_probe) | markers 1/1/0/0 |
| P2 | applyIncrementalMigration 0007→0009 + 独立后验 | applied×2,verification.ok=true(11 checks),0008=boolean/NO/false,旧行回填 false=1/1,触发器 audit×2+gm+cons,FK=3 |
| P3 | 重复 apply | skipped_already×2(stmt=0),information_schema 列快照前后一致 |
| P4 | fail-at 0009 → shape → 续跑 | applied=[0008]/pending=[0009]/verdict=incremental_upgrade_available;续跑 skipped+applied→1/1/1/1 |
| P5 | CLI fail-at 0008(首步) | exit=2,markers 0/0(零提交) |
| P6 | 空 schema apply | unsupported_shape fail-closed 拒绝 |
| P7 | 非法标识符注入串 | quoteIdent 拒绝(fail-closed) |
| P8 | 跨 schema 隔离(ctrl 对照+public+未触碰 probe) | ctrl 1/1/0/0 不动;public 无新表;probe 1/1/1/1 不变 |
| P9 | RED-a/b/c 独立复现 | init-schema「已存在(goals 表在),跳过迁移」/applyMigrations「relation "action_intents" already exists」/0008 裸重跑「column "execution_request" … already exists」——与证据日志逐字一致 |
| P10 | plan --schema relay_console(生产,只读) | exit=0;markers 1/1/0/0、行数 1/2、SQL=真实迁移文件原文、回滚材料齐全 |
| P11 | 中途失败 CLI 输出(fail-at 0009) | exit=2,g8=1(0008 已提交)——外层措辞「零写入」失准(Minor-1) |
| T1~T3 | 三套件 13/13;回归 19/19;quality:quick | 全绿 |
| C1 | 清理复核 | `p01a_rev08%`=0、`p01a_d08%`=0、relay-rev08-*/relay-test-d08-*/relay-check-* 容器=0 |

注:探针期间发现测试 PG public schema 存在 4 张 DBOS 时代遗留表(action_intents/audit_events/leases/tasks;public.audit_events 4 行,时间戳 2026-11-09 13:58 DBOS_*)——**早于本包 5 天存在,非本包/本复核产物**;该事实恰是 backup.sh F-1 风险的实化背景(未限定 schema 的 `audit_events` 解析到 public 旧表)。

## 4. 发现的问题

### Major(2;须修复后收口)

- **Major-1(证据簿记)**:REPORT §4 声明「对生产 relay_console 输出 `evidence/production-plan-relay-console.json`」、D3-DECISION-PACK §一 表行 1 以该文件为 g8/g9=0/0 的证据——**该文件在仓库中不存在**(全仓 `find . -name "production-plan*"` 无果;evidence/ 实有 6 文件)。实质数字(markers 1/1/0/0、行数 1/2)经 P10 亲测为真,属证据未落盘而非虚假声明;但按 AGENTS.md 规则 6 与 06 包先例(Runbook 数字失准=Major→REWORK),交付文档不得引用不存在的证据文件,且 D3 包是用户生产决策的直接材料,证据指针必须可追溯。
- **Major-2(证据簿记)**:REPORT §3 RED-d 声明「`evidence/red-phase-tool-missing.log`:1 failed,no tests」——该文件实为 **7 字节、内容仅 `exit=0`**(疑似管道 `| tail` 吞掉真实退出码),既不包含「1 failed」输出,`exit=0` 更与「红」自相矛盾。RED-a/b/c 证据扎实且经 P9 逐字复现,唯 RED-d 的引用制品不能支撑其声明。

### Minor(3;建议随修复轮一并消化或如实登记)

- **Minor-1(工具措辞)**:`deploy/rehearse-migration.ts:492` CLI catch-all 对**中途失败**(非目标拒绝)路径仍打印前缀「(fail-closed,零写入)」——P11 实测 fail-at 0009 时 0008 已提交(g8=1),外层措辞与真实状态矛盾(内层消息「此前步骤已提交」正确,报告不假 GO、续跑可用,故语义安全、仅措辞失准)。建议区分「目标拒绝=零写入」与「执行中断=部分提交,断点定位见 plan」两类消息。
- **Minor-2(报告数字)**:REPORT §4「新增 ~430 行」与实际 `wc -l deploy/rehearse-migration.ts` = **495 行**偏差约 15%。
- **Minor-3(D3 数字)**:D3 §三 选项A「0.3 万行级表」与实测不符——本复核只读实测 relay_console 全 15 表合计 **66 行**(goal_messages=1、tasks=2、audit_events=55、action_intents=0)。「快操作」结论方向不变(更小更快),但决策材料数字应如实(建议改写为实测口径或删除具体量级)。

### 观察项(非缺陷,登记不阻断)

- red-setup-0007-shape.mjs:13 硬编码默认测试凭据,与仓库既有跟踪约定同串(src/core/db.ts 等),非新增暴露面;报告/日志/工具输出面脱敏合规。
- 导出面 `applyMigrationRange` 仅校验 p01a_ 前缀、不校验 URL(签名接收已连接 client;CLI 唯一执行入口 applyIncrementalMigration/CLI apply 走全守卫;注释已标「测试/演练 fixture」)。若未来扩大其调用面须补全守卫。
- 测试 PG public schema 4 张 DBOS 时代遗留表(见 §3 注)——非本包产物,建议后续小包评估清理登记(勿擅动)。
- plan 行数聚合为全表 count(生产规模耗时)——REPORT §9 已如实登记。

## 5. 未验证项(如实)

- 生产规模迁移/恢复耗时:未实测(合成小库秒级;D3 已标注不得引用)。
- backup.sh 审计索引在生产 env 下的实际输出:未验证(需读 ~/.relay 生产 env 值,禁止)——F-1 为静态代码审计结论(本复核已从源码直接证实:backup.sh:27/29 `audit_events` 未限定 schema,:29 回退硬编码 `relay-p000-pg`/`relayp000`;public.audit_events 旧表实际存在)。
- quality:full/release:本地 NOT_RUN(未推送;按流程收口后以 exact-head 隔离 CI 为权威)。
- 真实模型 Run/真实外部交付/生产重启自愈横幅:NOT_RUN(D3 未授予)。
- RED-d 原始 vitest 输出:不可重建(实现前状态已不存在;见 Major-2 修复选项)。
- exact-head CI:本包尚未提交/推送,CI 回执尚不存在(收口阶段交付)。

## 6. 工作区 diff 面核对(与 REPORT/合同一致)

- tracked:`deploy/README-deploy.md` +2/-1(迁移补齐段补演练工具指引 + F-1 登记)——内容与 D3/F-1 声明一致。
- 新增:`deploy/rehearse-migration.ts`(495 行)、`test/integration/{deploy-rehearsal,deploy-rehearsal-e2e,evidence-gate-rehearsal}.test.ts`(253/250/241 行)、`p0-mvp/deploy-rehearsal-08/`(REPORT+D3+evidence 6 文件)。
- 未触碰:`config/`、`p0-mvp/soak-r3b/`、`p0-mvp/egress-isolation-07/evidence/ci-checkruns-e28c386.json`(mtime 早于实现窗口,git status 与合同登记的三类保护面完全吻合,无第 9 项未知脏文件)。
- `git status --porcelain` 共 9 行 = 1 M + 8 ?? ,逐一归属清楚。

## 7. REWORK 精确修复指令(实现者执行;Reviewer 不改实现代码)

1. **Major-1**:实际生成并入库证据文件:`node deploy/rehearse-migration.ts plan --schema relay_console --json --out p0-mvp/deploy-rehearsal-08/evidence/production-plan-relay-console.json`(输出仅含形状/聚合计数/拟执行 SQL/回滚材料,零凭据零原始数据,P10 已证 exit=0 只读);生成后核对 markers=1/1/0/0、rowCounts goal_messages=1/tasks=2 与 REPORT §4/D3 §一 声明一致。若选择不落盘,则必须同步改写 REPORT §4 与 D3 §一 的引用为「可复现命令 + 行内实测数字」,不得保留悬空文件引用。
2. **Major-2**:修复 RED-d 证据,二选一且不虚构:①以 `git stash`/临时移出方式重建「实现前」状态,无管道重取日志(`npx vitest run test/integration/deploy-rehearsal.test.ts > evidence/red-phase-tool-missing.log 2>&1; echo "exit=$?" >> evidence/red-phase-tool-missing.log`,预期含 failed-to-load 与 exit≠0),随后恢复工作区;②如实改写 REPORT §3 RED-d 行,注明原始输出不可重建、以 RED-a/b/c(已独立复现)+ 首轮红为实际依据,删除「1 failed,no tests」引用或改述。
3. **Minor-1**:rehearse-migration.ts:492 错误消息按失败类别区分——守卫/形状拒绝保留「零写入」字样;执行中断(fail_at_injection/step_postcondition_failed 等)改为「执行中断:此前步骤已提交(断点可用 plan 定位并续跑)」,不得声称零写入。
4. **Minor-2**:REPORT §4「~430 行」改为实际行数(或删除近似数)。
5. **Minor-3**:D3 §三 选项A「0.3 万行级表」改为实测口径(如「relay_console 全 15 表合计 66 行(2026-11-14 只读实测)」)或删除具体量级。

## 8. 清理与生产面终核(复核收尾证明)

- 探针清理:`DROP SCHEMA ... CASCADE` ×6(p01a_rev08_probe/fail/empty/ctrl/cli/fail8)→ `pg_namespace LIKE 'p01a_rev08%'` 计数 **0**;`p01a_d08%` 计数 **0**;`docker ps -a` 中 relay-rev08-*/relay-test-d08-*/relay-check-* 计数 **0**(本复核未创建任何容器,e2e 容器自清理)。
- 生产面终核:relay_console g8/g9 = **0/0**(与基线一致,零写入);relay-web/relay-worker MainPID = **3242781/3242782**(零重启);origin/main = 本地 = **241893d**(零推送/零强推/零新分支);受保护未跟踪面 mtime 未变。
- 本复核全程:零生产写入、零 systemd 操作、零默认 egress/iptables 资源触碰、零模型调用、未读 ~/.relay 任何文件值、探针仅 `p01a_rev08_*` 前缀 schema。

## 9. 终裁

**Round1:REWORK(2 Major,3 Minor)**——实质面(守卫 fail-closed 先于连接、迁移语义、幂等/半迁移/续跑、跨 schema 隔离、Gate 与备份恢复真实性、测试 13/13+回归 19/19、脱敏、边界合规、D3 材料结构完整性)**全部独立亲证通过**;两项 Major 均为交付文档的证据簿记缺陷(引用不存在的证据文件/引用与制品不符),按仓库证据纪律与 06 包先例须修正后收口。修复为一轮有界(1 条命令 + 2 处文档改写 + 1 处措辞),不要求任何实现语义变更;生产切换维持 NO-GO,本复核不构成任何 GO 提升。

---

## 10. Round2 终裁复核(2026-11-14;实现者报告 Round1 五项修复后)

### R2-0 范围与方法

仅针对五项修复(重点=Major-1 --out 双态落盘、新证据文件内容与引用一致、RED-d 日志与 REPORT 描述一致)+ 行为面回归(守卫矩阵/fail-at 措辞/apply --out)+ 测试与生产面终核。实现者改动面:rehearse-migration.ts(495→503 行)、REPORT §3/§4/§7、D3 §三、两个证据文件、targeted-08-final.log;git status 仍为 Round1 同一 9 行(1 M + 8 ??),无新增脏文件。

### R2-1(Major-1 修复)——**确认**

- 代码:`deploy/rehearse-migration.ts` 新增 `writeOut` 助手,json/text 两态均落盘(--out 时 writeFile + stderr「已写出」,无 --out 照旧 stdout);守卫顺序未动(apply 路径 `assertApplyTargetAuthorized` 仍先于 `new pg.Pool`);失败路径(catch)不调用 writeOut ⇒ 失败不会产生误导性证据文件(实测守卫拒绝 + `--out` 时无文件生成,exit=2)。
- 新证据 `evidence/production-plan-relay-console.json`(1944B,22:55):mode=plan、target=postgresql://127.0.0.1:55433/relayp000(脱敏)、verdict=incremental_upgrade_available、markers 1/1/0/0、rowCounts 1/2、pending=[0008,0009]、step0 SQL=真实迁移文件原文——与 REPORT §4/D3 §一 声明一致。
- **独立一致性实证**:Reviewer 本人重跑 `plan --schema relay_console --json`(stdout)与入库文件**逐字段相等(True)**。
- 双态行为亲测:text 模式 `plan --out /tmp/…` 落盘 + stderr 提示;apply 成功路径 `--json --out` 落盘(exit=0)。

### R2-2(Major-2 修复)——**确认**

`evidence/red-phase-tool-missing.log` 现为完整 vitest 红态:`Cannot find module '../../deploy/rehearse-migration.ts'`(import 位置逐行回显)、Failed Suites 1、`Test Files 1 failed (1)`、`Tests no tests`、**vitest-exit=1**——与 REPORT §3 RED-d 改写后的描述逐项一致;该行同时如实记录首轮日志缺陷(管道误捕仅存 "exit=0")与重取过程(临时移出模块复现实现前状态、原样恢复、git 状态不变)。模块已恢复(文件在,git status 未变)。

### R2-3(Minor-1 修复)——**确认**

CLI 失败输出已为两行式,4 个场景亲测(非回环守卫/未显式端口守卫/unsupported 形状/fail-at 0009 注入)均为:第 1 行「失败(fail-closed):<原因>」(不再无条件宣称零写入),第 2 行「目标/参数拒绝=任何连接前零写入;执行中失败=此前步骤可能已提交(真实半迁移),复跑 plan 定位断点,绝不假 GO」。fail-at 0009 实测 g8=1(部分提交)与第 2 行措辞一致;续跑 skipped_already+applied → ok=true。

### R2-4(Minor-2 修复)——**确认(附 1 处遗留数字,见 R2-Minor-1)**

REPORT §4「新增 503 行」与 `wc -l deploy/rehearse-migration.ts` = **503** 一致。

### R2-5(Minor-3 修复)——**确认**

D3 §三 选项A 风险段改为「2026-11-14 只读实测 relay_console 全 15 表合计 66 行,持锁毫秒-秒级;生产规模以窗口实测为准」——与 Round1 Reviewer 只读实测(66 行)一致。

### R2-6 回归与生产面终核——**全过**

- 三套件复跑 **13/13 绿**(Reviewer 亲跑 11.69s;evidence/targeted-08-final.log 已更新,22:56,13/13)。
- `npx tsc --noEmit` exit=0;`npx biome check`(3 个测试文件)exit=0 干净——注:`deploy/**` 不在 biome.json includes 范围(与 deploy/preflight.ts 同口径),工具文件正确性由 tsc 覆盖,非缺口。
- 生产:relay_console g8/g9 = **0/0**;probe schema 计数 0;relay-web/relay-worker MainPID = **3242781/3242782** 未变。
- 保护面:config/、p0-mvp/soak-r3b/、ci-checkruns-e28c386.json 未触碰;README-deploy.md diff 仍 +2/-1;origin/main 仍 241893d。

### R2-Minor-1(新登记,非阻断)

REPORT §7 Round1 裁决段中「Minor-2=行数 430→**497** 已改」的 497 与任何实态不符(Round1 实测 495,修复后 503,§4 现为 503)——疑为修复中间态数字残留在叙述行。建议收口提交前随手改为「430→503」;不阻断终裁。

### R2-7 终裁

**PASS(0 Major;R2-Minor-1 登记 1 项)**。Round1 五项修复全部亲证到位:证据文件真实落盘且与独立重跑逐字段一致、RED-d 完整红态与描述一致、CLI 措辞与真实状态一致、两处数字修正;守卫矩阵/迁移语义在修复后代码上回归通过,生产面零影响。收口路径不变:实现者按流程更新 REPORT §7 终裁/CURRENT.md/docs/CONTINUATION.md → main-only 快进 → exact-head 隔离 CI 为质量:full/release 的权威覆盖。生产切换维持 NO-GO,本终裁不构成任何 GO 提升。
