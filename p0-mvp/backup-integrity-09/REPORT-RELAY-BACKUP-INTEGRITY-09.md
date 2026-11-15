# RELAY-BACKUP-INTEGRITY-09 报告(备份/恢复范围一致性与 F-1 修复,隔离执行)

- **合同**:CURRENT.md 顶部 RELAY-BACKUP-INTEGRITY-09 🔵 ACTIVE(协调方登记提交 a458e95,合同文本以该提交为准)。
- **基线**:GitHub live main `c22d23f` → 快进 `a458e95`(09 合同登记,唯一新提交,fast-forward 安全);本地 main==live main,单 Writer,无分叉。冷启动实测确认了合同预告:本地 origin/main 跟踪指针曾落后 live main 一提交(cc8cab5 缓存),经安全 fetch+祖先核实后快进,未 reset 未强推。
- **实施窗口**:2026-11-15 下午(本报告所述改动=a458e95 之上的实施;提交后以 git 历史为准)。
- **范围**:仅修复备份/恢复链(backup.sh/backup-manifest.mjs/restore-verify.sh/restore-verify-check.mjs + 新增 backup-validate.mjs)与相关测试面;src/、migrations/、preflight、生产零改动。**合同结论口径=「09 工具备份/恢复链合成验收」,不构成任何生产 GO 提升。**

## 1. A 项:冷启动与备份链路审计(只读,零生产原始表查询)

- 受保护未跟踪物五项确认原样未动:`config/`、`p0-mvp/soak-r3b/`、三个 ci-checkruns-*.json(27e9259/c22d23f/e28c386);实施后 mtime 复核均早于实施窗口(evidence/boundary-09-check.log §5)。
- **拓扑实证**(test/setup/testdb.ts 既有只读注释):生产 relay_console 与测试 p01a_* schema **共享同一 PG 实例**(容器 relay-p000-pg,127.0.0.1:55433/relayp000);08 REVIEW 亲证该实例 public.audit_events 存在 DBOS 时代遗留表(4 行)。这使合同登记的风险为真实可达,非纯理论。
- **调用方盘点**(合同 A:先查实际调用者和产品要求):
  - `deploy/backup.sh` / `restore-verify.sh` 真实调用方=Runbook(deploy/README-deploy.md §3,D3 切换窗口人工执行)+ 历史 stage-e 复核演练;**无任何 tracked 测试直接调用**(两个测试均为"同命令形态"自实现)。
  - `backup-manifest.mjs` / `restore-verify-check.mjs` 真实调用方=backup.sh/restore-verify.sh + **08 E2E(test/integration/deploy-rehearsal-e2e.test.ts:145/203)**。
  - `test/integration/backup-restore.test.ts`(RELAY_BACKUP_E2E=1 门,quality:release 内置)= 自实现 schema 限定 pg_dump(`--schema=`)+一次性容器恢复+13 表行数/摘要核对,**不调用 backup.sh**;其隔离语义与 09 修复方向一致,零改动回归绿。
