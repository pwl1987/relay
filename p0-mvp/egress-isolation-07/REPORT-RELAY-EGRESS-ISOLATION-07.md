# RELAY-EGRESS-ISOLATION-07 最终报告

裁决:**PASS**(独立 Reviewer 隔离上下文冷启动终裁:**0 Major,4 Minor[1/3 已消化,2/4 登记后续候选]**;自建 7 探针独立实证——created 态保护/引号分词/create 冲突不误杀/配置不符拒绝/混合注册表隔离/派生性质/作用域化 verify 全绿;冷启动挑战通过;硬禁令逐条核对表全过;原文=REVIEW-RELAY-EGRESS-ISOLATION-07.md)

日期:2026-11-14
合同:5cca5a8(CURRENT.md「RELAY-EGRESS-ISOLATION-07」ACTIVE;开工冷启动 live main=origin=本地 `5cca5a864c2ecfc62cb7d3fb8130118d4d3fe944`,合同提交 CI 43566954138 test/e2e 双 job success 亲测;最低祖先 531cf46 满足)

## 1. 基线与 Writer

- 快进同步:531cf46(06 收口)→ 5cca5a8(用户合同登记),`git merge --ff-only`;Writer=本窗口唯一,main-only;受保护未跟踪 `config/`、`p0-mvp/soak-r3b/` 全程零触碰。
- 合同 CI:43566954138@5cca5a8(test+e2e 双 job success,gh run view 亲测)。

## 2. A 项:冷启动只读归属盘点(威胁矩阵)

### 2.1 资源与调用面穷举

- **资源固定面(修复前)**:网络 `relay-egress-net`(env 可覆盖)/代理容器 `relay-egress-fwd`(**硬编码**)/iptables 链 `RELAY-EGRESS`(**硬编码**)/规则标记 `relay-p01c-egress`(**硬编码**)/端口 13425/13426(env 可覆盖)。`src/runtime/egress.ts` 全文核读。
- **生产调用面(ensureEgress,永不 teardown)**:`src/cli.ts:436`(docker 路径)、`src/server/api.ts:673`(REVIEW Major-1 接线)、`src/worker-entry.ts:135`(worker 首拍,FAIL-CLOSED IDLE 不领取)、`src/server/worker.ts:208`(egress_not_ready 门)、`src/runtime/runner.ts:226`+`reviewer.ts:92`+`discovery.ts:195`+`check-sandbox.ts:214`+`sandbox.ts:311`(verifyEgressRules fail-closed 检查)。
- **测试调用面(ensure+teardown)**:7 文件——egress-enforcement(**无模型门,CI 真跑**,quality:full 会创建/删除默认名栈)、egress-proxy(RELAY_EGRESS_E2E 门)、pi-e2e、live-worker-e2e(RELAY_A4_E2E)、gate-e2e(RELAY_GATE_E2E)、f1/f2(RELAY_F1/F2_E2E,均 **ensure 后不清理留栈**);另 worker-entry.test.ts 子进程经 `...process.env` 继承 RELAY_PI_BASE_URL ⇒ CI 上真实创建过默认名栈(CI 日志 `[relay-worker] egress ready(network=relay-egress-net)` 实证)。
- **容器加入面**:`sandbox.ts:269` 与 `check-sandbox.ts:169/228` 硬编码 `EGRESS_NETWORK` import 时常量。

### 2.2 VM80 只读归属实测(2026-11-14)

- 默认栈**当前缺席**:`relay-egress-net` not found / `RELAY-EGRESS` 链不存在 / INPUT 零 `relay-p01c-egress` 规则 / 13425/13426 零监听 / 无 `relay-egress-fwd` 容器——与 CURRENT.md「生产 NO-GO ④」一致。
- 生产服务未动:relay-web/relay-worker active(PID 3242781/3242782,2026-11-13 02:00:08 旧代码);测试 PG `relay-p000-pg` Up。
- **宿主确为共享 Docker 宿主**:php82-* / e2e-lab-site-1 / nr-* / htac-test 等第三方容器在跑 ⇒「同名第三方容器」威胁真实存在。

