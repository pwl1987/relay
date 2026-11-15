# RELAY-RESTORE-TARGET-09R 独立 Reviewer 复核记录

> Reviewer 为隔离上下文独立代理(冷启动,不信任执行方自述,逐项真跑)。首轮=安全核(合同 D 顺序门,先于终验);终轮=终裁。Minor 消化记录见各轮末尾执行方回复。

---

## 第一轮:安全核(2026-11-15;独立 Reviewer 冷启动)

**裁决:PASS(0 Major,5 Minor)。** 执行方全部实质主张经本人真跑独立复证;发现的问题均为报告/证据的簿记性瑕疵(可登记、收口时更正),无任何安全门缺陷。

前置状态核验:本地 HEAD=8368cb1(GitHub live main 后代;基座正确),`git status --porcelain` 全程 md5=7fcfb6e0… 未变(我只读工作区,所有实验在 /tmp/reviewer-09r 与自有一次性容器内完成)。原样脚本经 `git show 8368cb1:deploy/restore-verify.sh > /tmp/reviewer-09r/orig/restore-verify.sh` 提取,`sha256sum` 双向一致(f70e25e0…)。

### 一、逐项核验结果(全部真跑)

#### 1. 两个原绕过复现(8368cb1 原样脚本,封闭 PATH,假执行器仅记 argv 后 exit 79)——均红态成立

环境:`/tmp/reviewer-09r/bin-host`(含假 psql,无 docker)/`bin-docker`(含假 docker,无 psql),目录内仅 bash/node/ls/sha256sum 等真实工具符号链接——真实 psql/docker 物理不可达;合成备份目录五项唯一+sha256sum -c 全 OK。

- **case-A(宿主分支,同实例别名)**:`env -i PATH=bin-host RELAY_RESTORE_ISOLATED=1 RELAY_DB_URL='postgresql://demo@127.0.0.1:55433/relayp000' bash orig/restore-verify.sh bk-valid 'postgresql://demo@localhost:55433'` → **exit=79,零 fail-closed 输出**,假 psql 捕获 `psql <postgresql://demo@localhost:55433/postgres> <-c> <DROP DATABASE IF EXISTS relay_restore_v1794736694_10135> <-q>`。守卫失效、DROP argv 已发往 localhost:55433——与协调方 Major-R1 反例一同形态。
- **case-B(docker 分支,容器错位)**:同法,`RELAY_RESTORE_CONTAINER=relay-p000-pg`,RESTORE_URL=`postgresql://demo@invalid-host.invalid:55433` → **exit=79**,假 docker 捕获 `docker <exec> <relay-p000-pg> <psql> <-U> <postgres> <-c> <DROP DATABASE IF EXISTS relay_restore_v1794736702_14246> <-q>`。RESTORE_URL 被完全无视——与协调方反例二同形态。
- 运行后验证:`docker ps -a` 与运行前逐行 diff 零 relay 相关变化,relay-p000-pg 仍 Up 4 days,零真实 DB/容器触碰。

#### 2. 同形态对修后脚本(工作区 deploy/restore-verify.sh)——均零 DDL 拒绝

- **case-A 修后** → **exit=2**,`[restore-target] fail-closed:规范化实例键相同(源=loopback:55433;目标=loopback:55433)…(别名不构成隔离证明)` + `[restore] fail-closed:…零 DDL 拒绝`;假 psql 日志**不存在**(假执行器从未被调用),DROP/CREATE=0。消息证明拒绝发生在文本快速门(任何连接之前)。
- **case-B 修后** → **exit=2**,`fail-closed:docker inspect 恢复容器失败(relay-p000-pg):无法证明 RESTORE_URL 与实际执行容器的绑定;拒绝`;假 docker 日志仅一行 `<inspect> <relay-p000-pg>`,**exec=0,DROP/CREATE=0**。

