# RELAY-DEPLOY-REHEARSAL-08R 报告(安全纠偏最小包)

- **合同**:CURRENT.md 顶部 RELAY-DEPLOY-REHEARSAL-08R 🔵 ACTIVE(协调方登记提交 395091f;合同文本以该提交为准)。
- **基线**:GitHub live main `27e9259` → 快进 `395091f`(08R 合同登记,唯一新提交,fast-forward 安全);本地 main==origin/main==live main,单 Writer,无分叉。
- **实施窗口**:2026-11-15 上午(本报告所述工作区状态=395091f 之上的未提交改动;提交后以 git 历史为准)。
- **范围**:仅修复 Major-S1——08 E2E 一次性 PG 容器 `docker run -P` 的宿主发布面缺陷。不改生产、不改 preflight/src/migrations、不扩大到 F-1。

## 1. A 项:冷启动与只读盘点

- 冷启动核验:AGENTS.md/CURRENT.md(08R ACTIVE 段)/docs/CONTINUATION.md 已读;协调方审计 `COORDINATOR-REVIEW-08-20261115.md` 已读。网络:HTTP 代理上游 503,改走 `ssh.github.com:443`(`GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand=none"`,CONTINUATION 既录经验)完成 fetch/push 通道验证;快进无冲突。
- 受保护未跟踪物四项确认原样未动:`config/`、`p0-mvp/soak-r3b/`、`p0-mvp/deploy-rehearsal-08/evidence/ci-checkruns-27e9259.json`、`p0-mvp/egress-isolation-07/evidence/ci-checkruns-e28c386.json`。
- **缺陷盘点(唯一)**:`test/integration/deploy-rehearsal-e2e.test.ts`(395091f L56-74)内联 `docker run -d --name relay-test-d08-* … -P postgres:17-alpine` + `docker port` 提取宿主端口。`-P`=publish-all:VM80 bridge `com.docker.network.bridge.host_binding_ipv4=0.0.0.0`(只读 docker network inspect 复核,同协调方),容器 5432 发布到宿主**全部接口**的随机端口;测试客户端连 127.0.0.1 不改变绑定面。E2E L72 注释原文自认"仅绑定 0.0.0.0 由 docker -P 默认"。
- **无其他同类缺陷**:全仓 grep `-P/publish-all/--network host` 实证——真实 docker run 仅此一处(scripts/test-db-up.sh 早已显式 `-p 127.0.0.1:55433:5432`,为良性范式;egress-isolation.test.ts 为模拟器;CI ci.yml `ports: 55433:5432` 是 GitHub Actions runner 本机 service container,既有全仓模式,不在本合同范围,如实登记不动)。VM80 上其他项目容器(如 newsreview-staging-e2e-web-1 的 0.0.0.0:18181)非本仓库所有,不触碰。
- E2E 其余发布面核查:除 `-P` 外无 `--network`/`--privileged`/host network/其他 publish 参数;异常清理已有(afterAll `rm -f`+safeRm),butAll 失败时 vitest 仍执行 afterAll,且新实现的拒绝路径在抛错前自销毁容器(纵深)。

## 2. B 项:反例先红(纯模拟/argv 捕获;零真实 docker,未复现漏洞)

测试先行:`test/unit/d08-ephemeral-pg.test.ts`(15 测试,零 docker 零 PG 零网络,可进 quality:quick)。

- **红态①**(`evidence/red-phase-08r-tool-missing.log`,vitest-exit=1):模块仅含从 395091f **逐字提取**的旧实参构造器(`buildEphemeralPgRunArgs`,行为零改动仅提取为可测 seam)。结果:2 失败=旧 argv 断言红(`-p` 不存在:`expected -1 to be greater than or equal to 0`);12 失败=parseLoopbackPortMapping/startEphemeralPg 不存在(工具缺失=旧代码中校验面不存在,即缺陷本体);1 过=旧参含容器名/镜像(提取保真对照)。
- **红态②**(`evidence/red-phase-08r-argv-p-capture.log`,vitest-exit=1):校验器/编排器就位后复跑,3 失败**全部源于旧 -P 实参**(suite1 argv×2+编排测试内嵌 `not.toContain("-P")` 断言),12 绿(fail-closed 校验面就位)。
- **负向矩阵**(合同 B 清单全覆盖):HostIp 缺失/空、0.0.0.0、`::`、`::1`、外部地址(10.30.5.80/192.0.2.1)、多条映射、其他端口任意 HostIp 绑定、5432 未发布(`{}`/`{"9999/tcp":null}`/`[]`)、HostPort 空/缺失/非数字/0/70000、inspect 失败/非 JSON/非对象(数组/字符串/null)——一律 fail-closed 拒绝。
- 门核(Round1):独立 Reviewer 做了红态真实性实验(临时把构造器改回旧 -P 形复跑→恰好同 3 失败/12 绿→逐字恢复),裁决 **GATE-PASS** 后方运行真实 E2E(合同 D 顺序)。Minor-M1(`"5432/tcp":[]` 空数组独立用例)已在实施窗口消化。

