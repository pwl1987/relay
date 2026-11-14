# RELAY-DEPLOY-PREFLIGHT-05 最终报告

裁决:**PASS**(独立 Reviewer 隔离上下文两轮:第一轮 REWORK[1 Major + 4 Minor,均消化]→ 第二轮 **PASS[0 Major,新登记 Minor-5 不阻断]**;预检复现/演练重跑/脱敏审计/反例注入探针由 Reviewer 亲测)

日期:2026-11-14
合同:b3d1e5e(CURRENT.md「RELAY-DEPLOY-PREFLIGHT-05」ACTIVE;开工冷启动 live main=origin=本地 `b3d1e5ee9d38941c6c67f368708d7899cb4d35a4`,CI 43532232497@b3d1e5e success)

## 1. 基线与 Writer

- 开工冷启动:远端在 68a53a2(04A-R2 收口)之上新增用户合同登记提交 b3d1e5e;本地纯落后 1 提交(ahead 0/behind 1),`git merge --ff-only` 快进同步,无 Writer 冲突;受保护未跟踪 `config/`、`p0-mvp/soak-r3b/` 全程零触碰;Writer=本窗口唯一,main-only 快进,零生产重启/零模型调用/零真实远端写入。
- **本包零 src/ 改动**:交付面=deploy/ 工具与文档 + test/ 演练 + 证据;生产 worker/web/数据库/凭据零写入、零重启、零配置变更。

## 2. 冷启动与只读盘点(A 项;全部只读命令,值零输出)

- 运行态:`relay-web`/`relay-worker` systemd user 服务 active(2026-11-13 02:00:08 CST 起,PID 3242781/3242782);web 绑定 `10.30.5.80:8787` LAN 单接口(`/api/health` 未登录 401);unit 文件=模板安装版(`EnvironmentFile=~/.relay/console/env`,`ExecStart=/usr/local/bin/node`)。
- 代码指纹:**进程启动时间早于 HEAD 提交 ⇒ 运行中进程为旧代码**(启动时 HEAD≈67c89f2@01:55;其后 CONTROL-READY-03/SAFETY-CLOSE-02/QUALITY-LOCAL-01/04A/R2 全部未在进程内生效,新语义以服务重启为界)。
- 进程环境键名(仅键名):12 个 RELAY_*;**无 `RELAY_EVIDENCE_CHECKS_JSON`、无 `RELAY_MAX_OUTPUT_TOKENS`**;env 文件键名同 12 个(0600);web-password 0600。
- 版本:Node v24.21.0 / Docker 29.1.3 / PG17-alpine 容器 relay-p000-pg@127.0.0.1:55433(库 relayp000,生产 schema=relay_console);检查沙箱镜像 `node:24-bookworm-slim` 本地在位。
- DB 聚合(relay_console,零原始数据):tasks BLOCKED 1 + PAUSED 1;goals ACTIVE 2;runs 1(pi-rpc/BUDGET_EXHAUSTED,无 workspace_dir 绑定);leases 1;gate_verdicts/evidence/changesets/decisions 全 0;audit 55 行(最新 2026-11-12 23:33 UTC);近 24h journal error 级零条目。
- **发现 E1(出口约束栈不在)**:`relay-egress-net` 网络与 `relay-egress-fwd` 代理容器当前均缺失(测试套件 `teardownEgress` 拆除共享栈)⇒ 运行中 worker 已降级(下次容器创建将失败);worker 重启后首拍 `ensureEgress` 幂等重建自愈(旧进程 `egressInitDone` 一次性,不自愈)。已写入 Runbook 重启后核对项。

## 3. 生产 Gate 可用性与遗留 Run 准入(B 项)

- **`RELAY_EVIDENCE_CHECKS_JSON` 未配置**(env 文件无此键)⇒ 重启后:worker 启动不注入 checks ⇒ Gate 编排对代码变更候选先跑完整性硬门,随后 `functional_evidence_unconfigured` 保守停机 NEEDS_DECISION(gate-orchestrator 2.5 分支,源码核实)——fail-closed 安全,但 **Gate 自动放行不可用**,须用户 D3 决策:配置功能性检查(样例模板)或接受保守停机运行。"存在配置"≠"执行通过":生产现无已配置检查,样例模板的真实执行验证在隔离预演完成(§5)。
- 在途 Run:VERIFYING/DELIVERING/NEEDS_RECONCILE/RUNNING/READY 全 0 ⇒ 无在途副作用/租约风险;仅 BLOCKED 1 + PAUSED 1(历史遗留,不重入 Gate)。
- 历史 coder Run 缺 `runs.detail.workspace_dir`:1 条(BUDGET_EXHAUSTED 终态,task=BLOCKED,无 Gate 重入路径)⇒ 归属校验跳过=登记残留 R2-D3(既有双门把关);**未补写、未改状态、未隐瞒**,预检输出如实计数。
- 迁移面:**发现 E2(真实生产缺陷)——relay_console 缺 0008(goal_messages.execution_request)与 0009(tasks.abort_requested_at)**(两者为 DEPLOY-03D 部署后交付,生产 schema 停在 0007 面)。重启后新代码依赖:0009=停止旗标(worker 心跳轮询/Gate abort 前后检查)、0008=对话授权执行请求列。`init-schema.ts` 对已存在 schema 跳过(goals 在即跳)、`applyMigrations` 全量重放会撞 0000 ⇒ 增量补齐须按迁移文件逐条精确执行(迁移无自动化=DEPLOY-03D 既有登记项)。**本包未执行任何迁移**(写生产 schema 须用户单独 D3 授权;已写入 Runbook 步骤)。

