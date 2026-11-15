# REVIEW-RELAY-BACKUP-INTEGRITY-09(独立 Reviewer 复核原文)

- **Reviewer**:RELAY-BACKUP-INTEGRITY-09 独立 Reviewer(隔离上下文,VM80 /home/ubuntu/dev/relay)。
- **复核时点**:2026-11-15 16:04~16:25(复核先于实施提交;实施者未提交,实施基线=工作区 HEAD=a458e95+未提交实施改动。提交将原样包含被复核的工作区状态,该时序如实登记)。
- **裁决依据**:仅本 Reviewer 亲自执行的命令与其原始输出;不采信实施者自述(实施者 REPORT/红态日志仅作导航与对照)。
- **复核产物**:仅本文件;/tmp/review09 临时目录(用后自清理);自建一次性容器 relay-test-d09-rev-s/rst/x-c235c0(已全部销毁)。

## 一、复核范围

对 CURRENT.md 顶部 RELAY-BACKUP-INTEGRITY-09 🔵 ACTIVE 合同(登记提交 a458e95;最低祖先 c22d23f)的 A~E 五项实施声明逐项独立复核:冷启动核对、红态真实性、源码逐行审、亲跑全部指定测试、fail-closed 抽查、独立端到端全链、边界复核、反例闭环判定。

## 二、逐项亲证记录(命令+关键输出摘录)

### 1. 冷启动核对 — 通过

- `git rev-parse HEAD` = `a458e959e386c47ee8c8526e825c17f9c0d46b99`(=合同登记 a458e95);分支=main。
- `git status --porcelain`:6 修改(deploy/README-deploy.md、backup-manifest.mjs、backup.sh、restore-verify-check.mjs、restore-verify.sh、test/integration/deploy-rehearsal-e2e.test.ts)+ 4 新增未跟踪(deploy/backup-validate.mjs、backup-validate.d.mts、test/integration/d09-backup-integrity.test.ts、test/unit/d09-backup-chain.test.ts)+ 未跟踪目录(config/、p0-mvp/backup-integrity-09/、p0-mvp/soak-r3b/、三个 ci-checkruns-*.json)——与实施声明及合同保护清单逐字一致。复核结束时复跑 git status:改动集与冷启动完全一致(本 Reviewer 零跟踪文件改动,零 reset/commit/push)。
- `git diff --stat` = 6 files changed, 323 insertions(+), 80 deletions(-),与 REPORT §3 声明一致。

### 2. 红态真实性 — 通过(自证)