### 2.3 最小威胁矩阵(逐项 → 修复机制 → 证明)

| # | 威胁 | 修复机制 | 证明 |
|---|---|---|---|
| 1 | 进程并发 ensure(多入口/多进程) | 健康复用收敛(不 rm 不重建);create 冲突 ⇒ 有界重试归属核验后收敛复用;**created 态绝不 rm**(防误杀 in-flight 对手) | E2E ①(双子进程并发 ⇒ 恰一容器双方 ok);单元 U2 |
| 2 | 读模型请求期间 ensure | 健康且配置相同 ⇒ `reused:true` 零破坏性命令(不再每次 `docker rm -f`) | E2E ②;单元 U2;egress-enforcement 二次 ensure 复用断言 |
| 3 | 测试 teardown 拆生产栈 | teardown 授权=进程内创建注册表 ∪ owner 标签匹配;iptables 另需网络归属(netOwned)锚;零删除时逐项 skipped 带原因 | E2E ③(非持有者零删除栈完好);单元 U1/S5;egress-enforcement ④ 只清本作用域 |
| 4 | 同名第三方容器/网络 | 匿名(无 `relay.egress.owner` 标签)一律拒绝复用/覆盖/删除(fail-closed,零副作用) | 单元 S3(匿名容器拒绝且零删除);实现拒绝分支 reason=`fwd_container_unowned`/`egress_network_unowned` |
| 5 | 网络/链缺失或半残 | 缺失 ⇒ 幂等创建;**真死(exited/dead)**且本家族 ⇒ 有界恢复重建(`recovered:true`);**运行中但配置不符 ⇒ 拒绝不恢复**(fail-closed);created/running 未健康 ⇒ 有界等待后 fail-closed(不 rm in-flight) | E2E ④(docker stop ⇒ recovered 且健康);单元 S4;Reviewer P4(运行中配置不符拒绝亲测) |
| 6 | 重启后恢复 | 生产 worker 重启 ⇒ 新进程复用家族标签的健康同配置栈;网络/链/规则幂等就位 | E2E ②(父进程复用子进程栈 reused:true);live-worker-e2e 子进程 env 继承语义(单元 S6) |
| 7 | 权限/环境变量继承 | `RELAY_EGRESS_SCOPE_PREFIX`+`RELAY_EGRESS_FORWARD_PORT/COUNT_PORT`+`RELAY_EGRESS_OWNER` 显式继承 ⇒ 子进程/worker 与 harness 同一作用域;owner 不继承 ⇒ 非持有者(③ 的负向证明) | 单元 S6;E2E ①②(继承 owner 收敛)/③(不继承 owner 被拒) |
| 8 | 清理重复触发 | teardown 幂等不抛错;资源已不存在 ⇒ skipped「不存在」;报告如实 | 单元 S2(二次 teardown deleted=[] 不抛错);e2e 兜底清理日志 |

## 3. B 项:反例先红(命令注入/模拟执行器;零真实系统调用)

- **模拟执行器**:`test/unit/egress-isolation.test.ts` 内嵌有状态模拟(vi.mock `node:child_process`+`node:http`)——iptables 规则面(-S/-N/-F/-A/-I/-D/-X 精确语义)、docker 网络容器生命周期(--label/-e/-v 解析、name 冲突)、计数端点存活与容器 env 绑定;命令全量记录,断言基于记录命令面。**VM80 全程零真实 docker/iptables/HTTP 外联**。
- **红态(修复前 9/9 红,`evidence/red-phase-before-fix.log`)**:
  - U1:裸 `teardownEgress()`(本进程零创建零持有)发出破坏性命令 `[docker rm -f relay-egress-fwd, iptables -F RELAY-EGRESS, docker network rm relay-egress-net]` ⇒ 无所有权校验实证;
  - U2:健康且配置相同的同名代理仍被 `docker rm -f`+重建 ⇒ 在途请求可被切断实证;
  - U3:仅改 `RELAY_EGRESS_NETWORK=relay-test-x` ⇒ 仍触碰固定容器/链/标记/端口(14 条固定资源触碰命令)⇒ 半独立命名空间=假隔离实证;
  - S1-S6:新语义 spec(命名空间/归属/复用/恢复/env 继承)在旧代码上不可满足(导出缺失/行为不符)。
