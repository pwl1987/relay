# RELAY-DEPLOY-PREFLIGHT-05 独立 Reviewer 审查报告

- **裁决:REWORK**(1 Major + 4 Minor;Major 修复并复跑证据、REPORT §7 按本裁决回填后方可入库)
- Reviewer:隔离上下文独立终裁;所有结论基于 Reviewer 亲跑命令输出或亲读代码,不受实现者自评影响。
- 审查时间:2026-11-14;基线:git main @ b3d1e5ee9d38941c6c67f368708d7899cb4d35a4 + 未提交实现变更(与被审对象声明一致)。
- 被审对象:deploy/preflight.ts(亲读全文 526 行)、deploy/evidence-checks.sample.json、deploy/README-deploy.md 追加 Runbook 节(纯追加 54 行)、test/integration/deploy-preflight.test.ts(亲读全文 498 行)、实现者证据两份 log、REPORT-RELAY-DEPLOY-PREFLIGHT-05.md。

---

## 一、逐项留证(必做审查项 A~G)

### A. 亲跑生产预检(只读)——与实现者证据一致,迁移 FAIL 属实

命令:`node deploy/preflight.ts`(生产实例;**亲测退出码 2**)
命令:`node deploy/preflight.ts --json`(**亲测退出码 2**)

Reviewer 亲跑关键输出(2026-11-14T01:00:51Z,HEAD=b3d1e5ee…):

- `[FAIL] git_head:…被跟踪树存在未提交修改` —— 与实现者 log(00:36 运行,当时树尚清洁=PASS)存在差异,系**时序差异非矛盾**:实现者先跑预检后写 Runbook;我的运行时 README-deploy.md 已修改。此差异恰好证明 git_head 检查真实生效(部署必须来自确切提交)。
- `[FAIL] db_migrations:迁移缺失:0008(goal_messages.execution_request),0009(tasks.abort_requested_at)` —— **与实现者证据 log 逐字一致**。
- `[UNKNOWN]` ×3:process_vs_head / evidence_checks_config / egress_stack —— **与实现者证据 log 一致**。
- 其余 14 项 PASS 一致;`裁决=NO-GO`,计 14 PASS + 1 FAIL + 3 UNKNOWN = 18 项(REPORT §5 计法"13 PASS/1 FAIL/3 UNKNOWN/1 PASS-with-note"合计 18,一致)。

迁移 FAIL 独立自证(只读 information_schema):

```
docker exec relay-p000-pg psql -U postgres -d relayp000 -At -c "SELECT …(4 项标志物)…"
输出:1|1|0|0    (goal_messages 表在 / consumptions 表在 / execution_request 列=0 / abort_requested_at 列=0)
EXIT=0
```

⇒ 0006/0007 在位、0008/0009 缺失,**db_migrations FAIL 属实**。

### B. 脱敏审计——零真实命中

命令:`node deploy/preflight.ts --json` 输出重定向后 grep:

- `postgresql://` 命中 **0**;连接串带凭据模式(`postgres…://…:…@`)命中 **0**;API 键值/密码值/Bearer 模式真实命中 **0**。
- 唯一宽松模式命中 1 处,定位为中文标签 `"web-password 权限=600(要求 600)"`——是**权限模式非凭据值**,不构成泄漏。
- `env_file` 检查行仅含 12 个键名(`RELAY_DB_URL,…,RELAY_PI_API_KEY,…`)+ `(取值零输出)`,键名合法可显示。
- Reviewer 未读取 env 文件取值;Node v24.21.0 下 `JSON.parse` 非法输入错误信息仅报位置(亲测 `try{JSON.parse('{not-json')}…` ⇒ `Expected property name or '}' in JSON at position 1 (line 1 column 2)`),preflight 错误路径不回显取值片段。
- 实现者证据 log、REPORT 通读:零取值。

### C. 演练重跑——12/12 全绿