## 3. C 项:最小实现

改动面共 3 文件(+2 新文件,+1 处替换;src/、deploy/、preflight、迁移文件零 diff):

1. **`test/integration/d08-ephemeral-pg.ts`(新增,121 行)**:一次性 PG 启动/校验 seam。
   - `buildEphemeralPgRunArgs`:与 395091f 旧形**逐字段唯一差异 = `-P` → `["-p","127.0.0.1::5432"]`**(宿主 IP 钉死回环、宿主端口位留空 ⇒ Docker 分配随机宿主端口;实测见 §4 探针)。
   - `parseLoopbackPortMapping`:对 `docker inspect` NetworkSettings.Ports JSON 严格校验——恰好一条 `5432/tcp` 映射、HostIp 精确等于 `127.0.0.1`、HostPort 非空数字 1-65535、**其余端口键绑定必须 null/空(未发布)**;任一不满足 ⇒ 抛错(拒绝消息含实际值)。
   - `resolveLoopbackPortMapping`(inspect 失败亦 fail-closed)、`destroyEphemeralPg`(尽力销毁,不掩盖原错误)、`startEphemeralPg`(编排:run→inspect 校验;校验拒绝 ⇒ 销毁本容器[唯一 nonce 名]后抛错;run 本身失败如实抛出且不误删任何容器)。真实 runner=execFileSync docker,timeout 同旧实现。
2. **`test/integration/deploy-rehearsal-e2e.test.ts`(唯一替换处,+7/-19)**:旧内联 `docker run -P`+`docker port` 块(19 行)→ `startEphemeralPg({container,password})`(7 行);备份/迁移/恢复/回退断言、SELECT 1 就绪门(90s)、afterAll 清理逐字未动。
3. **`test/unit/d08-ephemeral-pg.test.ts`(新增)**:见 §2。

不引入通用迁移框架/调度器/网络管理器/守护进程;未改 mainUrl 连接口径以外的任何测试语义;**没有只改注释或 mainUrl**——启动实参与校验逻辑为真实变更,且由 argv 捕获测试与真实 inspect 校验双重钉死。

## 4. D 项:真实验证(红绿+真实 Docker 回环绑定+完整回归)

- **真实 Docker 回环差分探针**(`evidence/probe-08r-loopback-lan.log`,probe-exit=0):经**真实模块** `startEphemeralPg` 启动一次性容器:
  - 真实 `docker inspect` = `{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"32791"}]}`(随机宿主端口+仅回环);
  - PG `SELECT 1` 成功(90s 重试就绪门,与 E2E 同口径);
  - **差分 TCP 探针**:127.0.0.1:32791 可连(控制面);宿主全部 10 个非回环 IPv4(10.30.5.80+9 个 docker 网关 172.17-172.25.0.1)**逐一实测 ECONNREFUSED**——若绑定仍为 wildcard 0.0.0.0 这些连接会成功,差分即绑定面证明。单端口单 IP 本机探针,禁公网扫描合规。
  - destroyEphemeralPg 后 `relay-test-d08-*`=0(零残留)。
  - 如实登记:首版探针 SELECT 1 无重试撞 initdb 窗口("Connection terminated unexpectedly",08 CI 教训 §6⑥ 同款,探针工具缺陷非绑定缺陷),补 90s 重试后重跑;终版日志为重跑结果,脚本源码全文附日志尾。
- **定向终验**(`evidence/targeted-08r-final.log`,vitest-exit=0):**28/28 绿** = 08R 安全单测 15/15 + 迁移演练 `deploy-rehearsal.test.ts` 9/9 + **真实 Docker E2E `deploy-rehearsal-e2e.test.ts` 1/1**(beforeAll 经 startEphemeralPg 回环发布+inspect 校验,3.9s)+ Gate `evidence-gate-rehearsal.test.ts` 3/3。既有 08 语义全部保持。
- **quality:quick PASS**(`evidence/quality-quick-08r.log`:lint/format/typecheck/unit 全绿);tsc --noEmit 干净;biome 干净。
- 调用方回归:rehearse-migration 全仓调用方=两套件(均已绿)+README 文档引用;新 seam 调用方=E2E 与单测(已绿)。
- **边界核验**(`evidence/boundary-08r-check.log`):容器残留 0;testdb p01a_d08*/rev08* schema 0;生产服务 PID 3242781/3242782 未变(2026-11-13 02:00:08 启动,零重启);改动面=3 文件;本包全部真实连接=一次性容器+testdb p01a_*,**零生产 relay_console/public 连接与写入**;VM80 bridge host_binding_ipv4=0.0.0.0 复核(缺陷环境因素,未修改宿主配置——修复在应用层不依赖外圈 ACL)。
- quality:full 本地 NOT_RUN(VM80 全量测试防 egress 栈互踩既定纪律)→ 由 exact-head CI test job 双绿覆盖(见 §6)。