- **绿态(修复后 10/10,`evidence/green-phase-after-fix.log`)**:U1/U2/U3b/S1-S6 全绿;U3a 转为存证守卫(仅改网络名属 default 域配置面而非隔离机制,防回归)。

## 4. C 项:最小实现(src/runtime/egress.ts 及调用方)

- **EgressScope(唯一命名空间)**:`kind/prefix/network/fwdContainer/chain/ruleTag/forwardPort/countPort/owner`。default=生产名**不变**(relay-egress-net/relay-egress-fwd/RELAY-EGRESS/relay-p01c-egress/13425/13426);test=`createTestEgressScope(id)` 或 env `RELAY_EGRESS_SCOPE_PREFIX` 全派生(网络/容器/链/标记/端口确定性派生 20000..39999,链名 ≤28 字符;同 id 跨进程一致)。
- **归属**:owner token(env `RELAY_EGRESS_OWNER` 显式继承优先,否则进程级随机,惰性稳定);容器/网络创建打 `--label relay.egress.owner=<owner>`;iptables 注释携带 `<ruleTag> owner=<owner>`;进程内创建注册表(owned Set)。
- **ensureEgress 健康复用语义**:健康且配置相同(端口/env/挂载面)⇒ 复用 `reused:true`(零 rm/零重建 ⇒ 在途请求不中断;挂载只可保持/升级不得降级);匿名 ⇒ 拒绝(零副作用);真死(exited/dead)且本家族 ⇒ 有界恢复 `recovered:true`;**运行中但配置不符 ⇒ 拒绝不恢复**;created/running 未健康 ⇒ 有界等待后 fail-closed(**绝不 rm in-flight 对手**——create→start 间隙误杀教训,见 §6 迭代);他人持有一律拒绝。
- **iptables 幂等写**:规则已齐 ⇒ 不 -F 不重写(避免白名单空窗);链/jump/INPUT 按作用域。
- **teardownEgress(scope?)→TeardownReport**:容器/网络=注册表 ∪ owner 标签匹配;iptables(链/跳转/INPUT)以网络归属为锚(netOwned)+规则按 `<ruleTag> owner=` 精确匹配(引号感知分词——iptables -S 对含空格注释加引号重排,-D 精确匹配必需);重复触发/不存在 ⇒ skipped 如实;零删除时逐项带原因。
- **verifyEgressRules**:接受 `{chain,ruleTag,fwdContainer}` 三件套(与 ensure 状态对齐);5 处调用点(sandbox/reviewer/runner/discovery/check-sandbox)改传 `eg`。
- **容器加入面作用域化**:`sandbox.ts` buildDockerRunArgs 增 `egressNetwork`(launchPi 传 `eg.network`);`check-sandbox.ts` 两处改 `options.egress?.network`(缺省 env 解析兜底)。`readEgressRequestCount(timeoutMs, port?)`;`verifyEgressEffective` 用 `status.network`;`EgressStatus` 增 `chain/ruleTag/fwdContainer/countPort/owner/reused/recovered`。
- **生产调用方零改动**:cli/api/worker-entry 保持 `ensureEgress(baseUrl)` 默认解析(生产名/端口/安全边界不变);gated 测试经 env 继承获得隔离。
- **测试面全部作用域化**:7 个 egress 调用测试文件改 `createTestEgressScope`+显式 scope+作用域化断言;f1/f2 补退出后清理(此前 ensure 后留栈);worker-entry.test.ts 子进程 `RELAY_PI_BASE_URL=""` 跳过 egress 初始化(测试无需出口栈)。