命令:`npx vitest run test/integration/deploy-preflight.test.ts test/integration/worker-evidence-checks.test.ts`
结果(Reviewer 亲跑):`Test Files 2 passed (2) / Tests 12 passed (12)`,**退出码 0**;deploy-preflight 6 用例(2.107s,含真实 Docker 第 6 组 713ms)+ worker-evidence-checks 6 用例。与实现者 evidence/rehearsal-tests-20261114.log 完全一致(含同样的 vitest 慢用例列举形态,见 Minor-4)。

### D. Runbook 对照源码逐条核实

| # | 结论 | 证据 |
| --- | --- | --- |
| ① | 迁移缺失清单与文件内容**一致** | `migrations/0008_goal_messages_execution_request.sql`=`ALTER TABLE "goal_messages" ADD COLUMN "execution_request" boolean NOT NULL DEFAULT false`;`migrations/0009_tasks_abort_requested.sql`=`ALTER TABLE "tasks" ADD COLUMN "abort_requested_at" timestamp with time zone`;与 preflight/Runbook 清单一致 |
| ② | init-schema 对已存在 schema 跳过 | deploy/init-schema.ts:21-24(goals 表在⇒"跳过迁移(幂等)")与 Runbook"须逐条精确执行"的表述一致 |
| ③ | applyMigrations 全量重放会撞 0000 | src/core/db.ts:68-88 按 meta/_journal.json 依序执行全部迁移文件,已有 schema 必撞 0000 建表语句 |
| ④ | resolveEvidenceChecks 单一来源 | deploy/preflight.ts:16 直接 `import { resolveEvidenceChecks } from "../src/worker-entry.ts"`(src/worker-entry.ts:40 起,功能性 kind 白名单/非空 argv/timeout 1s~600s/布尔收口,启动即抛 fail-closed);preflight 复用同一函数,无第二校验器 |
| ⑤ | 2.5 分支保守停机语义一致 | src/core/gate-orchestrator.ts:251 起:`machineEvidenceRequired && !hasFunctionalChecks` ⇒ `functional_evidence_unconfigured` conservativeStop(NEEDS_DECISION,永不自动批准)——与 Runbook 步骤 1 UNKNOWN①、REPORT §3 描述一致 |
| ⑥ | 2.45 归属绑定与登记残留语义一致 | src/core/gate-orchestrator.ts:302 起:失配⇒conservativeStop `workspace_provenance_mismatch`(零检查/零 Reviewer/审计 GATE_WORKSPACE_PROVENANCE_MISMATCH);无绑定记录⇒跳过"由既有双门与工作区边界把关(不虚构拦截;残留如实登记)"——与 preflight run_workspace_binding 三态语义、演练第 5 组双侧断言一致 |
| ⑦ | backup.sh / restore-verify.sh 与 Runbook 步骤 3 一致 | backup.sh:需 `RELAY_DB_URL`(宿主 pg_dump 优先,缺则容器回退 `RELAY_PG_CONTAINER:-relay-p000-pg`,库名取 URL 末段);restore-verify.sh:`<备份目录> <隔离连接串>`,`RELAY_RESTORE_CONTAINER:-relay-restore-verify`,DROP/CREATE DATABASE 于隔离实例,`-v ON_ERROR_STOP`——与 Runbook 引用逐字一致 |
| ⑧ | 回滚面:零 src/ 改动 | `git status`:修改仅 `deploy/README-deploy.md`(diff=54 插入/0 删除,**纯追加**);全新未跟踪=`deploy/evidence-checks.sample.json`、`deploy/preflight.ts`、`test/integration/deploy-preflight.test.ts`、`p0-mvp/deploy-preflight-05/`;另有 `config/`、`p0-mvp/soak-r3b/` 为**先前包受保护遗留**(CURRENT.md 登记),非本包产物。**确认零 src/ 改动** |

补充核实:Runbook 步骤 4.3 的 `egress ready(network=relay-egress-net)` 横幅真实存在(src/worker-entry.ts:138,模板字面量 `[relay-worker] egress ready(network=…)`);`RELAY_SANDBOX_IMAGE` 默认值 `node:24-bookworm-slim`(src/runtime/sandbox.ts:38)与 preflight/Runbook 一致;`teardownEgress` 确实拆除代理容器与共享网络规则(src/runtime/egress.ts:359 起)——E1 归因表述成立。