## 4. 交付内容

### 4.1 最小只读预检入口 deploy/preflight.ts

- `node deploy/preflight.ts [--json] [--env-file <path>] [--pg-container <name>]`;退出码 0=GO / 1=UNKNOWN / 2=NO-GO。
- 18 项检查全部只读:git HEAD/被跟踪树、服务运行态+进程/HEAD 版本差三区分、凭据 0600、env 必需键名(仅键名)、`RELAY_EVIDENCE_CHECKS_JSON` 结构合规(**校验与 worker 启动校验 `resolveEvidenceChecks` 单一同源,无第二规则引擎**)、`RELAY_MAX_OUTPUT_TOKENS`、Web 绑定(通配绑定拦截含 IPv6)、Docker/沙箱镜像/出口栈、DB 可达/16 表/迁移标志物/在途任务聚合/Run 归属绑定聚合。
- 脱敏:env 取值零输出(仅键名+结构合规;凭据值不出现在任何输出/报告/JSON);DB 仅聚合计数;镜像 tag/库名等非敏感取值可显示。
- 归属绑定语义:仅"缺绑定且任务在 VERIFYING/DELIVERING(可能重入 Gate)"⇒ FAIL(D3 处置);终态/排队陈旧行 ⇒ PASS+如实计数说明;reviewer run 行(role=reviewer)排除。
- 判定器纯函数:FAIL>0 ⇒ NO-GO;NOT_RUN/UNKNOWN>0 ⇒ UNKNOWN;否则 GO;输出脚注明示"GO/UNKNOWN 仅代表部署准入材料状态,不代表可自动发布"。
- 生产默认探针 psql 经 relay-p000-pg 容器执行(与 backup.sh 容器回退同源;RELAY_DB_URL 仅内部解析库名,取值零输出);探针端口可注入(测试用)。

### 4.2 样例配置模板 deploy/evidence-checks.sample.json

- 1 条 `deterministic_test` 样例(工作区 relay-smoke.txt 存在性+内容断言);**样例非生产取值**;写入 env 须压平单行 KEY=VALUE(env 文件行格式,演练实证多行 JSON 会破坏解析);检查命令在容器 UID 10001 下执行 ⇒ 候选文件需 o+r(runner 工作区目录已 chmod o+rwX;演练实证宿主 umask 收紧会使容器 EACCES,如实登记)。

### 4.3 隔离演练 test/integration/deploy-preflight.test.ts(6 用例,p01a_ schema+临时工作区/临时 env+真实 Docker+受控桩;零模型/零远端)

1. 正例:stub 探针+真实测试库 ⇒ 全 PASS ⇒ GO;样例模板经 `resolveEvidenceChecks` 合法;报告零凭据值泄漏断言(SECRET_PROBE/MASKED 不出现在任何输出)。
2. 非法 env/check ×5(kind 非功能性/空数组/timeout 越界/空 argv/非 JSON)⇒ preflight FAIL/NO-GO,且与 `resolveEvidenceChecks` 启动即抛同构(重启=fail-closed crash,不假放行)。
3. 容器不可用:Docker 探针不可用 ⇒ sandbox_image/egress_stack **NOT_RUN**(不假 PASS),docker_available FAIL ⇒ NO-GO。
4. 旧运行状态与恢复门:VERIFYING+RUNNING 在途+旧格式无绑定 Run(RUNNING 非终态)⇒ NO-GO;Supervisor 回收链(租约到期→reclaimExpiredLeases→NEEDS_RECONCILE→reconcilePendingTasks[无 EXECUTING 意图]→READY)恢复可用 ⇒ 复检只余 READY 排队(不阻断),陈旧 Run 行如实计数 ⇒ GO。
5. 编排层归属失配/缺失(生产同源 orchestrateGate):外来目录(内容相同)⇒ `workspace_provenance_mismatch` 保守停机+检查/Reviewer 零执行+审计行;无绑定记录 ⇒ 2.45 跳过、既有双门+Reviewer 照常 ⇒ ACCEPTED(登记残留语义复现)。
6. 真实 Docker(门控 dockerAvailable):样例模板命令在 `node:24-bookworm-slim` 沙箱真实执行通过(**镜像对既定命令支持实证**);候选漂移检出(基线清单→修改→verifyCandidateManifest ok=false);默认禁网 fail-closed(DNS 探针"仅在禁网时成功"——若出口未禁探针自身失败)。

