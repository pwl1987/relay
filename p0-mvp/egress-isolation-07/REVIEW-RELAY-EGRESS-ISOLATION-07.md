# REVIEW-RELAY-EGRESS-ISOLATION-07(独立 Reviewer 终裁)

> 本文件为独立 Reviewer(隔离上下文冷启动)终裁报告的**原文入库**;实现者未改写 Reviewer 原文,Minor 消化记录见文末附注。

- 裁决:**PASS**(0 Major,4 Minor 均登记不阻断)
- Reviewer:独立冷启动上下文,与实现者零共享记忆;全部关键结论均有本机亲测证据
- 日期:2026-11-14;合同:5cca5a8(亲验 `git rev-parse HEAD` = `5cca5a864c2ecfc62cb7d3fb8130118d4d3fe944`,origin/main 与 HEAD 一致,实现以未提交工作区存在,无 stash、无新提交)
- 复核范围:工作区 17 个修改文件 + 2 个新测试文件 + `p0-mvp/egress-isolation-07/`,与 REPORT §1 申报面逐一吻合,无超范围改动

## 0. 冷启动挑战结论

**通过**。仅凭 AGENTS.md → CURRENT.md(顶部 ACTIVE=本合同)→ README.md 定位唯一工作包;§1–§8 各项均从 live 代码与 VM80 只读观测独立重建,未依赖实现者记忆。REPORT 的威胁矩阵(§2.3)、三轮竞态迭代(§6)、红/绿态证据(§3)均可独立复现(见下)。

## 1. 逐项复核(E 合同 8 项)

### E1 命令执行边界 —— PASS

`src/runtime/egress.ts` 全文核读(976 行)。全部子进程调用为 `execFileSync` + **argv 数组**(无 shell 字符串拼接,无注入面):`docker()`(L192)、`ipt()`(L184,`sudo -n iptables`,非交互、15s 超时、stdio pipe)、`detectHostIp()`(L198)。sudo 仅用于 iptables 最小面;`--label` 值来自 owner token(env 显式继承或进程级 `randomUUID` 截断,受控);Go template 格式串(`{{index .Labels "relay.egress.owner"}}` 等)均为常量。注入性反例核查:scope 前缀(env 可控)流入网络名(非法名 docker 拒绝=fail-closed)、链名(`chainNameFor` L95-99 白名单净化 + ≤28 字符)、iptables 注释(argv 单元素,iptables 自身校验)——最坏情形均为失败拒绝,无命令逃逸。`verifyEgressEffective` 的 node -e 脚本插值仅 `hostIp`(L199 正则约束为 `\d+.\d+.\d+.\d+`)与数字端口。

### E2 网络拓扑/所有权 —— PASS

- default 域生产名/端口逐一比对不变:`relay-egress-net`/`relay-egress-fwd`/`RELAY-EGRESS`/`relay-p01c-egress`/13425/13426(L38-44)。
- test 域全派生含端口(自建探针 **P6** 性质测试:端口∈[20000,39999]、countPort=forward+1、永不等于生产端口、链名≤28、同 id 确定性)。
- **匿名拒绝的判定基座亲测**:在真实 docker 上对 3 个第三方容器与 bridge/host 网络执行 `docker inspect -f '{{index .Labels "relay.egress.owner"}}'` —— 缺失标签输出为**空串**(非 Go template `<no value>`),故 `networkOwner` 的 `""→匿名 / null→不存在` 语义(L227-234)成立,匿名拒绝分支(L542-548、L608-615)真实有效。
- teardown 授权 = 进程内注册表 ∪ owner 标签匹配;iptables 以网络归属(netOwned)为锚、链 -F/-X 另需本进程注册表锚(L884-948)——逐行实证与文档一致。

### E3 恶意/竞争反例(自建探针亲测)—— PASS

我编写了独立于仓库测试的模拟执行器(容器 status 独立字段、iptables -S 真实引号语义、-D 令牌严格匹配、create 冲突竞态注入),7 探针全绿(临时文件,复核后已删除,未入库):

| 探针 | 反例 | 实测结果 |
| --- | --- | --- |
| P1 | 对手容器 `created` 态(创建中) | 有界等待后 fail-closed,**零 rm**,零破坏性命令——**三轮迭代②"created 态误杀"修复真实有效** |
| P2 | 跨进程 owner 匹配 teardown,注释含空格 | DOCKER-USER/INPUT 跳转与放行规则真删;每条 `-D` 的 `--comment` 后**恰为单一令牌**——**三轮迭代③"引号分词"修复真实有效** |
| P3 | 对手在我方判空→create 窗口内抢建同名容器 | 我方 fail-closed,**零 docker rm**(不误杀对手),仅触碰自有作用域链 |
| P4 | 本执行者 running 但配置不符(期望密钥挂载而无挂载) | 拒绝非恢复(fail-closed,零删除)——见 Minor-3 |
| P5 | 混合注册表(两作用域自建)+ 默认域 teardown | 默认资源零触碰;逐作用域回收互不串扰 |
| P6 | 作用域派生性质 | 见 E2 |
| P7 | verifyEgressRules 作用域化 | scope 三件套通过;缺省(默认域)不误判他作用域为就绪(fail-closed) |