- **缺陷清单(逐行审计结果;编号供 Report/Review 引用)**:
  - **D1(F-1 核心)**:backup.sh 第 3 步审计索引两分支 `FROM audit_events` 未限定 schema ⇒ 经 search_path 解析到 public 遗留表(错源)或报错;docker 回退分支硬编码 `docker exec relay-p000-pg … -d relayp000`,**同时忽略 RELAY_DB_URL 的库名与 RELAY_PG_CONTAINER**(与第 1 步回退互相矛盾)。
  - **D2**:pg_dump 无 `-n` ⇒ 整库导出(生产 relay_console 原始数据+全部 p01a_* 测试 schema+public 遗留表全部混入)。
  - **D3**:backup-manifest.mjs 枚举**全库** candidate_changesets schema ⇒ 他租户 DELIVERED 元数据(schema 名/taskId/commit/remoteHead/文件清单)静默进入目标备份的 Artifact manifest。
  - **D4**:restore-verify-check.mjs 跨全 schema 求总数且**仅比计数** ⇒ 相同总数即可掩盖身份损坏(假一致)。
  - **D5**:restore-verify.sh 无隔离守卫 ⇒ DROP DATABASE/CREATE DATABASE 在任意 RESTORE_URL(含备份源/生产实例)上执行;无完成标记要求;`head -1` 取最旧产物(目录复用=陈旧混用)。
  - **D6**:backup.sh 内嵌绝对路径 `/home/ubuntu/dev/relay/deploy/backup-manifest.mjs`(移植性+唯一入口破坏)。
  - **D7**:无目标 schema 声明概念(静默整库);无目标存在性/归属校验。
  - **D8**:备份失败残留:无失败清理、无原子完成标记。
  - **D9**:restore-verify.sh `RESTORE_TARGET_URL="${RESTORE_URL%/*}/$T_DB"` 推导要求 RESTORE_URL 含库段,而其自身 psql 分支 `psql "$RESTORE_URL/postgres"` 要求 base URL(无库段)——两种形态互斥,base 形态下 check 步骤连接串被剥坏(getaddrinfo 把库名当主机名;**红态 Red-e 真实复现**,历史 stage-e 以含库段 URL 恰好兼容故未暴露)。
  - **D10**:恢复核对不核对审计索引(manifest 不含审计面,audit 总数仅打印不判)。
  - **D11**:校验和在恢复**之后**核验(损坏输入先触碰实例)。
  - **D12**:校验和仅覆盖 `*$STAMP*` 文件(无完成标记形态,完整性面不闭合)。
  - 边界内**不改**:目录权限沿用调用者 umask/目录既有形态(与 E3 一致,本包不扩大改动面;完整性由完成标记+校验和承担);`--no-owner --no-privileges`(恢复以 postgres 超户进行,历史既定语义)。

## 2. B 项:反例先红(真实脚本可达行为+可验证命令注入;零生产/他项目数据读取)

红态全部对 **a458e95 原始脚本**捕获(`/tmp/red09/orig/*` 逐字提取,md5 与工作区原文件一致;证据=p0-mvp/backup-integrity-09/evidence/red09-*.log;可复核 `git show a458e95:deploy/backup.sh`):

- **Red-a(docker fallback 真跑)**:原始 backup.sh 于合成双租户一次性实例(A=目标/B=他租户/C=零行边界+public.audit_events 合成干扰表)上运行:exit=0 **静默成功**,但 ①dump 87KB 含 A/B/C 三 schema+public 干扰表(D2);②manifest delivered=3 条含他租户 2 条(D3);③审计索引 **0 行空文件**(F-1 静默失败);④被硬编码的 `docker exec relay-p000-pg psql … relayp000 … FROM audit_events` argv 由受保护 shim 记录原文且**未执行**(绝不读取真实共享实例)。
- **Red-b(宿主分支 argv 捕获)**:可验证命令注入(PATH shim)捕获原始 backup.sh 宿主分支真实 argv:pg_dump **无任何 `-n/--schema`**(整库命令形态);psql 审计索引 SQL **未限定 schema**。(VM80 宿主无 pg_dump/psql,dump 内容红态由 Red-a 真跑承担;宿主分支以命令形态证据+Red-c 效应实证覆盖。)
- **Red-c(错源效应)**:与 Red-b 捕获 argv 逐字同形的未限定 SQL 在合成实例执行 ⇒ 返回 **public 干扰表 2 行**(目标租户 A 的 3 行审计一行未取)= 错源实证,精确对应 VM80 生产拓扑。
- **Red-d(相同计数假阳性)**:整库 dump 恢复到新库(含全部混入)→ 基线 check「一致 ✓」→ 删除目标 A 唯一 DELIVERED 行+插入他租户 B 行(总数 3=3)→ 原始 check.mjs **仍「一致 ✓」exit 0**;身份集合对比(manifest {A1,B1,B2} vs 恢复库 {B1,B2,B3})= 相同计数假阳性实证(D4)。
- **Red-e(无隔离守卫)**:原始 restore-verify.sh 接受 RESTORE_URL=备份源实例 base URL,在其上真实创建 `relay_restore_v1794728449` 并恢复全部混入 schema(前后 pg_database 列表对比);未设任何隔离声明;无完成标记要求(D5)。**附带实证 D9**(check 步骤连接串被剥坏,getaddrinfo EAI_AGAIN,exit=1 非守卫所致——原始脚本根本没有守卫)。
- **Red-f(单测断言红)**:test/unit/d09-backup-chain.test.ts(修复后语义断言)对原始脚本:红态①工具缺失(import 失败,vitest-exit=1)→ 红态②同断言变体 13/13 全红,失败原因逐条对准 D1-D8。
- 边界:红态全程零读取 relay-p000-pg 真实共享实例(受保护 shim 拦截+argv 记录);零生产数据;一次性容器销毁后零残留。