- 自行 `git show a458e95:deploy/{backup.sh,backup-manifest.mjs,restore-verify.sh,restore-verify-check.mjs}` 提取到 /tmp/review09/orig,md5:
  - backup.sh = `5ae07ed6ecb1f67bcbe9cb90f8783e8b`(红态日志引用 5ae07ed6 ✓)
  - restore-verify.sh = `23d89bf536ff873b5f6cf924aef53111`(日志引用 23d89bf5 ✓)
  - restore-verify-check.mjs = `cfacfcf3b4b486ecc84b86b27ff47c22`(Red-d 引用 ✓)
  - backup-manifest.mjs = `5207c1e17f2f2ff5b2cd6dd9582bac07`
  - 与实施者残留的 /tmp/red09/orig/* 逐字一致(md5 相同)。
- 原始脚本逐行核对红态缺陷形态,全部吻合:
  - backup.sh 步骤1 宿主分支 `pg_dump "$DB_URL" --no-owner --no-privileges --file`(无 -n)= Red-b 捕获 argv 逐字同形;
  - 步骤3 宿主分支 `psql "$DB_URL" -tA -c "SELECT … FROM audit_events ORDER BY seq"`(未限定)= Red-b ✓;docker 回退分支 `docker exec relay-p000-pg psql -U postgres -d relayp000 … FROM audit_events`(硬编码容器/库/未限定)= Red-a INTERCEPTED argv 逐字一致;
  - 步骤2 内嵌 `/home/ubuntu/dev/relay/deploy/backup-manifest.mjs`(D6)✓;
  - backup-manifest.mjs 枚举全库 `information_schema.tables WHERE table_name='candidate_changesets'` 跨 schema 聚合(D3)✓;
  - restore-verify-check.mjs 仅 `count(*)` 计数比对+审计仅打印不判(D4/D10)✓;
  - restore-verify.sh 无任何隔离声明语义、`RESTORE_TARGET_URL="${RESTORE_URL%/*}/$TARGET_DB"` 要求含库段而 psql 分支 `"$RESTORE_URL/postgres"` 要求 base(D9 互斥)✓、`head -1` 取最旧产物(D5)✓、校验和在恢复后(D11)✓。
- 受保护 shim(/tmp/red09/shim-docker/docker)亲读:仅当 argv 含 `relay-p000-pg` 时记录原文并 **exit 0 不执行**,其余 `exec /usr/bin/docker` 真实转发——Red-a「docker fallback 真跑+拦截 relay-p000-pg」边界声明属实,零真实共享实例数据读取。

### 3. 源码逐行审 — 通过(合同 C 逐条),含 1 项实质发现(见发现清单 Major-1)

- **deploy/backup-validate.mjs(新,78 行)**:fail-closed 单一入口。未声明/库名缺失/非法标识符(schema!=="all" 时白名单 `^[A-Za-z_][A-Za-z0-9_]*$`)/schema 不存在/缺 candidate_changesets 或 audit_events/连接失败 ⇒ 全部返回拒绝或 exit 2;仅读 information_schema 元数据(单条参数化查询);消息全部经 redactDbUrl(密码→`***`)。动态抽查中实测消息形态:`连接目标=postgresql://postgres:***@127.0.0.1:32812/relayd08`——脱敏属实。
- **deploy/backup.sh(重写)**:步骤0=`RELAY_BACKUP_SCHEMA:?` 必填+URL 形态/库名检查+白名单+`node "$SCRIPT_DIR/backup-validate.mjs"`(位于 mkdir 与任何连接之前,校验先于 mkdir 实测成立);步骤1=两分支均 `pg_dump -n "$BACKUP_SCHEMA"`(宿主 `pg_dump "$DB_URL" -n … --file`,docker `docker exec "$CONT" pg_dump … -n "$BACKUP_SCHEMA" "$DB_NAME"`),`all`=显式整库不静默;步骤2=SCRIPT_DIR 相对定位(D6 修复);步骤3=`run_psql` helper 两分支同源(容器=`RELAY_PG_CONTAINER` 默认 relay-p000-pg、库名=`${DB_URL##*/}`,F-1 硬编码矛盾消除),schema 模式 `FROM "$BACKUP_SCHEMA".audit_events` 限定,all 模式按 audit_events 存在性枚举+白名单守卫+空集拒绝;步骤4=原子完成标记 `backup-$STAMP.done`(先于校验和、随 `*"$STAMP"*` 一并受核)+trap 清理本 STAMP 产物(不掩盖退出码,rm 限本 STAMP 文件)。静态断言亲证:`FROM audit_events` 未限定形态在脚本可执行行中已不存在。
- **deploy/backup-manifest.mjs**:未声明 `RELAY_BACKUP_SCHEMA` ⇒ exit 2 先于任何连接(实测);schema 模式参数化存在性+归属校验(`schema_name=$1`)后仅查目标 schema;`all`=显式枚举;manifest v2 记录 `targetSchema`+generatedAt;delivered 行形状不变(08 E2E 兼容,13/13 回归绿为证)。
- **deploy/restore-verify-check.mjs**:用法=`<manifest> <audit-index.txt>`(旧第二参数=manifest 自身的形态废除);manifest 缺 `targetSchema`/非法 ⇒ 拒绝;DELIVERED 集合身份=稳定键 `[schema,changesetId,taskId,commit,remoteHead]` 排序集合相等(相同计数不构成通过);审计索引集合=`seq|ts|actor|action` 服务端拼接与 backup.sh 步骤3 同表达式,all 模式按 audit_events 存在性聚合与备份侧同源;拒绝时输出 ≤1 条差异样例;任何失败 exit 1。
- **deploy/restore-verify.sh**:守卫顺序亲核=RELAY_RESTORE_ISOLATED=1 必填 → 源/目标实例前缀相等拒绝 → RESTORE_URL scheme 检查 → 五项唯一性(备份目录 .done/db-*.sql/artifacts-manifest-*.json/audit-index-*.txt/checksums-*.sha256 各必须恰 1)→ manifest.targetSchema 提前校验+白名单 → **校验和先于任何 DROP/CREATE/连接** → 随机后缀恢复库 `relay_restore_v<epoch>_<RANDOM>` → check.mjs 身份核对 → 失败 trap 清理本库。D9 修复=`RESTORE_TARGET_URL="${RESTORE_URL%/}/$T_DB"` 统一 base 形态(与 psql 分支 `"$RESTORE_URL/postgres"` 一致;本 Reviewer 端到端用 base URL 全链走通,即 Red-e 中必坏的确切形态)。**发现**:失败清理判据 `CREATED=1` 在恢复完成后才置位——psql -f 中途失败路径下已建库不被清理(见发现清单 Major-1,已亲测实证)。
- **test/integration/deploy-rehearsal-e2e.test.ts(08 E2E 迁移)**:manifest 调用加 `RELAY_BACKUP_SCHEMA: schemaName`+断言 `manifest.targetSchema`;审计索引升级 `seq|ts|actor|action` 限定形态并落盘 audit-index-e2e.txt;check.mjs 第二参数改传审计索引;迁移/回退/其余断言逐字未动(合同 C「历史调用者经现有测试证明可安全迁移」成立,亲跑 13/13)。
- **deploy/README-deploy.md §3**:RELAY_BACKUP_SCHEMA 必填/RELAY_RESTORE_ISOLATED=1 必填/base URL 形态/F-1 从「登记」改「已修复」+红态证据指引——与实现一致。
- **新测试面**:test/unit/d09-backup-chain.test.ts(155 行 15 测试:静态契约 7+validate 纯逻辑 2+manifest/check 静态 4+动态 fail-closed 2)与 test/integration/d09-backup-integrity.test.ts(652 行 5 测试:主链/扰动不变性/fail-closed 矩阵 9 例/宿主分支 PATH shim/all 模式兼容),容器名 relay-test-d09-src/rst-*(独立命名,不触碰他容器),就绪门=SELECT 1 重试 90s,afterAll destroyEphemeralPg+safeRm。
- **日志脱敏核对**:backup-validate 消息用 redactDbUrl;backup.sh/restore-verify.sh 错误消息不含凭据;红态日志 argv 中密码以 `***` 呈现(Red-b)。未发现原始 audit 行/凭据写入 evidence(Red 日志中的行均为合成数据标记)。

### 4. 亲跑测试(全部本 Reviewer 在 /tmp/review09 记录原始输出)

| 命令 | 结果 |
| --- | --- |
| `npx vitest run test/unit/d09-backup-chain.test.ts --reporter=dot` | **15 passed (15)**,490ms |
| `npx vitest run test/integration/d09-backup-integrity.test.ts --reporter=dot` | **5 passed (5)**,11.51s(真实一次性容器;fail-closed 矩阵 9 类拒绝消息全部亲见:未声明 schema/目标不存在/错容器 trap 清理/未声明隔离/恢复=源实例/完成标记/集合身份不一致/审计集合不一致/legacy manifest) |
| 结束后 `docker ps -a` 过滤 relay-test-d09-* | **0 残留** |
| `npx vitest run test/integration/deploy-rehearsal-e2e.test.ts test/integration/deploy-rehearsal.test.ts test/integration/evidence-gate-rehearsal.test.ts --reporter=dot` | **3 files / 13 passed (13)**,11.50s |
| `RELAY_BACKUP_E2E=1 npx vitest run test/integration/backup-restore.test.ts --reporter=dot` | **1 passed (1)**,7.09s |
| `npm run quality:quick` | **quick 总裁决: PASS**(20 files / 155 unit 全绿+lint/format/typecheck) |
| `npx tsc --noEmit` | **exit=0 干净** |

### 5. fail-closed 抽查(不依赖 vitest,真实脚本+不可达 URL)— 全部拒绝

- FC-1a `env -u RELAY_BACKUP_SCHEMA RELAY_DB_URL=postgresql://postgres:x@127.0.0.1:1/none node deploy/backup-manifest.mjs <tmpout> <tmpjson>` → **exit=2**,消息「未声明 RELAY_BACKUP_SCHEMA(…);拒绝生成 manifest(拒绝静默跨 schema 聚合)」,目录 **0 文件**。
- FC-1b 同上+`RELAY_BACKUP_SCHEMA=p01a_nonexistent` → **exit=2**,消息含 schema 名与「manifest 目标校验失败(…未生成任何产物)」,目录 **0 文件**。
- FC-2a `env -u RELAY_DB_URL -u RELAY_BACKUP_SCHEMA bash deploy/backup.sh <tmpout>` → **exit=1**(`:?` 拒绝),目录 **0 文件**(校验先于 mkdir 实证)。
- FC-2b `RELAY_DB_URL=postgresql://postgres:x@127.0.0.1:1/none RELAY_BACKUP_SCHEMA=p01a_rev09_probe bash deploy/backup.sh <tmpout>` → **exit=2**,消息「目标校验连接失败(未生成任何产物)…(postgresql://postgres:***@127.0.0.1:1/none)」(脱敏实证),目录 **0 文件**。
- FC-3 `env -u RELAY_RESTORE_ISOLATED -u RELAY_DB_URL bash deploy/restore-verify.sh <dir> "postgresql://postgres:x@127.0.0.1:1"` → **exit=2**,「未显式声明 RELAY_RESTORE_ISOLATED=1(…)」(守卫先于任何 DROP/CREATE/连接)。
- FC-4 `RELAY_RESTORE_ISOLATED=1 RELAY_DB_URL=postgresql://postgres:x@127.0.0.1:1/none bash deploy/restore-verify.sh <dir> "postgresql://postgres:x@127.0.0.1:1"` → **exit=2**,「恢复目标实例与备份源实例相同(RESTORE_URL 是 RELAY_DB_URL 的实例前缀)」。
- FC-4b 尾斜杠变体(RESTORE_URL=`…:1/`)→ 同样 **exit=2** 前缀守卫拒绝。

### 6. 独立端到端全链(本 Reviewer 自建,零复用实施者产物)— 通过

- 自建两个一次性容器 `relay-test-d09-rev-s-c235c0`(源,127.0.0.1:32816)/`relay-test-d09-rev-r-c235c0`(恢复,127.0.0.1:32817),`docker run -p 127.0.0.1::5432`+`docker inspect` 校验:`{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"32816"}]}` / `…32817…`(回环绑定门亲证);SELECT 1 就绪门通过。
- 合成数据(独立 nonce=c235c0,仅触碰自建 schema):`p01a_rev09a_c235c0`(目标 A:DELIVERED=1[cs-rev-a1]+PENDING=1,audit=3)+ `p01a_rev09b_c235c0`(他租户 B:DELIVERED=1,audit=1)+ `public.audit_events` 干扰表(1 行 decoy)。
- **修后真实 backup.sh**(宿主无 pg_dump/psql ⇒ docker fallback 分支真跑):exit=0,dump 3466 字节;断言亲证:dump 含 `CREATE SCHEMA p01a_rev09a_c235c0`=1、含 B schema/REV_B_AUDIT/REV_DECOY/cs-rev-b1 均=0、含 REV_A_AUDIT=3;manifest targetSchema=A 且 delivered 恰 1 条(cs-rev-a1,含 taskId/commit/remoteHead;PENDING 不入);审计索引恰 3 行全 A、零 decoy;完成标记含 `backup-complete/schema=…`;sha256sum -c 全 OK。
- **修后真实 restore-verify.sh**(RELAY_RESTORE_ISOLATED=1,RESTORE_URL=恢复实例 base——即 Red-e 中必坏的 base 形态):exit=0,「集合身份一致 ✓」「审计索引:备份=3 行 恢复后=3 行」「核对通过」。
- **恢复库独立抽查**(直接 psql 恢复容器,不采信脚本输出):A schema 表=2、B schema 表=0、A audit=3、A DELIVERED=1、全库无 public.audit_events;DELIVERED 行身份(cs-rev-a1|aaaa…|remote-head-REV-A1)与 manifest 逐字相等;审计行与备份索引逐字相等;源实例 pg_database 无任何 relay_restore_v*(守卫未误伤)。
- 清理:两容器 `docker rm -f` 销毁,`docker ps -a` 过滤 relay-test-d09-/review09 = **0 残留**。

### 7. 边界复核 — 通过

- `systemctl --user show relay-web relay-worker -p MainPID`(只读)= **3242781 / 3242782**,复核前后两次一致,零启停/重启操作。
- `git status --porcelain` 复核前后逐字一致;HEAD 始终 a458e95;本 Reviewer 零 commit/push/reset/分支操作。
- 受保护未跟踪物(config/、p0-mvp/soak-r3b/、三个 ci-checkruns-*.json)mtime 复核前后 diff=空(原样未动)。
- docker ps -a:复核前预置容器中与本包前缀相关者=0(3 个匹配项属无关 newsreview 项目);复核全程我自建的 3 个容器(relay-test-d09-rev-s/rst/x-c235c0)全部销毁,最终 relay-test-d09-*/review09 残留=0。
- 本 Reviewer 零生产 schema 读写、零 relay-p000-pg exec、零网络核验、零模型调用、零宿主配置改动;未读取任何生产连接信息文件。

### 8. 反例闭环判定 — 五类反例全部闭环(红态实证 → 修后语义拒绝亲证)

| 合同 B 反例 | 红态证据 | 修后拒绝语义(本 Reviewer 亲证) |
| --- | --- | --- |
| 未限定审计索引错源到 public | Red-c(未限定 SQL 返回 public 干扰 2 行,目标 A 3 行零获取) | backup.sh 两分支 `FROM "$SCHEMA".audit_events`+check.mjs 审计集合身份;我的 E2E 审计索引=3 行全 A 零 decoy;单测静态断言 `not.toMatch(/FROM audit_events/)` |
| 整库 dump 混入他租户 | Red-a(87KB 全库含 A/B/C+public) | 两分支 `pg_dump -n`;我的 E2E dump 仅含 A schema,B/decoy 计数=0;扰动 B 用例 dump 逐字节不含 B 标记 |
| 跨 schema manifest 泄漏 | Red-a(manifest 3 条含他租户 2 条) | manifest 必显式 RELAY_BACKUP_SCHEMA+只查目标;我的 E2E delivered 恰 1 条全 A |
| 相同计数假阳性 | Red-d(删 A 加 B,3=3 仍「一致 ✓」exit 0) | check.mjs 稳定键集合身份;d09 矩阵 g 例(身份扰动总数相等)exit=1「集合身份不一致」亲见 |
| 恢复误指(无隔离守卫) | Red-e(RESTORE_URL=源实例 base,源实例上真实 DROP/CREATE+恢复,且 D9 致 exit=1) | RELAY_RESTORE_ISOLATED=1 必须+源/目标前缀守卫+五项唯一性+校验和先行;FC-3/FC-4/FC-4b+矩阵 d/e 例亲证拒绝 |
| D9(URL 形态互斥,base 下 check 必坏) | Red-e(getaddrinfo EAI_AGAIN) | 统一 base 形态+`${RESTORE_URL%/}/$T_DB`;我的 E2E 以 base URL 全链走通(该形态从必坏变必通) |

附:all 模式兼容语义(旧整库/跨 schema 能力显式保留)由 d09 E2E 第 5 例真实演示(整库恢复+聚合身份核对 PASS),符合合同 C「不得未审先删」。

## 三、发现清单

### Major(1 项)

- **Major-1:restore-verify.sh 恢复中途失败路径不清理已建恢复库——「失败 trap 清理本库」声明在该路径不成立,合同 D「pg_dump/psql/Node 任一步异常均拒绝且清理自己产物」未完全满足。**
  - 根因(源码行 47-72):`CREATED=1` 置于 psql -f 恢复**成功完成之后**;cleanup_db 仅当 `CREATED=1` 才 DROP。若校验和通过、`CREATE DATABASE $T_DB` 成功而 `psql … -f "$SQLFILE"` 中途失败(ON_ERROR_STOP),此时 CREATED=0,部分恢复库残留。
  - **亲测实证**(本 Reviewer 自建一次性容器 relay-test-d09-rev-x-c235c0,127.0.0.1:32818;备份副本中段注入 `SELECT * FROM nonexistent_table_rev09_probe` 并重算校验和使校验门通过):restore-verify.sh exit=3,p死 ERROR 后实例中残留 `relay_restore_v1794730208_28377`(恢复失败后 pg_database 列表亲录)。与「成功保留供人工核对」的成功产物形态同名同形,后续人工核对无法从实例侧区分成功/失败残留——正是本包要消除的「冒充」类风险形态(范围限于已守卫的隔离实例,不涉生产)。
  - 与声明的差距:REPORT §3.5「失败 trap 清理本库」与 test/integration/d09-backup-integrity.test.ts 头注「任一步异常均拒绝且清理自己产物」在 psql 恢复中途失败这一真实可达路径上不成立(d09 矩阵 9 例未覆盖该路径;g/h/i 例的 check.mjs 失败发生在 CREATED=1 之后故清理正常)。
  - 建议修复(一行级):`CREATE DATABASE $T_DB` 成功后立即置 `CREATED=1`(psql/docker 两分支同改),或以「库已创建」为清理判据;并在 d09 矩阵补 1 例中途失败清理断言。docker 分支 `docker exec … -d "$T_DB" … < "$SQLFILE"` 同路径同理。

### Minor(4 项)

- **Minor-1**:backup.sh `DB_NAME="${DB_URL##*/}"` 不剥离 query 段:RELAY_DB_URL 含 `?sslmode=…` 时 docker fallback 分支库名形如 `db?sslmode=…`,与 backup-validate.mjs 的 URL 解析(仅取 pathname)不一致;当前形态 fail-closed(pg_dump 对该库名报错→trap 清理零产物),不构成静默风险,属一致性/健壮性债。建议与 validate 的库名解析同源或显式拒绝含 `?` 的 URL。
- **Minor-2**:restore-verify.sh 对 RESTORE_URL 仅校验 scheme(postgresql://|postgres://),未显式拒绝带库名段的 URL;带库名形态会在 `psql "$RESTORE_URL/postgres"` 连接步报错(fail-closed,无静默路径),但报错形态不直观。建议守卫显式化(与 D9「统一 base 形态」语义一致)。
- **Minor-3**:test/unit/d09-backup-chain.test.ts:37 静态契约正则第二分支 `FROM '\|\| \$BACKUP_SCHEMA` 为死分支(实现为 `FROM \"$SCHEMA\".audit_events` 形态);断言有效,仅精度问题,建议删除死分支防误读。
- **Minor-4**:REPORT §4.3「fail-closed 矩阵(每例拒绝+自身产物清理)」中 9 例未覆盖 psql 恢复中途失败路径(关联 Major-1);Major-1 修复后建议补该例并同步修正 §3.5 措辞。

### 边界与硬禁令核对 — 零违规

零生产 relay_console/public schema 读写(我的全部真实读写=自建一次性容器合成数据);零 relay-p000-pg docker exec(红态由 shim 拦截实证,我的复核全程未 exec 该容器);零生产服务启停(systemctl 仅只读 show 两次);零 systemd/防火墙/TLS/egress/宿主网络改动;零真实模型调用;零 git commit/push/reset/新分支;零跟踪文件与受保护未跟踪物改动;生产连接信息文件未读取;网络核验未执行(本包无需网络)。

## 四、终裁决

**REWORK(1 Major,4 Minor)。**

- 合同 A(审计)与 B(反例先红)亲证通过:缺陷清单 D1-D12 与 D9 附带发现属实,红态 7 份证据对 a458e95 原始脚本真实成立(md5+逐行比对自证),五类混入/误指反例闭环。
- 合同 C(最小安全修复)语义面亲证通过:唯一入口/fail-closed/两分支同源/集合身份/守卫顺序/日志脱敏/兼容 all 模式/调用方迁移全部落实且与声明一致。
- 合同 D(实际 E2E)主体亲证通过:单测 15/15、d09 全链 5/5(真实一次性容器、零残留)、08 套件 13/13、backup-restore 1/1、quality:quick PASS、tsc 干净、fail-closed 抽查 7 例全拒、我的独立端到端全链(自建双容器+独立 nonce schema)保真零混入。**唯一例外=Major-1:restore-verify.sh 恢复中途失败清理缺口(合同 D「任一步异常…清理自己产物」未完全满足,已亲测实证)。**
- 合同 E(独立 Reviewer)本文件即为复核原文;CI 与收口由实施者后续步骤承担(实施者未提交,本复核先于提交,时序如实登记)。
- **REWORK 范围(有界)**:仅 Major-1 一项(一行级修复+1 例矩阵断言+REPORT §3.5 措辞同步);4 项 Minor 建议随轮消化(Minor-4)或登记后续候选(Minor-1/2/3)。修复后按既有证据形式复跑 d09 全链与该新增矩阵例即可申请 Round2;无需重开其余各项。

---

## 五、Round2 复核(2026-11-15 16:12~16:22;独立亲证,不采信实施者自述)

冷启动:HEAD 仍 = a458e95(实施者未提交);git status 改动集与 Round1 完全一致(6 修改+10 未跟踪项);`git diff --stat` 由 Round1 的 +323/-80 增至 **+331/-80**(6 修改文件),增量全部落在 restore-verify.sh(91→97)与 backup.sh(91→93),与本次修复声明一致。两测试文件为未跟踪新增,M3/M4 以工作区现状逐行亲读(见下)。

### R2.1 四处修复亲读 — 全部落实

1. **Major-1(deploy/restore-verify.sh)**:psql 与 docker 两分支的 `CREATE DATABASE $T_DB` 之后**立即** `CREATED=1 # 库已真实建立:此后任一步(导入/核对)失败都必须清理本库(Reviewer Round1 Major-1)`;原「恢复完成后的整体置位」已移除(当前文件 `fi` 后直接 `export RESTORE_TARGET_URL=…`,无独立 CREATED=1 行)。cleanup_db 语义不变(rc≠0 且 CREATED=1 ⇒ DROP+「已清理本次恢复库」,exit $rc 不掩盖退出码)。
2. **M1(deploy/backup.sh)**:`DB_NAME="${DB_URL##*/}"` 后新增 `DB_NAME="${DB_NAME%%\?*}"` + `DB_NAME="${DB_NAME%%#*}"`(剥 query/fragment,注释标注 Round1 M1),空库名检查后移顺序不变;校验入口/白名单/两分支 dump 逻辑不受影响。
3. **M2(deploy/restore-verify.sh)**:scheme case 后新增 base 形态强校验 `REST_TAIL="${RESTORE_URL#*://*/}"`;当模式命中且尾段非空 ⇒ refuse「检测到路径段=…」;无路径或仅尾随斜杠放行。
4. **M3(test/unit/d09-backup-chain.test.ts)**:审计索引断言死分支(`FROM '\|\| \$BACKUP_SCHEMA`)已移除,仅保留 `/FROM \\"?\$BACKUP_SCHEMA\\"?\.audit_events/`(与实现形态精确对应)。
5. **M4(test/integration/d09-backup-integrity.test.ts,矩阵 f2 例,行 437-472)**:构造「有效校验和+完成标记+manifest/审计索引齐备但 dump 尾部注入 `THIS IS NOT VALID SQL;`」的备份目录 → 断言 exit≠0、输出含「已清理本次恢复库」、rst 实例 relay_restore_v* 计数恢复前=恢复后(部分恢复库被 trap 真实清理)。

### R2.2 Major-1 失败路径独立重放 — 修复实证(残留 0)

自建一次性容器 `relay-test-d09-rev2-s/rst-f362c2`(127.0.0.1:32822/32823,inspect 回环门亲证)+ 合成 schema `p01a_rev09b_f362c2`(DELIVERED=1+audit=2):

- `RELAY_DB_URL=postgresql://…@127.0.0.1:32822/relaydrev?sslmode=disable`(URL 带 query 段,Round1 M1 旧形态必败)真实 backup.sh → **exit=0**、6 产物齐备、manifest 1 条/审计索引 2 行——**M1 同步实证**(DB_NAME 剥离后 docker fallback 库名正确)。
- dump 尾部注入非法 SQL+重算校验和(sha256sum -c 通过,校验门不拦)→ restore-verify.sh:**exit=3**、stderr「[restore] 失败(exit=3):已清理本次恢复库 relay_restore_v1794730667_14496」;实例 relay_restore_v* 计数**失败前=失败后=1**(唯一残留为此前合法演练成功库,失败库零残留)。**修复前(Round1)同实验残留 1 个部分恢复库,修复后零残留——Major-1 关闭。**

### R2.3 M2 两向亲证 — 无误伤

- 负例:`RESTORE_URL=postgresql://…:32823/relaydrev`(带库名段)→ **exit=2**「RESTORE_URL 须为 base 连接串(不带库名;检测到路径段=relaydrev)」。
- 正向:`postgresql://…:32823`(无路径)全链 restore-verify **PASS**(集合身份一致 ✓+审计 2=2+核对通过,exit=0)——合法 base 无误伤;尾斜杠形态由 REST_TAIL 放行(以不存在备份目录验证:拒绝发生在「完成标记数量≠1」而非形态守卫)。

### R2.4 受影响回归亲跑 — 全绿

- `npx vitest run test/integration/d09-backup-integrity.test.ts test/unit/d09-backup-chain.test.ts --reporter=dot` → **2 files / 20 passed (20)**,12.96s(含新 f2 例的矩阵用例 2926ms;verbose 复跑 5 例逐一亲见全 ✓)。结束 `docker ps -a` 过滤 relay-test-d09-*/review09 = **0 残留**。
- 实施者声明的 33/33(d09 集成+单测+08 三套件)与本 Reviewer Round2 亲跑的 20/20 子集一致;08 套件未受本次修复影响(Round1 已亲跑 13/13,本次修复未触及该面)。

### R2.5 Round2 边界复核 — 零违规

`systemctl --user show` 只读:PID 仍 3242781/3242782;HEAD 仍 a458e95;git status 与 Round1 逐项一致;本轮自建 2 容器全部销毁;零生产 schema 读写、零 relay-p000-pg exec、零启停、零跟踪文件/受保护未跟踪物改动;/tmp/review09 用后清理。

### R2.6 Round2 终裁决

**PASS(0 Major)。** Major-1 已修复并双路实证(独立重放实验+d09 矩阵 f2 例);M1/M2/M3/M4 全部落实且无新引入问题(M2 对合法 base 零误伤经全链 PASS 亲证)。Round1 全部其余亲证结论(红态真实性、合同 A/B/C/D 主体、反例闭环、边界零违规)在 Round2 复核中未受修复影响而维持。剩余登记项:Minor-1/2/3 已由本轮修复消化(不再登记后续候选);备份产物加密/异地容灾、恢复演练常态化调度、备份目录权限收紧仍为非本包后续候选(REPORT §7 既有登记)。本 PASS 仍仅为「09 工具备份/恢复链合成验收」,不构成任何生产 GO 提升;CI 与收口由实施者后续步骤承担。
