# RELAY-EGRESS-ISOLATION-07R 最终报告(07 REWORK 最小纠偏)

裁决:**PASS**(独立 Reviewer 隔离上下文**两轮复核**:Round1 REWORK——协调方 Major-1 修复确认但新发现归属门子串穿透[真 docker 端到端复现];Round2 **PASS 0 Major**——lineHasTag 词边界修复真机双方向实测通过[探针 30/30]、R9/R10 先红后绿核实、Minor-1 重排零副作用通过、回归与边界全过;Minor-3/4/5 登记,5 已随收口消化;原文=REVIEW-RELAY-EGRESS-ISOLATION-07R.md 两段式)

日期:2026-11-14
合同:b3dea03(CURRENT.md「RELAY-EGRESS-ISOLATION-07R」ACTIVE;最低祖先 a31d947 满足;开工冷启动 live main=origin=本地 b3dea03,合同提交 CI 43579979419 test/e2e 双 job success 亲测;协调方 REWORK 依据=COORDINATOR-REVIEW-20261114.md Major-1)

## 1. 基线与 Writer

- 快进:a31d947(07 收口)→ b3dea03(用户合同登记,含协调方审计文件);`git merge --ff-only`;Writer=本窗口唯一;`config/`、`p0-mvp/soak-r3b/` 零触碰(find -newermt 复核)。
- 07 既有成功证据(CI 43575650845、REPORT/REVIEW、E2E 归档)零删改;本包为最小纠偏,只动 `src/runtime/egress.ts`、单测/隔离 E2E、SECURITY_MODEL 一句。

## 2. A 项:代码根因(完整审查)

- **Major-1 根因确认**:`chainNameFor(id)` 取合法 id **前 8 字符**——`createTestEgressScope("abcdefgh-one")` 与 `("abcdefgh-two")` 的 network/container/ruleTag/端口均不同,但链名同为 `RELAY-EGRESS-abcdefgh`(协调方 VM80 亲测;本包红态 R1 在模拟执行器中同字面复现)。
- **破坏路径(源码推导+模拟复现,未在共享宿主实跑)**:①第二作用域 ensureEgress 对共同链规则检查(按其 tag)不匹配 ⇒ `iptables -F` 清空重写(**误清第一作用域规则**);②teardown 的 owned 注册仅以物理链名标识,第二作用域可注册并 -F/-X 共同链(**跨作用域误删**);③默认域家族共享依赖 ruleTag 相同,碰撞作用域 ruleTag 不同 ⇒ 语义破坏。
- **07 原覆盖盲区**:单 scope E2E+唯一测试 id,未覆盖两个不同合法 id 的链名碰撞——"已完全隔离"结论被反例推翻(如实登记;旧证据文件零删改)。

## 3. B 项:反例先红(扩展 test/unit/egress-isolation.test.ts 模拟执行器;零真实系统调用)

红态 `evidence/red-phase-07r-before-fix.log`:**6/6 红**(R1-R6),原有 10 用例保持绿:

- **R1** 命名:共享前 8 字符两 id ⇒ 同链字面复现(`RELAY-EGRESS-abcdefgh` === 同值);
- **R2** ensure(第二作用域)对共同链 -F 清空重写第一作用域规则(ok:true+规则被覆盖);
- **R3** teardown(第二作用域)误删共同链(report.deleted 含链+规则消失);
- **R4** 强制同链碰撞(预置他作用域规则)⇒ 旧实现照常 -F/-A(ok:true,破坏性命令在录);
- **R5** iptables 读取失败 ⇒ 旧实现仍盲写 2 条破坏性命令;
- **R6** teardown 读失败 ⇒ 旧实现仍盲 -F/-X 清链。

## 4. C 项:最小实现(仅 src/runtime/egress.ts)

1. **chainNameFor 全量标识派生**:链名 = `RELAY-EGRESS-` + hash8(**全量** id)(不再前 8 字符截断;≤28 字符;同 id 确定性)。残余哈希碰撞不依赖概率——由归属门兜底。
2. **链归属门 `chainScopeOwned`**(所有链写/清的前置确认):空链=归属不可证(拒绝;**历史同名无归属链不得自动接管**);任一规则不含本作用域 ruleTag ⇒ 非本作用域/混入(拒绝)。default 域家族共享靠同一 ruleTag 通过(owner 不同但标记相同视为家族)。
3. **ensureEgress 链段**:-N 失败(链已存在)⇒ 严格读取 ⇒ 归属门 ⇒ 拒绝或家族认领;**空链有界宽限(3s)**等待并发创建者写入(并发对手建链可见性滞后,07 期实证)后按门判定;**读取失败 ⇒ `iptables_read_failed` fail-closed**(归属判定不得基于读失败的空集)。
4. **teardownEgress 链删除**:注册表内链 ⇒ 严格读取 ⇒ 归属门 ⇒ 通过才 -F/-X;读失败/含他作用域规则 ⇒ skipped 如实(零清);未注册 ⇒ 维持"非本进程创建"跳过。
5. **关键实现教训(如实)**:真实 `iptables -S <链>` 输出含 `-N <链>` 声明行(不含规则标记)——严格读取必须剔除,否则归属门对每条真实链误拒(本地模拟绿/真 docker 首跑全红的教训;已写入代码注释)。