## 3. C 项:最小实现(唯一入口语义;不引入第二套备份管线)

改动面 10 文件(6 修改 +323/-80;4 新增 893 行;src/、migrations/、preflight、rehearse-migration、quality.mjs 零 diff):

1. **`deploy/backup-validate.mjs`(新增,78 行+d.mts 声明)**:fail-closed 目标校验单一入口——URL 合法性/库名缺失、schema 标识符白名单(防注入)、目标存在性 + Relay 表归属(candidate_changesets+audit_events,**仅读 information_schema 元数据,零原始数据查询**);连接失败/校验失败 exit 2 且零产物;消息全脱敏(redactDbUrl)。
2. **`deploy/backup.sh`(重写,保持四步结构)**:
   - 步骤 0=唯一入口:`RELAY_BACKUP_SCHEMA` 必显式声明(`<schema>` 或 `all`),未声明/非法名/校验不过 ⇒ 拒绝且零产物(校验先于 mkdir/任何连接);
   - 步骤 1=schema 模式 `pg_dump -n`(宿主/docker 回退两分支一致);`all`=显式旧版整库(绝不静默);
   - 步骤 2=manifest 经 `SCRIPT_DIR` 相对定位(修复 D6),schema 经 env 传递;
   - 步骤 3=审计索引两条路径同源 `run_psql` helper(容器=RELAY_PG_CONTAINER、库名=URL 末段,修复 D1 硬编码/不一致),schema 模式 `FROM "$SCHEMA".audit_events`;`all` 模式按 audit_events 存在性逐 schema 聚合(标识符白名单守卫,聚合前拒绝空集);
   - 步骤 4=filelist+**原子完成标记 backup-<STAMP>.done**(先于校验和,一并受核,修复 D12)+ 校验和;失败 trap 清理**本 STAMP** 产物(修复 D8),不掩盖退出码、不动目录内其他备份。
3. **`deploy/backup-manifest.mjs`**:必须显式 `RELAY_BACKUP_SCHEMA`;schema 模式参数化(`schema_name=$1`)存在性+归属校验后**只查目标 schema**;`all`=显式跨 schema 旧版聚合;manifest v2 记录 `targetSchema`(恢复核对目标身份唯一来源)+ generatedAt;delivered 行形状不变(08 E2E 断言兼容)。
4. **`deploy/restore-verify-check.mjs`**:manifest 必含 `targetSchema`(legacy/损坏一律拒绝);目标 schema 在恢复库存在性校验;**DELIVERED 集合身份核对**(schema/changesetId/taskId/commit/remoteHead 稳定键排序集合相等——相同计数不构成通过,修复 D4);**审计索引集合核对**(seq|ts|actor|action 服务端拼接与 backup.sh 同表达式,all 模式按 audit_events 表存在性聚合与备份侧同源,修复 D10);拒绝时输出差异样例(≤1 条)。
5. **`deploy/restore-verify.sh`**:
   - 守卫(任何 DROP/CREATE 之前):`RELAY_RESTORE_ISOLATED=1` 必显式;恢复目标实例与备份源实例前缀相等 ⇒ 拒绝;RESTORE_URL 形态限定 base 连接串;**修复 D9**(统一 base 形态,`RESTORE_TARGET_URL="${RESTORE_URL%/}/$T_DB"`);
   - 备份目录完整性:完成标记/唯一 db dump/manifest/审计索引/校验和 五项**数量必须为 1**(失败残留/多义目录拒绝,修复 D5 head-1 陈旧混用);manifest.targetSchema 提前校验+标识符白名单;
   - **校验和先于任何恢复动作**(修复 D11);恢复库带随机后缀 `relay_restore_v<epoch>_<RANDOM>`;失败 trap 清理本库,成功保留供人工核对(E3 既有语义);
   - schema 预建被移除:`-n` dump 自带 CREATE SCHEMA(红态实证 "already exists" 冲突),dump 自洽。