另实测仓库自带:单元 10/10、隔离 E2E **6/6**(跨进程并发收敛恰一容器+归属标签核验/复用+TCP 真实探针/非持有者与默认域 teardown 零删除/半残 recovered/全回收零残留/默认资源 DELTA 不变)、egress-enforcement 4/4、worker-entry+reviewer-readonly 5/5。REPORT §6 登记的三轮迭代(①create 冲突收敛②created 态保护③引号分词)经 P1/P2/P3 独立证实。

### E4 失败清理 —— PASS

- teardown 报告真实性亲测:E2E afterAll 兜底清理输出 `deleted=[] skipped=[{ctr…不存在},{iptables…非本执行者持有⇒零 iptables 操作},{net…不存在}]` —— skipped 逐项带原因,不虚报删除。
- 零残留:基线(测试前)与跑后复核均为 `relay-test-*` 容器 0/网络 0/iptables 规则 0;默认资源基线=缺席,跑后不变;`ss -ltn` 无测试端口监听残留(20128 为 VM 原有 next-server,pid 566246,与测试无关)。

### E5 PI/CLI/Web/Worker 调用兼容 —— PASS

- `src/cli.ts`/`src/server/api.ts`/`src/worker-entry.ts` **零 diff**:保持 `ensureEgress(baseUrl)` 默认域语义;两处 docker 路径均在 `RELAY_PI_*` 未配置时 fail-closed 先行返回,egress 面不触发;`worker-entry` egress 一次性初始化+FAIL-CLOSED 不领取语义未变。
- `verifyEgressRules` 新签名(第 4 参 `{chain,ruleTag,fwdContainer}`)兼容:runner/reviewer/discovery/check-sandbox/sandbox 5 处调用点均传 `eg`;缺省=默认域(P7 亲测)。
- `buildDockerRunArgs` 新参 `egressNetwork` 向后兼容:reviewer-readonly.test 2/2 绿(不传参走 `resolveEgressScope().network`,与原 `EGRESS_NETWORK` import 常量同值);`readEgressRequestCount` 全部调用点已显式传 `countPort`。

### E6 测试拆链审查 —— PASS

- 全仓 `ensureEgress/teardownEgress` 测试调用点穷举:**7 个改动文件+2 个新文件全部作用域化**,无残余默认域调用(仅注释与 pi-e2e 的守卫调用命中字面);f1/f2 补齐退出后清理;worker-entry 子进程 `RELAY_PI_BASE_URL=""` 封死 CI 默认栈创建路径(REPORT §2.1 登记的历史泄漏)。
- CI 安全:`ci.yml` test job = `quality:full`(除浏览器)→ 真跑 egress-isolation-e2e 与 egress-enforcement(均 `skipIf(!dockerOk||!iptOk)`,ubuntu-latest 具备,只动 `relay-test-*`);模型门测试(egress-proxy/gate/pi-e2e/live-worker/f1/f2)CI 上 env 门 skip;`src/` 内 `teardownEgress` 零调用(仅定义),生产路径永不清理。

### E7 文档真实性 —— PASS

三处新增(docs/SECURITY_MODEL.md §2.6、docs/OPERATIONS.md、deploy/README-deploy.md 归属块+UNKNOWN③ 根因更新)逐句对照代码:owner 标签/注释携带、匿名 fail-closed、teardown 仅删本执行者持有+审计报告、测试全命名空间、"标签是运维归属标记而非安全认证"的诚实限定——均与实现一致。deploy README 保留了匿名资源须用户 D3 人工处置的路径,与合同拒绝语义匹配。

### E8 边界合规(硬禁令逐条核对表)—— 全过