### E. 边界合规审计——通过

- **preflight 生产命令面全部只读**:`git rev-parse/log -1 --format=%cI/status --porcelain --untracked-files=no`、`systemctl --user show -p …`、`ss -tln`、`docker info --format ok / images -q / network inspect / ps --format --filter`、`docker exec relay-p000-pg psql … -c <SQL>`。无 start/stop/restart/kill/exec-交互。
- **SQL 逐一核对(共 5 条,全部只读)**:①`SELECT 1`;②information_schema.tables 查表清单;③迁移标志物 4 子查(information_schema.tables/columns);④`SELECT state,count(*) FROM <schema>.tasks GROUP BY state`;⑤runs LEFT JOIN tasks 聚合绑定计数。**零 INSERT/UPDATE/DELETE/DDL/CREATE/DROP**。
- **取值零输出**:env 值仅内部使用(RELAY_EVIDENCE_CHECKS_JSON 交 resolveEvidenceChecks 结构校验、RELAY_DB_URL 仅解析库名、RELAY_MAX_OUTPUT_TOKENS 仅校验),任何输出/detail/JSON 仅键名、计数、kind 名、镜像 tag、库名等非敏感项;凭据文件仅 statSync 权限位。
- **测试文件边界**:test/setup/testdb.ts:92-96 —— schema 钉死 `p01a_` 前缀+守卫拒绝非 p01a_;演练全部临时目录 `mkdtempSync(join(tmpdir(),…))` 且 finally/afterAll 清理;MODEL=stub(baseUrl 127.0.0.1:1)零模型;零远端写入;第 6 组真实容器默认禁网(DNS 探针反向断言)。测试对生产 schema 仅在真实测试库 p01a_ 上操作。
- Reviewer 自身边界:全程只读命令+一次测试运行+仅写本报告文件;零生产写入、零重启、零模型、零远端写、未触碰 config/ 与 p0-mvp/soak-r3b/、未读 env/口令取值。

### F. REPORT §1-6/§8-10 事实抽查(10 项,全部属实)

| # | 事实 | Reviewer 独立核验 |
| --- | --- | --- |
| 1 | 进程旧代码结论(process_vs_head UNKNOWN) | 亲跑预检同判;systemd show:`start_time=[Fri 2026-11-13 02:00:08 CST]`,PID 3242781/3242782,早于 HEAD 提交 2026-11-14T08:09:16+08:00(`git log -1 --format=%cI b3d1e5e` 亲测) |
| 2 | 在途聚合(tasks BLOCKED 1 + PAUSED 1;goals ACTIVE 2;runs 1;leases 1) | 只读聚合查询亲测:`goals:ACTIVE=2 / tasks:PAUSED=1 / tasks:BLOCKED=1 / runs_total=1 / leases=1` 全部一致 |
| 3 | 绑定残留计数 1(BUDGET_EXHAUSTED,task=BLOCKED,无 workspace_dir) | 只读 SQL 亲测 `runs_unbound=1`;preflight 输出一致 |
| 4 | E1 egress 结论(network+proxy 双缺,worker 已降级,重启后 ensureEgress 自愈) | `docker network inspect relay-egress-net` ⇒ MISSING、`docker ps --filter name=^relay-egress-fwd$` ⇒ MISSING(亲测);teardownEgress/ensureEgress 源码在位 |
| 5 | quality 三证据目录存在且 PASS | test-evidence/quality-{quick,full,release}-2026-11-14T00-45-31|00-46-01|00-52-19/ 三目录亲测在位,evidence.json 逐项 status=PASS,release overall `"verdict": "PASS"`,含 backup-restore 项 |
| 6 | NOT_RUN 清单合理性 | §10 各项(迁移补齐/检查配置/重启/切换=D3 授权;restore 手工路径;真实模型/交付/UX/稳定性;非 systemd 环境)均属用户授权或环境边界,如实未虚构 |
| 7 | CI 43532232497@b3d1e5e success | 经代理 `gh run view 43532232497 --json …`(只读):`conclusion=success, headSha=b3d1e5ee…, status=completed, workflowName=ci` |
| 8 | audit 55 行(最新 2026-11-12 23:33 UTC) | 只读 `SELECT count(*)=55; SELECT max(ts)=2026-11-12 23:33:56.737981+00` 亲测一致 |
| 9 | /api/health 未登录 401、web 绑定 10.30.5.80 单接口 | `curl -w %{http_code}` ⇒ 401(亲测);preflight web_bind=10.30.5.80 |
| 10 | 近 24h journal error 零条目;Node v24.21.0/Docker 29.1.3;unit=模板安装版(/usr/local/bin/node) | `journalctl --user -u relay-web -u relay-worker --since -24h -p err` ⇒ 0 条(亲测);node --version / docker --version / systemctl show ExecStart 逐项一致 |