## 5. D 项:红绿与隔离测试证据

- **红→绿翻转**:`evidence/red-phase-07r-before-fix.log`(R1-R6 共 6 红)→ 绿(R1-R8+原有 10);**Reviewer Round1 后追加 R9/R10(子串穿透反例,先红 `evidence/red-phase-07r2-before-fix.log`[R9 红/R10 守卫]→修复后绿)**——最终 `evidence/green-phase-07r2-final.log` **20/20 绿**(R1-R10+原有 10)。R7=空链宽限认领并发创建者(收敛);R8=空链宽限超时拒绝(无主链不接管);R9/R10=真实 hash8 碰撞对 "frntla"/"frntla-M"(同链 b4888887 且短 tag ⊂ 长 tag)两方向词边界拒绝。
- **回归不退化**:07 单测 10/10 ✓;隔离 E2E 6/6(07 全部用例)✓;egress-enforcement 4/4 ✓;worker-entry/reviewer-readonly 调用方 ✓;quality:quick **PASS**(`evidence/quality-quick-07r-final.log`)。
- **双 scope 真实 E2E(CI 同门,真 docker+iptables)**:新 07R describe 5 用例——①默认面基线快照(**网络/代理容器/RELAY-EGRESS 链/DOCKER-USER/INPUT/监听端口**全量);②双 scope(共享前 8 字符 id)各自建立、链名不同、规则各归其链(aRules/bRules 逐条含各自 tag);③**强制同链碰撞**(独立链手工预置他作用域规则 ⇒ ensure 拒绝+零写零清+第一方规则完全不变,自建链有界自证清理);④teardown A 后 B 仍健康(复用 reused:true+verifyEgressRules+计数端点)+teardown B 后双域零残留;⑤默认面前后 DELTA 不变。本地 **11/11 绿×3 轮稳定**(`evidence/targeted-07r-final.log`),零残留复核(iptables/容器/网络计数 0);CI 隔离实跑=推送后 exact-head test job。
- **VM80 本地边界**:全程仅 mock/真 docker 作用域资源+只读观测;零默认 iptables/默认 docker 资源/模型调用;full/release 本地 NOT_RUN(交隔离 CI)。

## 6. 实现迭代记录(如实)

①首版归属门在真 docker 全红——真实 `iptables -S <链>` 含 `-N` 声明行(模拟器无)导致全链误拒(教训:模拟器语义与真实 CLI 输出的差异必须在真环境首轮校准;已修+注释)。②空链并发宽限:07 期收敛语义(并发建链)与"空链拒绝"冲突 ⇒ 有界宽限(3s)+窗口后拒绝,兼顾收敛与不接管。③E2E 两次测试设计错误如实修正(碰撞用例误用 B 链名残留孤儿清理行;确定性 id 跨 run 残留污染 DELTA 快照 ⇒ 改每 run 唯一 id+独立碰撞 scope)。
**Round2(Reviewer 自建探针新发现)**:④**子串穿透**——裸 `includes(ruleTag)` 在真实 hash8 碰撞对且短 tag ⊂ 长 tag 时把他人规则误判为本作用域 ⇒ 新增 `lineHasTag` 词边界精确匹配(行首/空白/引号边界,链名同用)替换全部 7 处裸 includes(归属门/ensure hasAccept/hasDrop/verifyEgressRules/jumpExists/inputRuleExists);R9/R10 反例先红后绿。⑤**拒绝路径零副作用**——链门与网络匿名预检前移到任何创建之前(rejected ensure 不再建网络 ⇒ 修复 Round1 实测的孤儿网络泄漏;E2E 多轮后 relay-test 网络/容器/iptables 计数 0)。

## 7. 独立 Reviewer(隔离上下文;原文入库=REVIEW-RELAY-EGRESS-ISOLATION-07R.md)

**Round1 裁决:REWORK(Major-1 子串穿透)。** 冷启动挑战通过;协调方 Major-1(链名前 8 字符截断)修复亲测确认(chainNameFor 全量 hash+确定性,旧碰撞名不复现);合同 E 反例 5 项中 a/c/d/e 亲测 PASS(含 teardown 互不伤、家族语义、默认面不变);mock 单测 18/18、隔离 E2E 11/11、enforcement 4/4、调用方 5/5 全部独立复跑通过。但 Reviewer 离线构造出真实 hash8 碰撞对("frntla"/"frntla-M",同链 `RELAY-EGRESS-b4888887` 且短 tag 是长 tag 子串),并在真 docker 端到端复现裸 `includes(ruleTag)` 归属门被穿透:第二作用域 ensure ok:true,-F 清空重写第一作用域规则,第一方 verifyEgressRules=false 且后续 ensure 被门锁死——落在合同 C"人为摘要碰撞必须拒绝、不靠概率"的否定面;现有测试恰全部落在非子串侧故全绿仍漏。Minor-1:ensure 拒绝路径自建网络泄漏+E2E 碰撞用例每轮遗留孤儿网络(VM80 实见 ×4 遗留),§5"网络计数 0"声明与实测矛盾;Minor-2:green 日志实载 16/16 被引述为 18/18(R7/R8 后加;当前实况成立);Minor-3(登记):测试作用域端口确定性派生跨作用域碰撞(fail-closed,非 07R 引入)。硬禁令 10 项逐条核对全过;07 旧证据零删改;保护目录零触碰;07 遗留测试资源(4 网络+1 INPUT 规则,均带 owner 标签)已登记未动。