#### 3. 套件真跑(VM80 宿主无 psql/pg_dump 已实测确认 ⇒ docker 分支)

`npx vitest run test/unit/d09r-restore-target.test.ts test/integration/d09r-restore-target-integration.test.ts test/integration/d09-backup-integrity.test.ts test/unit/d09-backup-chain.test.ts --reporter=dot` → **53/53**;逐文件单跑确认 **27/27 + 6/6 + 5/5 + 15/15**。套件输出中全部 fail-closed 消息与预期矩阵一致;套件后一次性容器(relay-test-d09r-*)零残留。合规边界:对 relay-p000-pg 仅 docker inspect 元数据(测试③在绑定门即拒,代码路径证明探针连接不会发生),零 exec、零 55433 连接;我的自有容器(rvw-d09r-pgA/B,127.0.0.1 随机端口 32871/32872)用后即毁,零残留。

#### 4. 代码级安全审读 + 新绕过形态实测(⑧)

- ① **探针仅元数据**:restore-target-verify.mjs 唯一一条 SQL=`SELECT pg_postmaster_start_time()::text, inet_server_port()::int, inet_server_addr()::text`;sh 2d exec 探针同为 start_time;零原始数据查询(单测静态契约亦钉死)。
- ② **零密码泄露**:消息一律经 `redactDbUrl`(password→`***`,不可解析→`(unparseable-db-url)`,实测输出 `postgresql://postgres:***@127.0.0.1:1/none`);sh 侧 refuse 消息不含 URL;验证通过路径上 node pg err.message 不含连接串。
- ③ **docker 绑定严格**:State.Running===true、5432/tcp 恰一条、HostIp 严格等于 127.0.0.1、HostPort 数字且==RESTORE_URL 端口、同名/同容器 ID 拒绝、2d exec 内 start_time 必须与 RESTORE_URL 探针一致——全部亲证(见 5/6)。
- ④ **身份门先于 DDL**:0/0a 文本门→1/2 完整性+校验和(零连接拒损坏输入)→2b 分支判定→2c 身份门→2d 执行面绑定→3 才 DROP/CREATE;静态契约断言+逐行读确认。
- ⑤ **失败清理**:trap 链(2b cleanup_tmp EXIT→3 被 cleanup_db 替换且内部调用 cleanup_tmp);CREATED=1 建库即置位;我在自有双容器上实测:核对失败(exit=1)→`已清理本次恢复库`+假 docker 捕获清理 DROP;09 的中途失败清理用例在 5/5 中仍绿(exit=3 已清理)。
- ⑥ **无第二恢复系统**:backup.sh/backup-validate/backup-manifest/restore-verify-check 零 diff(diff --stat 仅 3 文件);新工具为纯校验门。
- ⑦ **探针比较键=start_time+port,inet_server_addr 不参与相等判定**(仅日志):桩测试+**真实双实例实测**确认——同一实例(A)经 127.0.0.1 与 bridge IP 两路径探针返回同 start_time+同 port(5432) ⇒ 判「同一物理实例」拒绝(未因 addr 不同误判为不同实例);两个不同实例(不同 postmaster 时刻)正确放行。
- ⑧ **新绕过形态 11 项全部 fail-closed(exit=2,DDL=0)**:query 串/fragment/IPv6 括号/大写 LOCALHOST/端口越界 99999/http scheme/嵌入@/尾点 localhost./多宿主逗号/百分号编码 host/同 host 同 port 异 dbname。要点:(a) **libpq 与 node pg 解析器差分实证存在但不可利用**——`docker run --network none postgres:17-alpine psql 'postgresql://demo@127.0.0.1:59999@evil.invalid:5544/…'` 报 `invalid integer value "59999@evil.invalid:5544" for connection option "port"`,其余嵌入@形态报 `could not translate host name "127.0.0.1@evil.invalid"`:libpq 一律硬错误、绝不静默连源,而 node 侧探针失败即保守拒绝,两个方向均 fail-closed;(b) 多宿主逗号 URL 被 parseDbUrl 判 null 拒绝;(c) RESTORE_URL 结构上不允许带路径段,「同实例不同 dbname」在 bash 层即拒。
- **补充独立 E2E(执行方未动态覆盖的 2d 失配路径)**:自有一次性双容器+假 docker(真实 pg 探针、DDL 全拦截)——(a) exec 探针返回伪造 start_time → 身份门通过后仍被 2d 拒:`docker exec 实际容器身份与 RESTORE_URL 探针身份不一致…声明目标≠物理执行目标;拒绝`,exit=2,DDL=0;(b) exec 返回真实 B start_time → 2d 通过→全流程走通→check.mjs 真实核对失败→清理 DROP 全部被假 docker 拦截;两容器实测零真实 DDL(datname 列表为空)。
- **已知边界(登记,不构成绕过)**:inspect 解析不拒绝 5432/tcp 之外的额外发布端口(08R 同款 helper 会拒绝,此处为加固候选);bash 分支判定与 DDL 分支同判据,但 PATH/容器身份在 2d 与 DDL 之间存在对抗性 TOCTOU 窗口——属操作者信任模型内(能改运行中 PATH 的攻击者本可直接执行 DDL),非误配置可达形态。