### 4.4 Runbook(deploy/README-deploy.md 追加)

- 最小可执行切换前 Runbook:只读预检入口 → GO/NO-GO/UNKNOWN 基线表(2026-11-14 实测)→ 配置决策项(D3)→ 备份/隔离恢复演练 → 明确操作顺序(复检→restart→横幅核对[含 egress ready]→健康/认证/LAN→失败回滚[代码回退+env 备份恢复;0008/0009 加列可空,回退代码无需回滚 schema])→ 显式未自动验收清单。明确:本包 PASS 只代表"具备提出生产切换审批申请所需材料",生产切换须用户单独 D3 授权;隔离测试产物按所属清理,生产无回滚动作(本包未改生产)。

## 5. 生产实测(最终 HEAD 绑定证据,证据=p0-mvp/deploy-preflight-05/evidence/preflight-prod-20261114.log,text+json 双份,退出码均 2)

- 对生产实例亲跑 `node deploy/preflight.ts` @ `7f61a515b923cb12c5fb4271e7dae80fd4ee604a`(清洁树):**裁决 NO-GO** —— 14 PASS(含 1 条 PASS-with-note:终态无绑定 Run=登记残留如实计数)/ 1 FAIL(迁移缺 0008+0009)/ 3 UNKNOWN(EVIDENCE_CHECKS 未配置 / 进程旧代码 / egress 栈不在)。
- NO-GO 与 UNKNOWN 全部有明确处置路径(Runbook §2/§3/§4);无一条靠"存在配置"或跳过检查转绿。

## 6. 测试与质量证据

- 定向:deploy-preflight 6 + worker-evidence-checks 6 = **12/12 全绿**(--reporter=verbose 留证,全用例名可见;证据 evidence/rehearsal-tests-20261114.log,基线 7f61a51)。
- `quality:quick` PASS(lint+format+typecheck+unit;证据 test-evidence/quality-quick-2026-11-14T00-45-31/)。
- `quality:full` PASS(单测+真 PG 集成+容器安全门+浏览器;证据 test-evidence/quality-full-2026-11-14T00-46-01/)。
- `quality:release` PASS(**READY**;备份→隔离实例恢复 13 表全实体核对一致 [RELAY_BACKUP_E2E];证据 test-evidence/quality-release-2026-11-14T00-52-19/;性能/模型门禁/真实部署按 NOT_RUN 登记不虚构)。
- 浏览器证据再生按纪律 `git checkout --` 恢复(p0-02c/ p0-mvp/webux-02/ p0-webux-03c/ p0-webux-03d/)。
- 演练中修复的两处测试适配(runs.outcome 非空约束 ⇒ 非终态=RUNNING;宿主 umask 007 ⇒ 0660 文件容器不可读须显式 0644)均为**演练夹具适配**,非产品缺陷;已作为部署注意项写入 Runbook(候选文件 o+r)。

## 7. 独立 Reviewer(隔离上下文,两轮)