### G. 红绿完整性——覆盖充分,无假 PASS

- 合同 C 场景对照:正例(组1,真实测试库+真实 env 文件格式)/候选漂移(组6②,snapshotManifest→修改→verifyCandidateManifest ok=false)/归属缺失与不一致(组5,失配零执行+审计行=1、无绑定跳过⇒ACCEPTED)/非法 env·check(组2,五类×[resolveEvidenceChecks 启动即抛 + preflight FAIL/NO-GO] 同构断言)/容器不可用(组3,NOT_RUN 显式断言不假 PASS)/禁网(组6③,DNS 探针"仅在禁网时成功"反向断言)/旧运行状态与恢复门(组4,pre NO-GO→真实 reclaimExpiredLeases+reconcilePendingTasks(断言无 EXECUTING 意图)→复检 READY=2→GO)。**全覆盖**。
- 防假 PASS:computeVerdict 纯函数(FAIL⇒NO-GO;NOT_RUN/UNKNOWN⇒UNKNOWN,绝不转 GO);组3 断言 NOT_RUN;组6 `describe.skipIf(!dockerAvailable())` 显式门控(合同"容器不可用=NOT_RUN 语义"同构);组1 脱敏断言(SECRET_PROBE/MASKED 不出现在报告 JSON)。
- 断言具体度:detail 内容断言(`READY=2`、`不自动补写`)、spy 零执行断言(runnerCalls/reviewer.calls=0)、审计行计数断言(=1),无弱化断言。

---

## 二、Major 清单(阻断)

### Major-1:defaultProbes.units() 时区解析缺陷 —— sinceIso 偏移 +14 小时,process_vs_head 存在假 PASS 窗口

- **事实(亲测)**:本机时区=Asia/Shanghai(`timedatectl`:Local time Sat 2026-11-14 09:05:12 CST / Universal 01:05:12 UTC / Time zone: Asia/Shanghai (CST, +0800))。systemd `ExecMainStartTimestamp` 打印本地墙钟 `Fri 2026-11-13 02:00:08 CST`(真实 UTC=**2026-11-12T18:00:08Z**)。而 `deploy/preflight.ts` units() 用 `Date.parse(sinceRaw)` 解析,V8 把缩写 "CST" 判为美中区(UTC-6),得 **2026-11-13T08:00:08Z**(亲测:`new Date(Date.parse('Fri 2026-11-13 02:00:08 CST')).toISOString()` ⇒ `2026-11-13T08:00:08.000Z`)——比真实 UTC 快 14 小时。
- **影响**:①preflight 输出与实现者证据 log 中 `since=2026-11-13T08:00:08.000Z` 为**错误时间戳**(本例裁决方向恰好不受影响:真值/误值均早于 HEAD ⇒ 仍判旧代码 UNKNOWN,结论侥幸正确);②**假 PASS 窗口可达**:凡进程真实启动时间落在 HEAD 提交前 0~14h 内,误值将晚于 HEAD ⇒ preflight 输出"[PASS] process_vs_head:运行中进程启动时间晚于 HEAD 提交(新代码已在进程内生效)"——与事实相反;该项 PASS 可参与构成假 GO,直接违背合同 A"区别'代码已更新''进程仍旧''未能读取'的事实"与工具自身的诚实性定位。
- **定性**:部署准入判定工具的**事实错误**(判定逻辑缺陷+已交付证据含错误时间戳),符合 REWORK 标准。
- **修复建议**:不依赖 V8 对时区缩写的解析——以 `date -d "<raw>" +%s`(GNU date 按本机时区解析)取 epoch,或把 systemd 原串的时区缩写替换为本机数值偏移(`date +%z`)后再解析;修复后**重跑生产预检并更新证据 log**。当前生产实例修复后预期结论不变(NO-GO;since 应显示 2026-11-12T18:00:08Z)。