#### 5. 边界核验

一次性容器零残留(套件容器与我自建的均已销毁);生产服务 MainPID=3242781/3242782 未变;受保护未跟踪物(config/、p0-mvp/soak-r3b/、四份 CI 回执 e28c386/27e9259/c22d23f/bacc849)size+mtime 前后一致、git status 未变;relay-p000-pg 仅元数据 inspect、零 exec 零连接。宿主唯一 docker ps 差异=proxy-agent-core 自愈重启(与本包无关的宿主代理栈)。

#### 6. 报告与证据抽验(数字逐一对照)

green09r-unit.log=27/27 ✓;green09r-integration-vm80.log=6/6 ✓(③ 55433≠rstPort 与证据一致);green09r-d09-regression.log=5/5 ✓(含中途失败清理 exit=3);green09r-08-regression.log=1/1 ✓;quality-quick-09r.log=182/182、21 文件、quick 总裁决 PASS、typecheck/lint/format 通过、d09-backup-chain 15/15 在列 ✓;red09r-r1~r4.log 与 harness 五脚本在库、内容与 §2 表逐条对应 ✓;单测构成 5+3+2+7+10=27 ✓;§5/§6 如实标注待回填 ✓;§7/§8 生产影响=零、NOT_RUN 如实 ✓。发现三处簿记性偏差(见 Minor)。

### 二、Major/Minor 清单

**Major:无。** 两原绕过在修后脚本全部零 DDL 拒绝(亲自复现+复放);三层证明(文本键折叠/inspect 执行面绑定+exec 真值比对/服务端双探针)均独立实证,包括执行方未动态覆盖的 2d 失配路径;新绕过形态 11 项+解析器差分全部 fail-closed;零生产触碰。

**Minor(M1~M5,可登记不阻断;建议收口时在 REPORT 中更正后入库):**
- **M1** REPORT §3 称 restore-verify.sh「(+61/-15)」;实际 `git diff --numstat`=**+54/-7**(--stat 的 61=总变更行,15=三文件总删除行,系误读拼接)。
- **M2** REPORT §4.2 ② 称「实测 32847≠32848」;证据日志实为 32857 vs 32856(临时端口誊写错误;③ 的 55433≠rstPort 无误)。
- **M3** REPORT §1.1 称「RELAY_DB_URL 缺失时旧脚本以 set -u 崩溃形态退出」——**实测不实**:原脚本 `[ -n "${RELAY_DB_URL:-}" ] && …` 短路,缺失时静默跳过守卫、照发 DROP argv(假 psql 捕获 exit=79,零 fail-closed)。实际旧行为比描述更危险;新门(RELAY_DB_URL 必填)与单测已覆盖该形态,判定不受影响,但该句须更正。
- **M4** 证据生成瑕疵:red09r-r2/r3/r4.log 头部「形态:」行被截断;green09r-red-replay-fixed.log 含 shell 报错残留(`replay1.log: No such file or directory`)与计数格式毛刺。判定内容(消息/exit)完整可读,不影响复核。
- **M5** 加固候选登记:readInspectMapping 未拒绝 5432/tcp 之外的额外发布端口(与 08R d08-ephemeral-pg.ts「其余端口键必须未发布」强度不一致,对本门目标绑定无影响);另登记 2d→DDL 对抗性 TOCTOU 窗口为已知信任模型边界。