- **第一轮 REWORK(1 Major + 4 Minor)**:报告=p0-mvp/deploy-preflight-05/REVIEW-RELAY-DEPLOY-PREFLIGHT-05.md(Reviewer 亲写)。Reviewer 亲测:生产预检复现(退出码 2 NO-GO 与实现者证据一致;迁移缺失经 information_schema 独立自证 1|1|0|0)、脱敏审计(postgresql:// 0 命中/凭据值 0 命中/env 行仅键名)、演练重跑 12/12、Runbook 八项对照源码全符、REPORT 事实抽查 10/10 属实、边界合规(5 条 SQL 全只读/命令面只读/测试钉死 p01a_+临时目录/零模型零远端)。
  - **Major-1(阻断,已修复)**:`defaultProbes.units()` 用 `Date.parse` 解析 systemd 时间戳,时区缩写 "CST" 被误判为美中区(-6)⇒ sinceIso 偏移 +14h,process_vs_head 存在**假 PASS 窗口**(进程真实启动于 HEAD 前 0~14h 内会被误判"新代码已生效")——准入判定工具的事实错误。
  - Minor-1~4:0008/0009 "加列均为可空"表述与迁移文件不符(0008=NOT NULL DEFAULT false)/REPORT §10 svc 不可读实为 FAIL/preflight 绑定判据(键存在)与编排 2.45(非空)边界不一致/演练 log 输出策略仅列部分用例名(计数真实)。
- **修复(提交 7f61a51 内消化)**:Major-1 ⇒ 剥离时区缩写后按本机时区 GNU date 解析挂钟时间(生产实测 since=2026-11-12T18:00:08Z=02:00:08+08 正确;Reviewer 注入探针反例:HEAD-13h/HEAD-14.1h ⇒ UNKNOWN 判旧代码,假 PASS 窗口闭合,HEAD+1h ⇒ PASS 合法);Minor-1/2 表述修正;Minor-3 ⇒ 绑定判据改 `COALESCE(detail->>'workspace_dir','') <> ''`(与编排非空同口径,生产结果不变);Minor-4 ⇒ 演练证据 --reporter=verbose 重生成(全用例名可见)。复跑 12/12 绿 + quick PASS。
- **第二轮 PASS(0 Major + 新登记 Minor-5)**:Major-1 修复三项亲测通过(真值对照/反例注入/生产复跑与实现者新留证 log text+json 双份逐项一致);Minor-1~4 逐条闭环确认;演练 12/12 + quick PASS 亲跑。"第二轮复核"节已追加至 REVIEW 文件(第一轮原文未改写)。
- **Minor-PF-5(登记不实施)**:units() 时间解析失败回退 sinceIso=null 时,process_vs_head 静默排除该单元,全部不可读时会判 PASS"新代码已在进程内生效"——"未能读取"未独立呈现;触发面窄(需 `date -d` 失败,VM80 已实证可用),Reviewer 实测登记,不阻断。

## 8. 生产影响、回滚与边界

- **生产影响:零**(本包零 src 改动、零生产写入、零重启、零配置变更;preflight/演练全部只读或隔离)。
- **回滚**:本包全部为新增文件+README 追加 ⇒ `git revert` 本包提交即完全还原;无迁移、无 schema 写入、无生产动作。
- 边界合规:main-only 单 Writer 快进;禁强推/分支/改历史;config/ 与 p0-mvp/soak-r3b/ 零触碰;生产凭据零打印;零模型调用;零真实 GitHub 远端写入;不进入 REAL-PILOT/R-3B/MODEL-POLICY-01;不修改 Core 生命周期/Gate/Policy/Reviewer;不新建常驻控制服务。

## 9. 登记(Minor 与后续,均不阻断)

- **Minor-PF-1**:preflight 生产探针依赖 `RELAY_DB_URL` 解析库名+docker exec psql(容器名缺省 relay-p000-pg);非标准部署(容器名/库不同)须显式传参 —— 已在用法与 `--pg-container` 支持登记。
- **Minor-PF-2**:evidence_checks_config=UNKNOWN 为"未配置"决策项而非 FAIL —— 刻意语义(未配置=fail-closed 安全),由 UNKNOWN 裁决强制 D3 显式决策,不会被判定器误放行。
- **Minor-PF-3**:样例检查读取候选文件依赖 o+r 权限;宿主 umask 收紧环境(本机 007 实证)下文件 0660 容器不可读 —— 已写入 Runbook 注意项;生产 runner 工作区目录权限已同口径。
- **Minor-PF-4**:preflight 迁移标志物核对为表/列存在性检查,不校验列类型/内容 —— 足以拦截"缺迁移重启报错"这一部署风险,列级细节由迁移文件本体保证。
- **Minor-PF-5(Reviewer 第二轮登记)**:units() 时间解析失败回退 sinceIso=null ⇒ process_vs_head 静默排除该单元,全部不可读时可判 PASS("未能读取"未独立呈现);触发面窄(VM80 实证 date -d 可用),登记不实施。
- 既有登记不变:M-4 handback/STOPPED 恢复/审计结构化/迁移自动化(DEPLOY-03D 登记本包 Runbook 亦引用)/生产部署配置包=本包交付的即该材料,生产切换仍需用户单独授权。

## 10. NOT_RUN/未验证(如实)

- 生产迁移补齐(0008/0009)、`RELAY_EVIDENCE_CHECKS_JSON` 配置、服务重启、生产切换:全部属用户 D3 授权范围,本包未执行(预检 NO-GO/UNKNOWN 如实呈现)。
- restore-verify.sh 手工路径未在生产备份上执行(质量 release 的备份→隔离实例恢复为自动化等价路径,一次性 PG 容器;宿主无 psql,手工路径需恢复容器,已写入 Runbook)。
- 真实模型 Run/真实 GitHub 交付/用户 Mac 实机 UX/长期稳定性:未自动验收(合同明示)。
- preflight 对 relay-web/worker 的 systemd 探针在无 systemd 环境的兼容性:目标环境=VM80(有 systemd user);服务不可读时按 FAIL 呈现(保守方向),其它环境按 NOT_RUN/FAIL 处理不假 PASS。