## 5. D 项:回归验收证据

- **单元反例(红→绿)**:9 红 → 10/10 绿(见 §3)。
- **隔离 E2E(CI/本地专用环境;真 docker,零生产默认资源触碰)**:`test/integration/egress-isolation-e2e.test.ts` 六用例——①跨进程并发 ensure 收敛(双子进程 ⇒ 恰一容器双方 ok+归属标签核验);②父进程跨进程复用 reused:true+TCP 层真实探针(模型端口可达+外网阻断);③非持有者(知道作用域名、不同 owner、空注册表)teardown 零删除栈完好+默认域 teardown 零越界;④docker stop 半残 ⇒ recovered 重建且健康;⑤owner 匹配 teardown 全回收+iptables/docker 双面零残留;⑥生产默认资源 DELTA 不变(基线快照对照)。本地实跑 **6/6 绿×多次稳定复跑**(38+ 轮迭代记录,最终连续 14 轮绿;`evidence/targeted-scoped-final.log`);CI 隔离实跑=推送后 exact-head test job(egress-enforcement 同门已在 CI 真跑 docker+iptables 实证)。
- **定向**:egress-isolation(10)+egress-isolation-e2e(6)+egress-enforcement(4)+worker-entry+reviewer-readonly = **25/25 绿**(`evidence/targeted-scoped-final.log`)。
- **quality:quick PASS**(`evidence/quality-quick-20261114.log`;lint+format+typecheck+单测;quick 不含 integration,不触碰生产 egress 共享栈)。
- **quality:full/release 本地 NOT_RUN(合同硬边界)**:VM80 真实生产 egress 共享栈虽当前缺席且本包后测试面已隔离,但按合同 D 项"仅在归属保护被独立 Reviewer 认可后才可决定是否在 VM80 本地运行 full;否则本地 full/release=NOT_RUN、CI 隔离验证"——执行 NOT_RUN,交隔离 CI。
- **零残留复核**:每轮 E2E/enforcement 后只读复核——`relay-test-*` 容器/网络/iptables 规则计数 0;`relay-egress-net`/`relay-egress-fwd` 状态与基线一致(缺席)。

## 6. 实现迭代记录(竞态教训,如实)

并发收敛经历三轮实证修正:①网络 create 冲突收敛(对手刚建 ⇒ 归属核验后复用);②**`docker run -d` 的 create→start 间隙容器呈 `created` 态(running=false)**——对手将其误判"半残"而 rm ⇒ 互相误杀;引入**状态感知**(`.State.Status`):仅 `exited/dead` 算真死可恢复(且仅本家族),created/running 一律有界等待健康后复用、超时 fail-closed 不 rm;③iptables -S 对含空格注释加引号重排 ⇒ teardown 分词必须引号感知,否则 -D 精确匹配失败且链 -X busy。最终连续 14 轮 E2E 绿。

## 7. 独立 Reviewer(隔离上下文;原文入库=REVIEW-RELAY-EGRESS-ISOLATION-07.md)

- **终裁:PASS(0 Major,Minor-1~4 登记)**。冷启动挑战通过(仅凭 AGENTS→CURRENT→README 定位唯一 ACTIVE;§1-8 独立重建不依赖实现者记忆)。
- **自建 7 探针独立实证**(独立于仓库测试的模拟执行器,P1-P7):created 态 fail-closed 零 rm(竞态迭代②真实有效)/跨进程 owner teardown 引号语义精确删除(迭代③真实有效)/create 冲突不误杀对手/运行中配置不符拒绝(P4,引出 Minor-3)/混合注册表默认域零触碰/作用域派生性质/verifyEgressRules 缺省 fail-closed。
- **亲测复跑**:单元 10/10、隔离 E2E 6/6、egress-enforcement 4/4、worker-entry+reviewer-readonly 5/5;匿名拒绝判定基座(真实 docker 上缺失标签=空串而非 <no value>)亲测;零残留基线对照(测试前后 relay-test-* 0/默认资源缺席不变);systemctl 确认生产服务 PID/启动时间未变。
- **Minor-1~3**(P3/P2/P4 亲测):跨 owner create 冲突拒绝而非复用(保守面,登记重试候选)/owner 继承链残留(保守面,已文档化)/"配置不符⇒恢复"措辞与实现不符(已修正注释与 REPORT);**Minor-4**:同 ruleTag 跨 owner 串扰边界(记录性)。
- **未验证项(Reviewer 如实)**:exact-head CI(推送后);quality:full/release 本地(合同顺序门 NOT_RUN);真实模型 Run(门禁未开);标签防伪造(设计接受,非安全认证)。