### 三、第一轮最终裁决

**PASS(0 Major,5 Minor)。** 09R 恢复目标安全门满足合同「任何 DROP/CREATE/导入前以实际可信的源/目标实例身份及执行目标一致性证明隔离,host 与 docker 两路径均不依赖 RELAY_RESTORE_ISOLATED=1、不同 URL 文本或不同容器显示名,无从证明即保守拒绝零 DDL」的交付目标;host 分支由文本键+服务端真值双探针承担,docker 分支额外承担回环门+inspect 严格绑定+exec 物理执行目标比对。本裁决仅为 09R 恢复目标安全门 PASS,不构成生产部署/生产备份许可;生产预检仍 NO-GO,生产切换须用户单独 D3。Minor M1~M3 应在收口前于 REPORT 原文更正(M4 建议重生成,M5 登记),不阻断进入终验。

---

## 第二轮(终轮):完整包复核(2026-11-15;同一 Reviewer)

**终裁:PASS(维持首轮 PASS;Minor M1~M4 消化全部合格;0 Major,无新发现)。** 09R 恢复目标安全门完整包复核通过,可进入收口(CURRENT.md/CONTINUATION 更新、implementation commit/push、closeout-commit CI 双 job、释放 Writer)。

### 一、Minor 消化核验(逐项,全部亲自复验)

- **M1(§3 行数)合格**:REPORT §3 现记 `deploy/restore-verify.sh(+54/-7)`,与本人 `git diff --numstat` 实测 **54/7** 逐字一致;同句旧形态描述同步改为「替代旧静默跳过守卫形态」,与 M3 口径一致。
- **M2(§4.2 端口数)合格**:§4.2 ② 现记「实测 rst 发布 32856 vs RESTORE_URL 端口 32857,证据日志为准」——本人 grep `evidence/green09r-integration-vm80.log` 实证原文即 `端口(32857)与实际恢复容器发布端口(32856)不一致`;原始证据文件 mtime 17:47:53 未被篡改(修正发生在报告侧而非改证据,处理方式正确)。③ 55433≠rstPort 表述无误。
- **M3(§1.1 旧行为)合格**:§1.1 现明确「RELAY_DB_URL 缺失时旧脚本**静默跳过源守卫照发 DROP argv**(`${RELAY_DB_URL:-}` 短路避免 set -u 报错——Reviewer M3 与执行方各自独立实测:exit=79 假执行器捕获 DROP argv、零 fail-closed 输出;比崩溃更危险,新门已改为明确拒绝)」,与本人首轮实测结论完全一致;`test/unit/d09r-restore-target.test.ts` 第 484 行用例名已同步更正(含「旧脚本 [ -n 含 :-默认值 ] 短路静默跳过守卫照发 DROP argv——比崩溃更危险;Reviewer M3 独立实证」),本人在本轮重跑中该用例绿。
- **M4(证据重生成)合格**:red09r-r1~r4.log(mtime 18:13:59)头部「形态:」行完整(R1 别名/R2 relay-p000-pg/R3 端口缺省/R4 some-unrelated-container+127.0.0.1:59999)、新增「复跑:」行指向 harness 且与 `red09r-harness/*.sh`(mtime 17:29:09 未变)参数逐一吻合可复跑;`green09r-red-replay-fixed.log`(18:14:13)重生成后四形态全部 `exit=2;假执行器危险 argv 行数=0`,首轮的 shell 报错残留与格式毛刺已消除。harness 本体未改——重生成日志如实转述原红态,无伪造。
- **M5(登记)**:已在 REPORT §5 登记为两项加固候选(readInspectMapping 不拒绝 5432/tcp 外额外发布端口;2d→DDL 对抗性 TOCTOU 窗口),合同约束下不在本包实施(扩展克制),处理正确。
- **§5 回填**:首轮裁决(PASS 0 Major 5 Minor)与消化记录已入 REPORT;`REVIEW-RELAY-RESTORE-TARGET-09R.md`(18:14:58 入库)经抽查与本人首轮裁决原文逐段一致(含 case-A/B argv 观测、11 形态矩阵、2d 失配补充 E2E、M1~M5 原文与最终 PASS 段)。