## 三、Minor 清单(登记不阻断)

- **Minor-1**:deploy/README-deploy.md 步骤 4 与 REPORT §4.4 称"0008/0009 **加列均为可空**,回退代码无需回滚 schema"——与迁移文件不符:0008 `execution_request` 为 `boolean NOT NULL DEFAULT false`(**非可空**),仅 0009 可空。操作结论本身仍成立(旧代码不读该列;INSERT 未指定时走 DEFAULT false,故回退代码无需回滚 schema),但表述须改为如实描述(建议:"0008=非空默认 false、0009=可空;旧代码不读 ⇒ 回退无需回滚 schema")。登记建议:随 REWORK 修复轮一并改述。
- **Minor-2**:REPORT §10 称 systemd 探针"其它环境按 NOT_RUN 处理不假 PASS",与代码不符:systemctl 读取失败时 units() 返回 `active:false` ⇒ svc_* 判 **FAIL**(保守 NO-GO),而非 NOT_RUN;且 runPreflight 中 svc_* 的 NOT_RUN 分支在默认探针下不可达(units() 恒返回两项)。保守方向可接受(fail-closed),但报告表述须纠正;或后续在 units() 中区分"读取失败"与"未运行"两态。
- **Minor-3**:preflight run_workspace_binding 以 `r.detail ? 'workspace_dir'`(键存在即 bound)计数,而编排 2.45 要求**非空字符串**才算绑定;`detail.workspace_dir=""`(空串)会被 preflight 计为"有绑定"而编排视为无绑定跳过。当前 runner insertRun 不产生空串(风险极低),建议后续统一为非空判定语义。
- **Minor-4**:实现者演练证据 log 因 vitest 输出策略仅列出第 4/5/6 组(慢)用例名,第 1-3 组用例名不可见;Reviewer 亲跑复现同形态且 12/12 计数真实,非造假,但证据可读性不足。登记建议:后续演练证据附 `--reporter=verbose` 全用例名清单。

## 四、REPORT §7 须按本裁决回填(明确声明)

**REPORT-RELAY-DEPLOY-PREFLIGHT-05.md §7 当前为占位预写("裁决 PASS(0 Major + 4 Minor)"及预设的"Reviewer 亲测"清单),不是独立 Reviewer 的真实结论。** 本报告裁决为 **REWORK(1 Major + 4 Minor)**。入库前置条件:实现者须按本 REVIEW 的实际裁决修订 REPORT §7(裁决、Major/Minor 数量与登记项、"Reviewer 亲测"内容以本报告为准),并同步消化 §4.4/§9/§10 中与本报告 Minor-1/Minor-2 相符的表述;**若实现者未按本裁决修订 §7 即入库,即为缺陷**。REPORT 其余事实(§1-6/§8-10)经本报告 F 项 10 项抽查全部属实,无需改写。

## 五、边界合规确认

- Reviewer 全程仅:只读命令(git status/diff/log、ls/cat/grep、node --version、systemctl show、ss、curl GET、docker info/images/network inspect/ps、docker exec psql 只读 SELECT/information_schema、gh run view 只读、journalctl 读、date/timedatectl)、只读测试运行(vitest,隔离 p01a_ schema+真实 Docker)、写本报告文件。
- 零代码/文档修改、零 git 写、零 systemd 变更、零 relay_console 写、零 env/口令取值读取或输出(键名可显示项除外)、零 config/ 与 p0-mvp/soak-r3b/ 触碰、零模型调用、零真实 GitHub 写入。
- 生产库访问仅限 SELECT/information_schema 聚合(亲跑 6 条,全部只读,零原始用户数据读取)。

