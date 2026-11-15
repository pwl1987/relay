# RELAY-RESTORE-TARGET-09R 执行报告(恢复目标真实身份校验)

> 合同:CURRENT.md「RELAY-RESTORE-TARGET-09R 🔵 ACTIVE」(登记于 8368cb1;最低祖先 bacc849)。
> 裁决起点:RELAY-BACKUP-INTEGRITY-09 被协调方独立审计判 **REWORK**(Major-R1 两项亲测反例,见 `COORDINATOR-REVIEW-09-20261115.md`)。本报告覆盖合同 A-E 全项;最终裁决以 §5 Reviewer 与 §6 CI 为准。

## 1. 现状审计(合同 A)

### 1.1 绕过根因(与协调方反例逐字对应)
- **文本别名绕过**:旧 `restore-verify.sh` 源/恢复隔离守卫仅做字符串前缀比较 `[[ "$RELAY_DB_URL" == "$RESTORE_URL"* ]]`。`127.0.0.1` 与 `localhost` 两个主机名可指向同一 PostgreSQL 实例,前缀比较不成立 ⇒ 守卫放行,DROP/CREATE 直达别名地址(= 源实例)。端口缺省(不写端口=5432)同形态。**别名/端口缺省在文本层不可判**,必须以服务端真值识别。
- **Docker 执行目标错位**:旧脚本 docker 回退分支完全忽略 RESTORE_URL 的 host/port,直接 `docker exec "$RELAY_RESTORE_CONTAINER" psql`;该环境变量指向源容器名(如 relay-p000-pg)或任意容器名即被盲信,声明目标与物理执行目标无任何一致性核对。
- **只声明不证明**:`RELAY_RESTORE_ISOLATED=1` 是唯一隔离凭据;RELAY_DB_URL 缺失时旧脚本**静默跳过源守卫照发 DROP argv**(旧守卫形如 `if [ -n "${RELAY_DB_URL:-}" ] && [[ … ]],`${RELAY_DB_URL:-}` 短路避免了 set -u 报错——Reviewer M3 与执行方各自独立实测:exit=79 假执行器捕获 DROP argv、零 fail-closed 输出;比崩溃更危险,新门已改为明确拒绝)。
- 其余资产(备份 schema 唯一入口/manifest targetSchema/审计索引集合核对/完成标记/校验和先行)经复核**保持有效,不推倒重做**(合同约束)。

### 1.2 修复架构(合同 C:物理执行目标绑定)
新增单一入口 `deploy/restore-target-verify.mjs`(`restore-verify.sh` 在**任何 DROP/CREATE/导入之前**调用),三层证明:
1. **文本层快速门**(零连接):连接串规范化(host 小写/IPv6 括号剥离/回环族 localhost|127.*|::1 折叠/默认端口 5432/剥 query·fragment·尾斜杠)后实例键相同 ⇒ 拒绝(同实例别名/端口缺省形态,即红态 R1/R3)。
2. **执行面绑定**(docker 回退分支):RESTORE_URL 必须回环;`docker inspect` 恢复容器严格校验(运行中 + 5432/tcp 恰一条映射 + HostIp=127.0.0.1 + HostPort==RESTORE_URL 端口)⇒ 声明目标与物理执行容器绑定(红态 R2/R4 形态在此拒绝);显式 RELAY_PG_CONTAINER(源容器)与恢复容器**同名/同容器 ID** ⇒ 拒绝(容器名欺骗);随后 `docker exec $RC psql` 内读取的 `pg_postmaster_start_time()` 必须与 RESTORE_URL 探针一致(防 inspect 谎报/漂移,双重绑定)。
3. **真值层双探针**(host/docker 两分支通用,pg 直连,零原始数据):对源 URL 与目标 URL 分别读 `pg_postmaster_start_time()` + `inet_server_port()`(+inet_server_addr 仅日志);任一失败 ⇒ 无法证明 ⇒ 保守拒绝;**身份相同 ⇒ 同一物理实例 ⇒ 拒绝**——任意别名(如 /etc/hosts 自定义名、DNS 别名、bridge IP 直连)在服务端真值识别,不依赖连接串文本。探针仅读服务端身份字段,零表数据查询(源码契约断言钉死)。

设计权衡(如实登记):①源实例身份探针要求 RELAY_DB_URL 可达(演练语义;灾备场景源实例已宕机时走人工流程另行留证);②同 postmaster 启动时刻+同端口的碰撞概率工程上可忽略(时刻为微秒级实例启动时间);③基于源实例备份克隆出的第二个实例属于不同进程,不在"源实例"定义内;④host 分支不读容器 env(无容器参与),docker 分支才启用 inspect 绑定——两分支的证明强度均不低于"声明=1"。

## 2. 红态复现(合同 B;零真实 DB/容器操作)

对 **8368cb1 原样脚本**(工作区干净态)以封闭 PATH 假执行器(fake psql / fake docker,仅记录 argv 后 exit 79)+ 合成有效备份目录(五项唯一+校验和通过)复现四类绕过;**危险 argv 均已发出即红态成立**(假执行器拦截,零真实执行):

| # | 形态 | 关键观测 | 证据 |
| --- | --- | --- | --- |
| R1 | 同实例别名(宿主分支):RELAY_DB_URL=`…@127.0.0.1:55433/relayp000`,RESTORE_URL=`…@localhost:55433` | 守卫未拦截;假 psql 捕获 `psql postgresql://demo@localhost:55433/postgres -c "DROP DATABASE IF EXISTS relay_restore_v…"`(与协调方 Major-R1 反例一逐字同形态) | `evidence/red09r-r1.log` |
| R2 | Docker 容器错位:RESTORE_URL 指向无效主机,RELAY_RESTORE_CONTAINER=relay-p000-pg | 守卫未拦截;假 docker 捕获 `docker exec relay-p000-pg psql -U postgres -c "DROP DATABASE IF EXISTS relay_restore_v…"`(与协调方反例二逐字同形态) | `evidence/red09r-r2.log` |
| R3 | 端口缺省别名:RESTORE_URL=`…@localhost`(默认 5432) | DROP argv 发往 `localhost/postgres` | `evidence/red09r-r3.log` |
| R4 | 任意容器名盲信:RELAY_RESTORE_CONTAINER=some-unrelated-container | RESTORE_URL 与实际执行容器无一致性核对,argv 照发 | `evidence/red09r-r4.log` |

驱动与合成备份构造器入库 `evidence/red09r-harness/`(封闭 PATH,真 docker/psql 不可达,可复跑复核)。

## 3. 最小修复(合同 C)

- **新增 `deploy/restore-target-verify.mjs`**(+`deploy/restore-target-verify.d.mts` 类型声明):§1.2 三层证明的单一入口;复用 `backup-validate.mjs` 的 `redactDbUrl`(消息零密码);仅读元数据;fail-closed exit 2。
- **`deploy/restore-verify.sh`**(+54/-7):`RELAY_DB_URL` 必填(无法提供源实例身份 ⇒ 明确拒绝,替代旧静默跳过守卫形态);保留 09 前缀层(0a);执行分支判定与临时目录(2b);身份门调用(2c,位于完整性/校验和之后——损坏输入零连接拒绝;**任何 DDL 之前**);docker 分支追加 exec 执行面绑定(2d);cleanup_db 一并清理临时目录(检查 docker inspect 材料不残留)。
- **调用方迁移**:`test/integration/d09-backup-integrity.test.ts` 六处 restore-verify.sh 调用补 `RELAY_DB_URL: srcUrl`(与 08 E2E 迁移同性质;08 E2E 仅调用 check.mjs,零迁移)。
- **文档**:`deploy/README-deploy.md` §3 恢复用法与身份门语义更新;不新增第二恢复系统;备份工具零改动。
- src/migrations/preflight 零 diff。

## 4. 验证(合同 B/D)

### 4.1 假命令负向矩阵(单测,零真实容器/PG)
`test/unit/d09r-restore-target.test.ts` **27/27**(`evidence/green09r-unit.log`):
- 静态契约 5 项:身份校验先于任何 DDL;RELAY_DB_URL 必填;docker 绑定材料/同名拒绝/exec 探针比对;身份工具零原始数据查询;trap 清理链。
- URL 规范化纯逻辑 3 项(R1/R3 形态在文本层即判同实例)。
- docker inspect 严格解析 2 项(合法形态 + 5 类拒绝)。
- verifyRestoreTarget pg 桩注入 7 项:快速门零连接拒绝/真值层同实例拒绝(任意别名)/源·目标身份不可证拒绝/不同实例正例/docker 非回环拒绝/发布端口不一致与同容器 ID 欺骗拒绝/入参缺失拒绝。
- 动态可控 PATH 矩阵 10 项(假执行器,危险调用计数=0):R1/R3/字面前缀/缺失 RELAY_DB_URL/源不可达/docker inspect 失败(R2)/发布端口不一致(R4)/非回环/容器名同名欺骗/缺完成标记(09 语义不退化)。

### 4.2 真实一次性双实例集成(VM80 docker 分支)
`test/integration/d09r-restore-target-integration.test.ts` **6/6**(`evidence/green09r-integration-vm80.log`;一次性双实例,127.0.0.1 随机发布 + inspect 验证,d08 helper 复用):
① 源实例 bridge IP 误指 ⇒ docker 分支在回环门拒绝(host 分支在 CI 走探针层真值拒绝,分支自适应);② RELAY_RESTORE_CONTAINER=源容器 ⇒ 发布端口不一致拒绝(实测 rst 发布 32856 vs RESTORE_URL 端口 32857,证据日志为准);③ **RELAY_RESTORE_CONTAINER=relay-p000-pg ⇒ 绑定门拒绝(实测 55433≠rstPort;对生产形态容器仅 docker inspect 元数据读取,零 exec、零 DB 连接)**;④ 容器名同名欺骗拒绝;⑤ RELAY_DB_URL 不可达(真 ECONNREFUSED)⇒ 保守拒绝且双实例零 DDL;⑥ bridge IP 正例在 docker 分支被回环门拒绝(host 分支 CI 承担探针层正例)。恢复库计数逐实例守恒断言全程在位。

### 4.3 红形态复放(修后)
四类红形态对修后脚本全部在 DDL 前拒绝、危险 argv=0(`evidence/green09r-red-replay-fixed.log`)。

### 4.4 回归(零退化)
- d09 集成 **5/5**(身份门接入后真实 docker 分支全链:真实 inspect 绑定+双侧探针+exec 交叉核对+备份→恢复→集合身份核对,`evidence/green09r-d09-regression.log`);
- 08 E2E **1/1** + 09 单测 **15/15** + d09r 单测 27/27 + quality:quick **PASS**(182/182,含新单测,`evidence/green09r-08-regression.log`/`quality-quick-09r.log`);
- tsc/biome 干净;08 E2E 调用面零迁移(仅 check.mjs)。

### 4.5 边界核验
生产服务 PID 3242781/3242782 未变;relay-p000-pg 零 exec/零 DB 连接(仅 docker inspect 元数据用于误指拒绝用例);一次性容器用后即毁(正常完成运行零残留;**如实登记**:一次 transform 失败的中间开发态运行残留 2 个一次性容器,已手动清理并复跑验证零残留);保护性未跟踪物(config/、soak-r3b/、四份 CI 回执)零触碰;零生产 schema/原始数据读写、零服务重启、零 egress/防火墙变更。

## 5. 独立 Reviewer(合同 E)

### 第一轮:安全核(合同 D 顺序门)——**PASS(0 Major,5 Minor)**
独立 Reviewer 隔离冷启动,全部实质主张亲自真跑复证(原文见 `REVIEW-RELAY-RESTORE-TARGET-09R.md`):
- 原样脚本(8368cb1 经 git show 提取,sha256 双向一致)两绕过独立复现:case-A 别名 DROP argv 发往 localhost:55433、case-B `docker exec relay-p000-pg … DROP argv`(与协调方反例同形态);修后同形态零 DDL 拒绝(exit=2,假执行器调用=0/仅 inspect);
- 套件真跑 53/53(27+6+5+15);对 relay-p000-pg 仅元数据 inspect、零 exec 零连接;自有一次性容器用后即毁;
- 代码审读 8 项全过(探针仅元数据/零密码/绑定严格/门先于 DDL/清理链/无第二系统/比较键正当性含真双实例 addr 不参与判定验证/11 项新绕过形态全部 fail-closed 含 libpq 与 node pg 解析器差分实证);**补充独立 E2E**:执行方未动态覆盖的 2d(exec 探针)失配路径由 Reviewer 自建双容器实证(伪造 start_time ⇒ 拒绝;真实 start_time ⇒ 放行);
- 边界核验:生产 PID 未变/保护物未动/容器零残留;报告数字逐一对照。
- **Minor 及消化(收口前已全部完成)**:M1 §3 行数更正(+54/-7,git diff --numstat);M2 §4.2 端口数以证据日志为准(32857 vs 32856);M3 §1.1 更正旧行为=RELAY_DB_URL 缺失时**静默跳过守卫照发 DROP**(`-n "${RELAY_DB_URL:-}"` 短路,Reviewer 与执行方各自独立实测,比崩溃更危险;单测名亦更正);M4 红态证据头部与复放日志重生成;M5 **登记加固候选**:①readInspectMapping 未拒绝 5432/tcp 外额外发布端口(08R 同款 helper 强度,不影响本门绑定正确性)、②2d→DDL 对抗性 TOCTOU 窗口(操作者信任模型内,非误配置可达形态)。二者登记于 CURRENT.md 收口行,不在本合同实施(扩展克制)。

## 6. CI 时序(待回填)

## 7. 生产影响与边界
生产影响=零(全部真实读写=一次性容器+合成数据;relay-p000-pg 仅元数据 inspect)。本合同结论仅为「09R 恢复目标安全门 PASS/REWORK」,**不构成生产部署/生产备份许可**;生产预检仍 NO-GO(迁移缺 0008/0009、Gate 未配置、旧进程、egress 栈缺席),生产切换须用户单独 D3 授权。

## 8. 如实 NOT_RUN
- quality:full 本地未跑(由隔离 CI test job 全量覆盖;07R 后 egress 测试面已作用域隔离,无生产栈风险,但保持合同 D 顺序与 09 同口径);
- 真实模型/外部交付:未授权,NOT_RUN;
- 真实生产备份/恢复演练:禁止(零生产触碰),待用户 D3 后按 Runbook §3 09R 语义执行。