## 8. 生产影响、回滚与边界

- **生产影响:零**。默认名/端口/安全边界不变;零生产写入/零重启/零模型调用/零迁移;egress.ts 修改只在调用时生效(生产 worker 旧进程未重启,行为不变);测试面全部作用域化(VM80 本轮只创建/删除过 `relay-test-*` 作用域资源,生产默认资源零触碰——基线对照+E2E ⑥ 断言)。
- 回滚:`git revert` 实施提交即还原(无迁移/schema 写入);测试文件随 revert 还原。
- 边界合规:main-only 单 Writer;禁强推;`config/`、`p0-mvp/soak-r3b/` 零触碰;零真实凭据读取/输出;零模型调用;零网络/TLS/公网改造;零 Core 生命周期/Gate/Policy 修改;零新 Daemon/DB/调度器;**未在 VM80 跑任何 full**;未把测试隔离成功当作生产可切换(生产 NO-GO 维持)。

## 9. 登记(后续候选,均不阻断、均未实施)

- 跨进程互斥锁(flock 级):当前语义为"健康复用收敛+状态感知 fail-closed",已证安全;若未来需要"create 全程串行化"可立 POC(合同:不能证明跨进程安全时应保守阻断——当前未假装全局锁)。
- 跨 owner 并发冷启动重试候选(Reviewer Minor-1):default 域 web+worker 同时冷启动的窄窗口下,后到方对健康同配置的跨 owner 容器 fail-closed 拒绝而非复用(保守面;worker egressInitDone 一次性不重试为既有行为)——如需消除可立"跨 owner 家族收敛"小包。
- owner 继承链残留语义文档化(Reviewer Minor-2):owner 继承的子进程 teardown 保留作用域链(非本进程注册)——已写入 egress.ts 头注释;如需"任意持有者全回收"可立 POC。
- 同 ruleTag 跨 owner 规则串扰边界(Reviewer Minor-4):仅对抗性共用同一 scope 前缀时可达;测试前缀唯一性使实际风险趋零,记录性登记。
- 旧格式规则清理器:升级期历史遗留的仅-tag 无-owner 注释规则(当前 VM80 为零)可加 Runbook 一次性清理命令。
- 端口派生冲突探测:hash 派生端口撞真实服务时 fail-fast 已够用;若 CI 大规模并发可考虑预探测。
- 既有登记不变(生产切换 D3/POC 池/PI_WEB_REFERENCE §8/各包 Minor)。

## 10. NOT_RUN/未验证(如实)

- quality:full/release 本地未跑(合同 D 项顺序门:Reviewer 认可前不在 VM80 本地跑 full;隔离 CI 为权威口径,推送后亲核 exact-head 双 job)。
- CI 隔离 E2E 实跑:本地已多次稳定绿;GitHub runner(ubuntu-latest,docker+sudo iptables 可用,egress-enforcement 历史实证)推送后经 exact-head CI 复核——**推送前未验证项**。
- 真实模型 Run/真实外部交付:严格 NOT_RUN(模型门禁未开;egress-proxy 等模型门测试仅 CI skip 路径覆盖)。
- `relay.egress.owner` 标签防伪造性:标签非安全认证(SECURITY_MODEL 已写明);对抗性同宿主 root 场景不在威胁模型内。