## 六、裁决依据小结

交付物的主体质量良好:18 项检查与退出码语义正确、SQL 全只读、脱敏零泄漏、演练红绿完整、Runbook 与源码逐条相符、REPORT 事实抽查 10/10 属实、回滚面干净(零 src/ 改动)。唯一阻断项为 Major-1(时区解析缺陷 ⇒ 判定工具事实错误+假 PASS 窗口),修复代价小但必须修复并复跑证据;另 4 项 Minor 登记不阻断。故 **REWORK** 而非 PASS;不存在治理违反或环境不可测,故非 BLOCKED。

—— Reviewer(隔离上下文),2026-11-14

---

# 第二轮复核(2026-11-14,针对 7f61a51「RELAY-DEPLOY-PREFLIGHT-05 实施」)

- **第二轮裁决:PASS**(0 Major;新登记 Minor-5 不阻断;REPORT 回填为入库前置条件,见下)
- 复核对象:7f61a515b923cb12c5fb4271e7dae80fd4ee604a(工作树清洁,仅未跟踪 `p0-mvp/deploy-preflight-05/` 证据目录 + 受保护 `config/`、`p0-mvp/soak-r3b/`;`git show --name-status 7f61a51` = M deploy/README-deploy.md + A deploy/evidence-checks.sample.json + A deploy/preflight.ts + A test/integration/deploy-preflight.test.ts,**零 src/ 改动**,回滚=revert 7f61a51)。

## 一、Major-1 修复验证(三项亲测,全部通过)

1. **①真实值对照**:`systemctl --user show relay-web/relay-worker -p ExecMainStartTimestamp --value` ⇒ 两服务均 `Fri 2026-11-13 02:00:08 CST`;GNU date 真值 `date -d "Fri 2026-11-13 02:00:08" +%s` ⇒ `1794506408` = **2026-11-12T18:00:08.000Z**;内联直调 `defaultProbes({}).units()`(node --input-type=module,零仓库改动)⇒ 两服务 `sinceIso=2026-11-12T18:00:08.000Z`——**与真值一致(第一轮错误值 2026-11-13T08:00:08Z 已消除,+14h 偏差归零)**。
2. **②假 PASS 窗口闭合(注入探针反例,node -e 内联调用 runPreflight,零仓库改动)**:HEAD 提交时间取 2026-11-14T00:09:16Z(b3d1e5e)——
   - 反例 A:units sinceIso=**HEAD-13h**(第一轮假 PASS 窗口形态:真实早于 HEAD、旧 misparse 会翻转为晚于)⇒ 实测 **UNKNOWN「进程启动时间早于 HEAD 提交」**——窗口闭合;
   - 反例 C:sinceIso=HEAD-14.1h ⇒ UNKNOWN(更早仍判旧代码);
   - 合法对照 B:sinceIso=HEAD+1h ⇒ PASS(判新代码,正确)。
3. **③生产复跑一致性**:`node deploy/preflight.ts`(**exit 2**)与 `node deploy/preflight.ts --json`(**exit 2**)——`git_head=PASS(HEAD=7f61a51;被跟踪树清洁)`、两服务 `since=2026-11-12T18:00:08.000Z`、FAIL=db_migrations(缺 0008+0009)、UNKNOWN×3(process_vs_head/evidence_checks_config/egress_stack)、其余 PASS、裁决 NO-GO——**与实现者新留证 evidence/preflight-prod-20261114.log(text+json 双份,01:12:54/56Z @ 7f61a51)逐项一致**。
4. 脱敏复扫(修复后工具):`--json` 输出 `postgresql://` 0 命中、API 键值/Bearer 模式 0 命中。
5. 新命令边界:`date -d "<wall>" +%s` 为只读解析,探针面仍全只读;绑定 SQL 仍为只读聚合。

## 二、第一轮 Major/Minor 逐条闭环结论