### 二、套件重跑(消化未破坏)

`npx vitest run test/unit/d09r-restore-target.test.ts test/integration/d09r-restore-target-integration.test.ts test/integration/d09-backup-integrity.test.ts --reporter=dot` → **3 文件 38/38 通过(=27/27+6/6+5/5,18.9s)**,全部分支 fail-closed 消息正常;执行方新增终轮回归证据 `green09r-final-regression.log`(18:16,集成双套件 11/11)与实测一致。运行后一次性容器零残留。

### 三、终包一致性

- 工作区:HEAD 仍 8368cb1(基座未动);修改面仍为 3 文件(README-deploy.md +15/-8、restore-verify.sh +54/-7、d09-backup-integrity.test.ts +5/-0),新增未跟踪物仅 3 件=REVIEW 入库、green09r-final-regression.log、ci-checkruns-8368cb1.json;src/migrations/preflight 零 diff。
- 新出现的 `ci-checkruns-8368cb1.json` 本人**对 GitHub 独立核验**:`gh run view 43698228229` 实测 8368cb1 上 test(3m21s)+e2e(2m3s)双 success,与回执逐字一致。注意其口径:该 run 位于合同提交(不含未提交的 09R 实施),属**基线回执**;实施面的权威 CI 以收口提交的 exact-head run 为准(§6 仍如实待回填,时序正确)。
- 受保护未跟踪物(config/、p0-mvp/soak-r3b/、四份 CI 回执 e28c386/27e9259/c22d23f/bacc849)size+mtime 与首轮前后三次快照一致,零触碰。
- 生产服务 MainPID=3242781/3242782 未变;relay-p000-pg 仍 Up(全程仅 docker inspect 元数据读取,零 exec、零 55433 连接);一次性/评审容器零残留(本人本轮未新建容器)。
- REPORT §1~§8 与工作区实际逐项一致(§6 待回填、§5 回填如实;§5「M5 登记于 CURRENT.md 收口行」为收口前瞻表述——CURRENT.md 尚未改属预期,**收口时必须实际落实 M5 两项登记**,此为跟进义务而非缺陷)。

### 四、终轮裁决

**PASS。** 首轮 0 Major 的实质结论经终轮全套复验维持;M1~M4 消化全部合格(更正/重生成均有本人独立实测背书,无证据篡改);无新发现(两条观测:8368cb1 回执为基线口径、M5 收口登记待落实,均不构成缺陷)。09R 恢复目标安全门完整包复核通过——合同交付目标(任何 DDL 前以实际实例身份+执行目标一致性证明隔离,两路径不依赖声明变量/URL 文本/容器显示名,无从证明零 DDL 保守拒绝)已达成并钉死于测试。本裁决仅为 09R 安全门 PASS,**不构成生产部署/生产备份许可**;生产预检仍 NO-GO,生产切换须用户单独 D3 授权。