**Round2 终裁:PASS(0 Major;Minor-4/5 非阻断登记)。** Round1 全部修复项经本 Reviewer 真机独立复测确认:①`lineHasTag` 词边界精确匹配已替换全部 7 处裸 includes(归属门/ensure hasAccept/hasDrop/verifyEgressRules/jumpExists 含 `-j ${chain}` 词边界/inputRuleExists),Reviewer 碰撞对**双方向真机复测均拒绝**且零 -F/-A/-X、第一方规则逐字节不变、拒绝路径网络/容器/规则零副作用、第一方 verifyEgressRules 仍通过、二次 ensure reused 且零重写(词边界无假阴性)、跨 owner 同 tag 家族 reused 不退化——探针 30/30 全绿;②R9/R10 采用 Reviewer 碰撞对先红(`evidence/red-phase-07r2-before-fix.log`:R9 单红/R10 守卫绿)后绿,单测亲测 **20/20**(`evidence/green-phase-07r2-final.log`);③ensureEgress 重排(网络匿名只读预检+链归属门前移到任何创建之前)后,隔离 E2E 亲测 **11/11×2 轮**+enforcement **4/4**,每轮后 relay-test 网络/容器/iptables/INPUT 残留计数**全零**(Round1 每轮泄漏 1 网络已消除),实现者遗留 4 孤儿网络+1 INPUT 规则亦已清理,§5 残留口径与实测一致;④§5 证据口径已准确(逐文件名引述)。回归:调用方 5/5、quality:quick PASS(均 Reviewer 亲跑);默认面前后一致(relay-egress-net/fwd/RELAY-EGRESS absent、DOCKER-USER 仅 -N、13425/13426 free);保护目录零触碰;07 旧证据零删改;硬禁令 10 项全过。**登记非阻断**:Minor-4=-N 后首条 -A 前失败/崩溃遗留空链楔死(07 即存在,07R2 重排窗口变宽;后续候选=空链补偿回滚或 -N 后移);Minor-5=SECURITY_MODEL §2.6 未补"标记匹配为词边界精确匹配"一句(Round1 修复指令第 5 项;代码注释已完整记载,文档小缺口可随收口补);Minor-3 维持登记。未验证项:exact-head CI(推送后协调方亲核)、full/release(隔离 CI 口径)、生产重启自愈(D3 未授予)。详见 REVIEW-RELAY-EGRESS-ISOLATION-07R.md 第二轮增补段(R2-0~R2-8)。

## 8. 生产影响、回滚与边界

- **生产影响=零**:default 域链名 `RELAY-EGRESS` 不变;生产 ensure/teardown 语义仅增强(归属门对 default 家族靠同一 ruleTag 透明通过);零生产写入/重启/模型/迁移;生产旧进程未重启(行为不变)。
- 回滚:`git revert` 本包提交即还原(无迁移/schema)。
- 边界:main-only 单 Writer;保护目录零触碰;零真实凭据/零模型/零网络改造;未在 VM80 跑 full;未把修复当作生产可切换(生产 NO-GO 维持)。

## 9. 登记(后续候选,均不阻断、均未实施)

- **Minor-4(Reviewer Round2)**:-N 之后首条 -A 之前失败/崩溃遗留**空链楔死**(07 即存在;teardown 因空链归属门也无法回收,只能人工 -X)——后续候选:失败路径补偿回滚(链仍空则 -X)或 -N 后移至网络创建之后。
- **Minor-3(Round1,维持)**:测试作用域端口确定性派生跨作用域碰撞(t1.countPort=t2.forwardPort ⇒ fail-closed forwarder_not_ready,非 07R 引入)——后续候选:派生时错开奇偶或探测。
- 既有登记不变(生产切换 D3/POC 池/各包 Minor)。

## 10. NOT_RUN/未验证(如实)

- exact-head CI(推送后亲核双 job)——推送前未验证项。
- quality:full/release 本地 NOT_RUN(隔离 CI 权威口径)。
- 真实模型 Run/生产重启自愈横幅:NOT_RUN(D3 未授予)。
- 模拟器与真实 iptables 输出的其他潜在差异(如 -P 策略行):仅 -N 行实证存在并已处理;其余由真 docker E2E 覆盖。