| 项 | 结论 | 证据 |
| --- | --- | --- |
| Major-1(CST 误解析 +14h/假 PASS 窗口) | **已闭合** | 上述①②③三项亲测全过;units() 现剥离时区缩写后以 GNU date 按本机时区解析(preflight.ts:457-466) |
| Minor-1(0008"均为可空"表述错误) | **已闭合** | README-deploy.md:64「0008 加列 NOT NULL DEFAULT false[旧行自动回填 false]、0009 加列可空」;:86 回滚段同口径修正 |
| Minor-2(REPORT §10"按 NOT_RUN"与代码不符) | **已闭合** | REPORT §10:96 现为「服务不可读时按 FAIL 呈现(保守方向),其它环境按 NOT_RUN/FAIL 处理不假 PASS」——与代码实际行为一致 |
| Minor-3(绑定判据键存在≠编排非空语义) | **已闭合** | preflight.ts:329 绑定查询改为 `(COALESCE(r.detail->>'workspace_dir','') <> '')::text`,与编排 2.45 非空判定同口径;生产结果不变(unbound=1) |
| Minor-4(演练 log 用例名不全) | **已闭合** | evidence/rehearsal-tests-20261114.log 以 `--reporter=verbose` 重生成(09:11:47),**12 条全用例名逐条可见**(6+6) |

## 三、第二轮亲测(第 3 项)

- `npx vitest run test/integration/deploy-preflight.test.ts test/integration/worker-evidence-checks.test.ts` ⇒ **12/12 全绿,exit 0**(Reviewer 亲跑 09:16:20)。
- `npm run quality:quick` ⇒ **PASS,exit 0**(Reviewer 亲跑,证据 test-evidence/quality-quick-2026-11-14T01-16-29/evidence.json `"verdict": "PASS"`);实现者留证 test-evidence/quality-quick-2026-11-14T01-11-56/ 在位。

## 四、新登记 Minor-5(不阻断)

- **Minor-5**:units() 解析失败回退 `sinceIso=null` 时,process_vs_head 的 stale 过滤会静默排除该单元 ⇒ 全部单元不可读时该项判 **PASS「新代码已在进程内生效」**(注入探针反例 D 实测:sinceIso=null ⇒ PASS)。"未能读取"未按合同 A 三区分独立呈现,与 fail-closed 方向不符。触发面窄(需 `date -d` 失败/非 GNU 环境;VM80 已实证可用),且该 null 回退形态在第一轮代码中即存在(Date.parse NaN⇒null),非本次修复引入的回归。登记建议:下次触及本文件时,任一 active 单元 sinceIso=null ⇒ process_vs_head 判 UNKNOWN「未能读取服务启动时间」。

## 五、REPORT 回填声明(第二轮版,入库前置条件不变)

REPORT-RELAY-DEPLOY-PREFLIGHT-05.md 尚为**未跟踪文件,未入库**;其**头部裁决行(仍写"PASS(0 Major + N Minor)")与 §7(仍为第一轮占位预写"PASS(0 Major + 4 Minor)")未按第一轮真实裁决(REWORK,1 Major + 4 Minor,已全部消化)回填**;§9 仅列实现者 Minor-PF-1..4,未收录 Reviewer 第一轮 4 项闭环与本轮 Minor-5。§5 已由实现者同步为新 HEAD 证据(14 PASS/1 FAIL/3 UNKNOWN,text+json 双份,亲核一致)。**入库前置条件:实现者须在 REPORT 入库提交前,将头部裁决行、§7、§9 按两轮真实裁决回填(第一轮 REWORK(1M+4m)已消化;第二轮 PASS(0 Major;Minor-5 登记));若未回填即入库,即为缺陷。** 7f61a51 提交信息本身已如实记录第一轮 REWORK 消化,git 历史无失实。

## 六、第二轮边界合规确认

Reviewer 全程仅只读命令(git status/log/show、sed/grep/cat、systemctl show、node 内联调用只读函数、vitest、npm run quality:quick、ls)与写本报告文件;零生产写入、零重启、零模型、零远端写、零仓库文件改动(含测试/探针均为内联或既有文件)、config/ 与 soak-r3b/ 零触碰。

—— Reviewer 第二轮(隔离上下文),2026-11-14