## 5. E 项:独立 Reviewer(隔离上下文;原文入库=REVIEW-RELAY-DEPLOY-REHEARSAL-08R.md)

- **Round1 前置门核**(合同 D 顺序:模拟红绿→Reviewer 核启动参数→真实 E2E):Reviewer 冷启动,亲验 argv 逐字段对照/复跑 15/15(PIPESTATUS 实捕)/红态真实性实验(改回旧形复现恰好 3 失败后逐字恢复)/fail-closed 矩阵完备/边界零触碰,Minor-M1 登记,裁决 **GATE-PASS**。
- **Round2 完整包复核**:Reviewer 亲跑复现四套件 **28/28**(含真实 Docker E2E)+ 自跑差分探针 **PASS**(独立随机端口 32794≠实施者 32791 ⇒ 随机+回环钉死可复现;10 非回环接口全 ECONNREFUSED;残留=0 二次复核)+ bridge host_binding_ipv4=0.0.0.0 亲证(缺陷对症)+ 边界/硬禁令逐条;M1 确认已消化;终裁 **PASS(0 Major;N1=探针脚本 /tmp 易失但源码全文内嵌日志、复现方法备注,非缺陷;N2=M1 已关闭)**。原文入库=REVIEW-RELAY-DEPLOY-REHEARSAL-08R.md。
- 时序注记:复核先于实施提交(REVIEW 文件记录该时序);提交将原样包含被复核的工作区状态。

## 6. 提交、CI 与收口

- 提交链:395091f(合同登记)→ **db5106727cf8abd2f30bc1cbfe1166ef672f606e**(实施,main-only fast-forward,无强推;推送经 ssh.github.com:443 直连亲测)→ cc8cab5(CI 阻塞期间状态如实登记)→ 〔收口提交〕。
- exact-head CI:**run 43666136828 @db51067(2026-11-15T02:05:48Z push 触发,3m16s)双 job success**——test job(quality:full:lint/format/typecheck/unit/pg/tests 19 passed;全量 70 passed|14 skipped,3m12s)+ e2e job(browser journeys 4 passed|2 skipped,2m0s)。**08R 四套件 CI 上真跑逐字实证**(evidence/ci-testjob-db51067-excerpt.log):d08-ephemeral-pg.test 15/15、deploy-rehearsal.test 9/9、**deploy-rehearsal-e2e.test 1/1(一次性容器 7.7s,回环发布+inspect 校验)**、evidence-gate-rehearsal.test 3/3。annotations 仅 Node.js 20 弃用/runner 镜像迁移公告,非失败。
- CI 证据回执:evidence/ci-checkruns-db51067.json(total_count=2,e2e+test 均 completed/success @db51067,随收口提交入库);收口提交自身的 CI 复核回执留未跟踪,08 同例。
- CI 核验时序如实登记:实施提交后 VM80 代理栈整体中断约 4 小时(210+ 次轮询;直连 443 为 CONTINUATION 已登记 Sectigo 假证书劣化路径,不可用于核验),期间以 cc8cab5 如实登记状态;代理恢复(2026-11-15 14:2x 实测 200)后即刻完成本节核验。

## 7. 生产影响、回滚与边界

- **生产影响=零**:本包零 src/deploy/preflight/migrations 改动;零生产连接/写入;零服务重启(PID 未变);零宿主防火墙/TLS/公网配置改动;零真实模型调用。
- **生产预检仍 NO-GO**(与 08 收口一致:迁移缺 0008/0009、Gate 检查未配置、旧进程、egress 栈缺席);生产切换须用户单独 D3 授权;本包不构成任何 GO 提升。D3-DECISION-PACK 顶部协调方限制注记(2026-11-15)保持原样。
- **F-1 保持登记未改**(backup.sh 审计索引硬编码 relay-p000-pg 且未按 schema 限定)——08R 合同明确不扩大修复,待验收后建议 09 包先补真实备份链路。
- 回滚:单提交 revert 即回到 395091f 状态(纯测试面改动,无数据/状态残留)。

## 8. NOT_RUN/未验证(如实)

- quality:full / quality:release 本地未跑(防 VM80 egress 共享栈互踩既定纪律)——由隔离 CI exact-head 双 job 覆盖。
- 未在 VM80 真实启动旧 `-P` 形容器复现暴露面(合同禁止;红态以纯模拟 argv 捕获承担,真实性由 Reviewer 改形实验独立证实)。
- 生产 relay_console 只读标记复核未重做(本包零生产连接路径,08 收口基线 0/0 不变;如需可由 preflight plan 只读随时复核)。
- LAN 探针覆盖本机全部非回环 IPv4 接口;未做跨主机远端探针(超出合同边界,且差分已在本机层面成立)。