6. **`test/integration/deploy-rehearsal-e2e.test.ts`(08 E2E 调用方迁移,±19 行)**:manifest 调用加 `RELAY_BACKUP_SCHEMA: schemaName`;审计索引升级为规范 `seq|ts|actor|action` 限定形态并落盘;check.mjs 调用传审计索引文件;其余(迁移/回退/断言)逐字未动——"历史调用者经现有测试证明可安全迁移"(合同 C)。
7. **`deploy/README-deploy.md`(Runbook §3)**:09 后使用语义(RELAY_BACKUP_SCHEMA/RELAY_RESTORE_ISOLATED/base URL 形态)+F-1 状态从「登记」改为「已修复」+红态证据指引。
8. **测试面(新增)**:`test/unit/d09-backup-chain.test.ts`(155 行 15 测试,纯静态契约+动态 fail-closed,零 docker,进 quality:quick)+ `test/integration/d09-backup-integrity.test.ts`(652 行 5 测试,D 项全链,skipIf(!docker))。

兼容语义说明:E3 整库/跨 schema 能力未删除,转为**显式 `all` 模式**(manifest/审计聚合如实含 public 遗留表)并在 D 项真实演示端到端可重复(旧版调用者全部迁至 schema 模式且有测试证明)。

## 4. D 项:真实 E2E 验收(修后真实脚本全链;08R 经验证的 127.0.0.1 随机发布+inspect 安全门)

`test/integration/d09-backup-integrity.test.ts` 5/5 绿(evidence/green-09-d09-e2e.log,11.7s;终版定向复跑 20/20 含单测,green-09-targeted-final.log):

1. **主链**:修后真实 `backup.sh`(RELAY_BACKUP_SCHEMA=schA;VM80 实走 docker fallback)→ dump 恰好含 A 的 16 张表(0007 形状)+触发器+FK,**零 B/C/public 混入**;manifest targetSchema=schA 且 delivered=1(PENDING/他租户不入);审计索引 3 行全 A、零干扰;完成标记+校验和过 → 真实 `restore-verify.sh`(独立一次性恢复实例;RELAY_RESTORE_ISOLATED=1)→ 集合身份「一致 ✓」+审计「备份=3 恢复后=3」+核对通过 → 恢复库逐项:16 表/中文与 jsonb 保真/audit 3 行/DELIVERED 1 行/append-only 触发器存在且 DELETE 被真实拒绝/FK=3。
2. **扰动不变性**:向 B 注入 audit+DELIVERED 各一行后重跑备份 ⇒ A 的 manifest delivered **逐字节相等**、审计索引逐字节相等、dump 零 B 标记(合同 D:扰动 B 不改变 A 的备份结果)。
3. **fail-closed 矩阵**(每例拒绝+自身产物清理):未声明 schema(校验先于 mkdir,零产物)/目标不存在(validate 真连校验)/错容器(dump 失败 ⇒ trap 清理 stamp 产物+无 .done)/未声明 RELAY_RESTORE_ISOLATED(零 DROP/CREATE)/恢复目标=备份源实例(前缀守卫,源实例零新库)/缺完成标记/身份扰动(A 交付行被他租户形态行替代总数相等 ⇒ check exit=1 集合身份不一致)/审计索引丢一行 ⇒ exit=1 审计集合不一致/legacy manifest(无 targetSchema)⇒ 拒绝。
4. **宿主分支覆盖**(合同 D:缺 host 二进制时使用可验证命令注入):PATH shim 捕获宿主分支真实 argv —— `pg_dump … -n <schema> --file …` + `psql … FROM "<schema>".audit_events`(与 Red-b 旧形态对照:无 -n/未限定);宿主分支全链走完(manifest 为真实 node+pg 路径,完成标记落盘)。**CI 上进一步升级为宿主分支真跑全链**(runner 自带 pg_dump/psql,d09 E2E 主链 13.7s 经真实宿主工具执行,见 §6)。
5. **all 模式兼容演示**:显式 all ⇒ 整库 dump 含 A/B/public;manifest delivered=实例实况聚合(动态断言);审计索引如实含 public 干扰行;restore-verify 整库恢复+all 聚合身份核对 PASS(旧版能力可重复演示)。