| 禁令 | 核对方式 | 结果 |
| --- | --- | --- |
| 零生产迁移/DB 写入 | 无迁移文件改动;我跑的测试仅建独立 schema 测试库或无 DB | ✅ |
| 零生产 env/凭据写入 | diff 无 env/凭据面;探针零真实 key | ✅ |
| 零 restart/stop/reload 在用服务 | systemctl:relay-web/relay-worker Main PID 3242781/3242782,2026-11-13 02:00:08 启动未变 | ✅ |
| 零清理/重建在用默认 egress 资源 | 基线(缺席)→测后(缺席)亲测对照;测试仅 `relay-test-*` | ✅ |
| 零触碰 config/、p0-mvp/soak-r3b/ | `find -newermt 2026-11-14` 两目录零输出 | ✅ |
| 零模型调用/真实费用 | 我跑的全部测试仅 TCP 探针+被阻断外网 fetch | ✅ |
| 零强推/分支 | `git log`/`rev-parse origin/main`=HEAD=5cca5a8,无新提交 | ✅ |
| 零新常驻服务 | 无 systemd/daemon 改动 | ✅ |
| REPORT §2.2 事实抽查 | 默认栈缺席/第三方容器共存(php82-*、e2e-lab-site-1 等)/服务旧代码——全部与我只读观测一致 | ✅ |

## 2. Minor 登记(均不阻断)

- **Minor-1 跨 owner 并发 create 冲突窗口拒绝复用而非收敛**(P3 亲测):对手在 ⓪ 判空→③ create 窗口内抢建同名容器时,我方抛 `create_conflict_converge_rejected`,不复用健康同配置容器——而 ⓪ 的 reuse 语义是 owner 无关的,③ 收敛却要求同 owner 家族(egress.ts L696),语义不一致。结果为保守 fail-closed(零删除零误杀,合同明示允许),后续进程可正常复用;但默认域 web+worker 同时冷启动的窄窗口下可能一方降级(worker `egressInitDone` 一次性、不重试——该不重试为既有行为,非本包引入)。建议:注释写明该家族限定或登记重试候选。
- **Minor-2 跨进程 owner 匹配 teardown 的链残留**(P2 亲测):链 -F/-X 仅以本进程注册表为锚(L923),owner 继承的子进程 teardown 会删容器/跳转/INPUT/网络但保留作用域链(报告如实 skipped"非本进程创建");"零残留"在该场景要等原始创建者再 teardown 才成立。同前缀家族链不误清是正确的保守面,建议文档写明。
- **Minor-3 "配置不符⇒有界恢复"措辞与实现不符**(P4 亲测):本执行者 running 且配置不符(如期望密钥挂载而无挂载)⇒ 代码走**拒绝**(`fwd_container_foreign_or_stale`),恢复仅限真死(exited/dead)(L549-578)。行为 fail-closed 合规,但 egress.ts L507 头注释、REPORT §2.3#5/§4 的"配置不符⇒恢复"表述应修正为"真死⇒恢复;运行中配置不符⇒拒绝"。
- **Minor-4 同 ruleTag 跨 owner 规则串扰边界**:`ruleLineMatches` 按 `<ruleTag> owner=` 匹配不校验具体 owner,同前缀不同 owner 的家族可互相删除对方规则——仅在对抗性共用同一 scope 前缀时可达,测试前缀唯一性使实际风险趋零(记录性)。

## 3. 未验证项(如实)

- **GitHub CI exact-head 实跑**:实现未提交,CI 隔离 E2E(ubuntu-latest)属推送后验证项——本地 6/6 多场景稳定绿 + egress-enforcement 已有 CI 真跑历史,风险低但以 exact-head CI 为权威口径。
- `quality:full/release` 本地:按合同 D 项顺序门 NOT_RUN(Reviewer 认可后是否本地 full 由协调方决定)。
- 真实模型 Run、生产重启后自愈横幅:严格 NOT_RUN(生产 NO-GO 维持,D3 未授予)。
- `relay.egress.owner` 防伪造性:非安全认证,同宿主 root 伪造不在威胁模型(SECURITY_MODEL 已如实写明)——设计接受,不计缺陷。

## 4. 结论

实现与 REPORT 声明高度一致且经我独立复现:红态 9/9(日志亲验)、绿态 10/10、隔离 E2E 6/6、enforcement 4/4、定向 25/25 与我自建 7 探针全部绿;"无人值守时多入口并发/重复初始化/清理不误删不误杀不重建他人资源"的核心合同目标成立,生产默认域行为(名称/端口/FAIL-CLOSED)不变。**裁决 PASS**,可按合同 E 项进入 main-only 快进提交 + exact-head CI 复核;4 项 Minor 建议随提交一并消化(1/3 为注释措辞级)或登记后续候选(2/4)。

---

## 实现者附注(Reviewer 原文之外,时序记录)

- Minor-1/3 已消化:egress.ts 头注释按"真死⇒恢复;运行中配置不符⇒拒绝"修正,并写明 create 冲突收敛的家族限定(Minor-1)与 owner 继承链保留语义(Minor-2);REPORT §2.3#5/§4 措辞同步修正。Minor-2/4 登记入 REPORT §9 后续候选。
- 消化后复跑:tsc 干净;quality:quick 与定向测试在消化前已 PASS(措辞级改动不触行为面,提交前以最终 quality:quick 复跑为准)。