**回归**(evidence/green-09-08-regression.log、green-09-backup-restore-regression.log):08 套件 13/13(迁移 9+真实 Docker E2E 1+Gate 3)——08 E2E 经迁移后语义全保持;backup-restore.test.ts(RELAY_BACKUP_E2E=1)1/1——既有隔离备份恢复语义零影响。**quality:quick PASS**(evidence/quality-quick-09.log;lint/format/typecheck/unit 15/15+全量单测绿);tsc --noEmit 干净;biome 干净。quality:full 本地 NOT_RUN(VM80 全量测试防 egress 栈互踩既定纪律)→ 由 exact-head CI test job 双绿覆盖(见 §6;CI 首跑 43694046569 暴露错容器用例的环境条件问题并即时修正,见 §6 时序如实)。

## 5. E 项:独立 Reviewer(隔离上下文;原文入库=REVIEW-RELAY-BACKUP-INTEGRITY-09.md)

- **Round1(2026-11-15 16:04~16:11;复核先于实施提交,该时序由 REVIEW 文件如实登记)**:Reviewer 冷启动亲验——红态真实性(git show a458e95 自行提取,md5 与红态日志引用逐字对照 5ae07ed6/23d89bf5/cfacfcf3)+ 源码逐行审 + 亲跑单测 15/15、d09 E2E 5/5(自建一次性容器,残留 0)、08 套件 13/13、backup-restore 1/1、quality:quick PASS、tsc 干净 + fail-closed 抽查 7 例全过 + **独立端到端全链**(自建双容器+双租户 schema,backup.sh→restore-verify.sh 全链 PASS,恢复库身份逐字相等)+ 边界复核(PID 3242781/3242782 只读核对、保护物原样、零 reset/commit/push)+ 反例闭环判定(五类反例+D9 全部红态实证且修后语义拒绝亲证)。发现 **1 Major + 4 Minor**:Major-1=restore-verify.sh 失败清理判据 `CREATED=1` 在恢复完成后才置位,CREATE DATABASE 成功但 psql -f 中途失败时部分恢复库不被 trap 清理(**Reviewer 自建容器注入非法 SQL 实证 exit=3+残留 1 库**);M1=backup.sh DB_NAME 不剥 query 段;M2=RESTORE_URL 未显式拒绝带库名段;M3=单测死正则分支;M4=矩阵缺中途失败路径。裁决 **REWORK(有界:一行级修复+1 例矩阵断言)**。
- **Round1 修复**:①restore-verify.sh 两分支 CREATE DATABASE 成功后立即置 `CREATED=1`;②DB_NAME 剥 query/fragment(与 validate 解析一致);③RESTORE_URL base 形态强校验(检测到库名段即拒绝);④单测死分支移除;⑤d09 矩阵新增 f2 用例(有效校验和+dump 尾部注入非法 SQL ⇒ exit≠0+「已清理本次恢复库」+ relay_restore_v* 计数失败前后相等)。修复后定向复跑 33/33(d09 E2E 5+单测 15+08 套件 13)+quality:quick PASS+tsc 干净+零容器残留。
- **Round2(16:12~16:22)**:Reviewer 亲读修复 diff、**独立重放 Major-1 失败路径**(自建容器+注入非法 SQL:exit=3+「已清理本次恢复库 relay_restore_v1794730667_14496」+ relay_restore_v* 计数失败前=后——Round1 同实验残留 1 库,Major-1 关闭)、亲跑 20/20(含 f2)、M1 实证(`?sslmode=disable` URL 备份 exit=0,Round1 该形态必败)/M2 负例正例(带库名段 exit=2;合法 base 全链 PASS,尾斜杠无误伤)/M3 对应核实、边界复核零违规。终裁 **PASS(0 Major)**。原文入库=REVIEW-RELAY-BACKUP-INTEGRITY-09.md(两轮全记录)。

## 6. 提交、CI 与收口

- 提交链:a458e95(合同登记)→ **0eb4b7b**(实施,main-only fast-forward,推送经 ssh.github.com:443 直连亲测)→ **9b8555f**(CI 教训修正,纯测试面)→ 〔收口提交〕。
- exact-head CI 时序如实:
  - run **43694046569@0eb4b7b** test job **failure**(e2e job success):唯一红=d09 fail-closed 矩阵「错容器」用例(0eb4b7b 测试文件 :398)——**ubuntu runner 宿主自带 pg_dump/psql ⇒ backup.sh 走宿主分支,`RELAY_PG_CONTAINER` 不参与执行**,拒绝预期在该环境不成立;其余 444/445 全绿(含 09 全部套件)。
  - 修正(9b8555f,纯测试面/deploy 脚本零改动):该用例分支自适应——宿主有 pg_dump ⇒ PATH 注入 pg_dump 失败 shim(dump 执行面异常,可验证注入);宿主无(VM80)⇒ docker fallback 错容器真失败。两环境合计覆盖两分支失败面。
  - run **43694571961@9b8555f**(3m27s)双 job success:test job(job 132752155346,quality:full,**09 套件 CI 上真跑逐字实证**=d09-backup-chain 15/15 + d09-backup-integrity 5/5[13.7s,**ubuntu runner 上经宿主 pg_dump/psql 真实执行 backup.sh 宿主分支全链**]+deploy-rehearsal 9/9+deploy-rehearsal-e2e 1/1+evidence-gate 3/3;全量 **445 passed | 54 skipped[86 文件]**)+ e2e job(job 132752155125,browser journeys 1m52s)。annotations 仅 Node.js 20 弃用/runner 镜像迁移公告,非失败。证据=evidence/ci-testjob-9b8555f-excerpt.log+ci-checkruns-9b8555f.json(随收口提交入库);收口提交自身回执留未跟踪(08 同例)。
- CI 核验通道=gh CLI(VM80 代理栈,直连 443 为已登记 Sectigo 假证书劣化路径不可用于核验)。quality:full 本地 NOT_RUN(防 VM80 egress 共享栈互踩既定纪律)由 CI test job 双绿覆盖。
- **宿主/docker 两分支覆盖总结**:VM80(无宿主工具)=docker fallback 真跑全链;CI runner(自带 pg_dump/psql)=宿主分支真跑全链(d09 E2E 13.7s)+宿主分支失败面(shim)。合同 D「host 与 docker fallback 都需覆盖」以两环境合计成立。

## 7. 生产影响、回滚与边界

- **生产影响=零**:备份/恢复脚本属部署工具面,本包零生产连接/写入(validate 仅 information_schema 元数据;全部真实读写=一次性容器+合成数据);零服务重启(生产 PID 3242781/3242782 未变,2026-11-13 启动);零宿主防火墙/TLS/公网/egress iptables 改动;零真实模型调用;relay-p000-pg 共享实例零 exec(红态受保护 shim 拦截实证+绿态全链不走该容器)。
- **生产预检仍 NO-GO**(迁移缺 0008/0009、Gate 检查未配置、旧进程、egress 栈缺席);**09 PASS 不自动授权 D3,生产切换仍须用户单独 D3**;D3-DECISION-PACK 顶部限制注记保持,收口时补记 09 结果行。
- 回滚:单提交 revert 即回到 a458e95 工具语义(纯部署工具+测试面,无数据/状态残留)。
- 后续登记(非本包范围):备份产物加密/异地容灾、恢复演练常态化调度、备份目录权限收紧(现沿用调用者 umask)。

## 8. NOT_RUN/未验证(如实)

- quality:full / quality:release 本地未跑(防 VM80 egress 共享栈互踩既定纪律)——由隔离 CI exact-head 双 job 覆盖;quality:release 的 backup-restore 步骤语义未变。
- 未在真实生产 env 执行 backup.sh(合同硬禁令;生产链路行为由合成双租户一次性实例全链真跑承担,拓扑差异[relay_console 与测试同实例]已在红态如实建模)。
- 宿主分支未在具备真实 pg_dump/psql 的宿主上完整真跑(VM80 宿主无二进制)——以可验证命令注入(argv 捕获)+真实脚本执行承担命令形态;dump 内容真跑由 docker fallback 承担;具备宿主工具的环境(CI runner)上 CI test job 将走真实宿主分支。
- 恢复库保留策略/备份产物生命周期管理(旧版语义保持:演练库留供人工核对、Runbook 可删);备份加密/异地容灾未在合同范围。
