# RELAY-EGRESS-ISOLATION-07R 独立 Reviewer 复核报告(2026-11-14)

**裁决:REWORK(Major-1;0 BLOCKED)。** 协调方 Major-1(前 8 字符截断链名碰撞)已修复并亲测通过,合同 E 指定反例 5 项中 4 项亲测 PASS;但本复核在真 docker 上**端到端复现了归属门的残余绕过路径**(人为构造 hash8 碰撞 + ruleTag 子串关系 ⇒ 第二作用域穿透归属门,-F 清空重写第一作用域规则)——这落在合同 C 明确验收条款("对人为同名/哈希碰撞做前置归属确认与拒绝;仅靠碰撞概率很低不算满足")的否定面上,故 07R 不能以当前状态关闭。

复核人:独立 Reviewer(全新上下文,与实现者零共享记忆,冷启动自 b3dea03 + 工作区未提交改动;所有结论均亲自实测)。

---

## 1. 冷启动挑战结论:**通过**

- HEAD=b3dea03(合同提交)与 CURRENT.md ACTIVE=07R 一致;实施以工作区未提交改动存在(git diff HEAD 恰为 4 个授权文件:`src/runtime/egress.ts`、`test/unit/egress-isolation.test.ts`、`test/integration/egress-isolation-e2e.test.ts`、`docs/SECURITY_MODEL.md` + 新增 07R REPORT/证据);07 旧证据(REPORT/REVIEW/evidence/ci-*)零删改。
- 协调方 REWORK 依据(COORDINATOR-REVIEW-20261114.md Major-1)与 diff 对得上:`chainNameFor` 旧实现为 `slice(0,8)` 截断,新实现为全量 id 的 `hash8`;协调方所述碰撞链名 `RELAY-EGRESS-abcdefgh` 在新代码下不复现(探针 A 亲测)。
- REPORT 基本结构、边界自述与实测一致(不一致处见 Minor-1/Minor-2)。

## 2. 合同 E 项逐条复核结果(全部亲测)

### 2.1 代码根因与修复(审查 + 实证)

| 项 | 结论 | 证据 |
| --- | --- | --- |
| `chainNameFor` 全量 hash 派生 | **修复确认** | 探针 A:`abcdefgh-one`→`RELAY-EGRESS-1223599d`,`abcdefgh-two`→`RELAY-EGRESS-12236d83`,链名/网络/容器/标记/端口全不同且同 id 确定性;旧碰撞名消失 |
| `chainRulesStrict`(-N 行剔除) | **正确** | 真 `iptables -S <链>` 输出首行确为 `-N <链>`(探针 B 快照可见);剔除后归属门对真实链判定正确(P2/P3 通过即证) |
| `ensureEgress` 链段(-N 失败⇒严格读取⇒归属门⇒空链 3s 有界宽限) | **语义正确,门实现有洞** | 非子串异 tag 碰撞:拒绝+零写(P2.1-P2.3 亲测);空链宽限 R7/R8 单测绿+真机收敛(E2E ①并发收敛 950ms 通过);**子串 tag 碰撞:门被穿透(见 Major-1)** |
| `teardownEgress` 链删除门(注册表⇒严格读⇒归属门⇒-F/-X) | **正确** | P4R 亲测:teardown A 后 B 链规则逐字节不变、ensure reused:true、计数端点同 pid;读失败/异 tag 拒绝路径见 R5/R6 单测 |
| 失败路径是否可能误刷共同链 | 非子串场景**零误刷**(P2.3 全规则面 diff 为空);子串场景**会误刷**(Major-1) | 探针 B |
| 修复是否引入新权限/破坏兼容 | **未发现**。default 域名/端口/FAIL-CLOSED 不变(探针 A:chain=RELAY-EGRESS、net=relay-egress-net、ctr=relay-egress-fwd、13425/13426);跨 owner 同 ruleTag 家族语义不退化(P3.2 reused:true 亲测);无新增能力/抽象,改动面仅 egress.ts+测试+SECURITY_MODEL 一句 | — |

### 2.2 亲测反例(合同 E-2 五项)

| 合同项 | 结果 | 亲测证据 |
| --- | --- | --- |
| a) 同前 8 字符 id 链名不同且确定性 | **PASS** | 探针 A(纯函数,零副作用) |
| b) 强制同链碰撞 ⇒ ensure 拒绝、零 -F/-A/-X、第一方不变 | **非子串 tag PASS;子串 tag FAIL(Major-1)** | 探针 B P2(非子串:ok:false `chain_foreign_or_unowned`+全规则面零 diff+第一方原样)/探针 B P1(子串:ok:true+第一方 2 条规则被 -F 重写为第二方规则+第一方 verifyEgressRules=false) |
| c) 跨 owner 同 ruleTag ⇒ 通过(家族不退化);ruleTag 不同 ⇒ 拒绝 | **PASS** | 探针 B P3(F2 异 owner 同 tag:ok:true reused:true;F3 异 tag:ok:false `chain_foreign_or_unowned`;F1 链零变化) |
| d) teardown 互不伤(A/B 栈,teardown A 后 B 完好) | **PASS** | 探针 C P4R(链/跳转/INPUT/网络/容器全删 A,B 链规则逐字节不变+reused:true+verifyEgressRules:true+计数端点同 pid;双域零残留)+ E2E "teardown A 后 B 仍健康" 亲测 |
| e) 默认不变(default 链名/生产名/端口/健康复用/FAIL-CLOSED) | **PASS** | 探针 A + 开工/收尾默认面快照一致(relay-egress-net/fwd/RELAY-EGRESS 链 absent 前后一致,DOCKER-USER 仅 `-N`,13425/13426 free);git diff 无默认名/端口改动;E2E/enforcement 的"生产默认链 RELAY-EGRESS 不受影响"用例亲测通过 |

### 2.3 测试亲测结果

- `npx vitest run test/unit/egress-isolation.test.ts`:**18/18 PASS**(R1-R8+原有 10;R7/R8 含 3s 空链宽限真等待)。
- `npx vitest run test/integration/egress-isolation-e2e.test.ts test/integration/egress-enforcement.test.ts`:**15/15 PASS**(E2E 11+enforcement 4;真 docker+sudo iptables;仅 relay-test-* 作用域;跑后默认面复核不变)。
- `npx vitest run test/integration/worker-entry.test.ts test/integration/reviewer-readonly.test.ts`:**5/5 PASS**(调用方回归)。
- 实现者 3 轮 E2E"×3 轮稳定"属实(/tmp/07r-e2e-1/2/3.log 各 11/11)。
- **Major-1 复现探针**(本 Reviewer 自建,/tmp/relay-07r-review/,复核后已清理):
  - 碰撞对离线构造:`hash8("frntla") === hash8("frntla-M")`(同 32 位值 `b4888887`;推导:对 `h(x+"-M")=961·h(x)+1472`,取 `h(x) ≡ -23·15⁻¹ (mod 2²⁶)` 即 8947847,小空间暴力搜索可得)⇒ `createTestEgressScope("frntla")` 与 `("frntla-M")` **同链不同 tag,且 `relay-test-frntla` 是 `relay-test-frntla-M` 的子串**。
  - 真机端到端:ensure(SA="frntla-M") 建栈成功 → ensure(SB="frntla") **ok:true** → 链内容从 SA 的 2 条规则(dport 34488,tag `relay-test-frntla-M`)变为 SB 的 2 条规则(dport 34698,tag `relay-test-frntla`)→ `verifyEgressRules(SA)=false`。第一作用域被第二作用域破坏,且 SA 后续 ensure 将被归属门永久拒绝(锁死),只能人工处置。

### 2.4 边界合规(硬禁令核对表)

| # | 禁令 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | 生产 relay_console/迁移 0008/0009 | ✓ 零触碰 | diff 无迁移/DB/生产代码 |
| 2 | 服务 stop/restart/reload | ✓ 零 | 全程未调用 systemctl;生产进程未动 |
| 3 | 生产默认 egress 资源(网络/代理/RELAY-EGRESS 链) | ✓ 零触碰 | 前后快照一致(absent);我的探针全部使用 relay-test-* 作用域 |
| 4 | 真实密钥 env | ✓ 零 | diff 无 env 改动;探针未注入凭据 |
| 5 | 模型调用 | ✓ 零 | 无模型相关调用 |
| 6 | 外部交付/防火墙/公网/TLS | ✓ 零 | 无 |
| 7 | 新分支/强推/git 写操作 | ✓ 零 | 无 commit/push;工作区仅原有改动+本 REVIEW 文件 |
| 8 | 第二控制面/新常驻服务 | ✓ 零 | 无 |
| 9 | `config/` 与 `p0-mvp/soak-r3b/` 保护目录 | ✓ 零触碰 | `find -newermt b3dea03 提交时刻` 两目录均空 |
| 10 | 生产 NO-GO 维持 | ✓ 如实 | REPORT §8/§9 与 CURRENT 一致 |

07 遗留资源观察(实现者侧,本复核**未动**,仅登记):孤儿网络 `relay-test-07rcollide-{62c8ec,55761c,b730a5,b928cb}-net` ×4(其 E2E 碰撞用例每次运行的泄漏,见 Minor-1)+ INPUT 残留规则 1 条(`--dport 28588 --comment "relay-test-probe07r owner=p755277-f2ff9c2a"`,其 ad-hoc 探针遗留)。均为带 owner 标签的测试作用域资源,不属默认面,建议下包收口时清理。

## 3. 问题列表

### Major-1:归属门可被子串关系穿透——人为 hash 碰撞 + ruleTag 子串 ⇒ 第二作用域 -F 清空重写第一作用域规则(合同 C 否定面)

- **位置**:`src/runtime/egress.ts` `chainScopeOwned`(约 308-311 行)用裸子串 `rules.every((l) => l.includes(ruleTag))`;同一根因扩散到 `ensureEgress` 的 `hasAccept`/`hasDrop`(约 700-703 行)、`verifyEgressRules`(约 849-850 行)、`jumpExists`(约 317 行)、`inputRuleExists`(约 330 行)。
- **定级理由**:07R 的唯一交付目标是"即使人为制造同名/摘要碰撞,必须在改变他人资源之前明确拒绝;仅靠碰撞概率很低不算满足"(CURRENT C 项原文)。`hash8` 是 32 位自定义哈希,碰撞对**可离线确定性构造**(本复核数秒内构造出 `frntla`/`frntla-M`);当两 id 构造为前缀关系时,短 id 的 ruleTag(`relay-test-frntla`)是长 id 规则注释(`relay-test-frntla-M owner=...`)的子串,门逐条 `includes` 全部命中 ⇒ 门形同虚设 ⇒ 第二作用域 `ok:true` 且执行 `-F`+`-A`。**真 docker 端到端复现**(见 §2.3):第一方规则被重写、第一方 `verifyEgressRules=false`、第一方后续 ensure 被门锁死。现有测试(单测 R1-R8、E2E 碰撞用例用非子串 tag `relay-test-foreign`)恰好都落在非子串侧,故全绿仍漏。
- **亲测证据**:探针 A(碰撞对构造+三前置条件成立)、探针 B P1(P1.4 ok=true、P1.5 规则被替换 diff、P1.6 verify=false);对照 P2(非子串同链被正确拒绝)。
- **精确修复指令**:
  1. `src/runtime/egress.ts` 新增词边界精确匹配(tag 字符集已知为 `[a-zA-Z0-9_-]`,注释在 `-S` 输出中被引号包裹):
     ```ts
     function lineHasTag(line: string, ruleTag: string): boolean {
       const esc = ruleTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
       return new RegExp(`(?<![a-zA-Z0-9_-])${esc}(?![a-zA-Z0-9_-])`).test(line);
     }
     ```
  2. 至少替换 `chainScopeOwned` 的 `l.includes(ruleTag)` ⇒ `lineHasTag(l, ruleTag)`;建议同步替换 `hasAccept`/`hasDrop`(`ensureEgress`、`verifyEgressRules`)与 `jumpExists`/`inputRuleExists` 的标记判断,保持全部规则面判定词边界一致(本复核已函数级验证:该匹配对 SB.tag 拒绝、对 SA.tag/default tag 均正确命中,家族语义不破坏)。
  3. 测试:单测新增 R9(模拟执行器):同链(人为同 chain)+ SB.tag ⊂ SA.tag ⇒ `ensure(SB)` 拒绝且链上零 `-F/-A/-X`、SA 规则原样(修前红/修后绿);E2E 可选补子串碰撞用例。
  4. 回归不退化:单测 18/18(或 19/19)、隔离 E2E 11/11、egress-enforcement 4/4 保持绿;真 docker 修复验证可按本报告 §2.3 探针步骤(ferntla 对)复跑,预期 P1.4/P1.5/P1.6 翻绿。
  5. `docs/SECURITY_MODEL.md` §2.6 补一句:标记匹配为词边界精确匹配(防 tag 前缀串扰)。

### Minor-1:ensureEgress 拒绝路径自建网络泄漏;E2E 碰撞用例每次运行遗留孤儿网络;REPORT"零残留"声明与事实不符

- **位置**:`ensureEgress` 步骤①网络创建(约 613-647 行)先于②链归属门(约 652-699 行)⇒ 门拒绝时本次自建网络留在宿主;`test/integration/egress-isolation-e2e.test.ts` 碰撞用例 finally 仅清链不清网络(且拒绝后未调用 teardownEgress(C));REPORT §5"零残留复核(iptables/容器/网络计数 0)"。
- **定级理由**:非跨作用域破坏(泄漏网络为本作用域独有命名+owner 标签),但 (a) 每次碰撞用例运行确定性遗留 1 个孤儿网络——本复核开工基线即见实现者遗留 ×4,亲测运行 E2E 后 ×5;(b) REPORT 明确写了"网络计数 0",与 VM80 实测状态矛盾,属证据陈述失实(非伪造证据,系残留面核对口径不全)。
- **亲测证据**:探针 B P2 泄漏观察(`relay-test-07rrev-collide-net` 在 ensure 拒绝后存在);E2E 亲测运行后新增 `relay-test-07rcollide-3eaa9b-net`(本复核已清),基线遗留 4 个未动(已登记)。
- **修复指令**:E2E 碰撞用例 finally 中 `teardownEgress(C)`(ensure 拒绝路径已把自建网络登记进 owned ⇒ teardown 可回收;链系手工预置不在 owned ⇒ skipped 如实,符合语义);或更彻底地把链归属门移到网络创建之前/失败路径回滚本次自建网络。同时更正 REPORT §5 残留声明为如实口径。

### Minor-2:REPORT §5 引述 green 日志为"18/18",日志实载 16/16

- **位置**:REPORT §5 vs `evidence/green-phase-07r-after-fix.log`(19:06,16 tests)。
- **定级理由**:R7/R8 是该日志采集后才加入(单测我亲测当前确为 18/18,结论本身成立),但把 16/16 的日志引述为 18/18 属证据引用不准确。
- **修复指令**:重采集一份 18/18 green 日志替换/补充,或更正 REPORT 引述。

### Minor-3(登记,07 既有、非 07R 引入):测试作用域端口确定性派生存在跨作用域碰撞

- **位置**:`scopePorts`(约 93-100 行):只避开生产 13425/13426,不避其他测试作用域;两作用域可派生出相同端口(甚至一方 forwardPort=另一方 countPort)。
- **定级理由**:亲测 `relay-test-07rrev-t1`(countPort 29001)与 `relay-test-07rrev-t2`(forwardPort 29001)碰撞 ⇒ 后者代理 EADDRINUSE ⇒ ensure fail-closed(`forwarder_not_ready`)。无跨作用域破坏(纯 fail-closed),但意味着任意两个合法 id 并发建立不保证可行,与"测试全套资源隔离(…端口)真实成立"的口径有差距。静态派生无法根除,登记后续候选(如碰撞时确定性跳变+文档指引)。

## 4. REPORT 事实抽查汇总

| 声明 | 抽查结果 |
| --- | --- |
| §2 根因(前 8 字符截断→同链) | ✓ 与协调方证据及 red 日志 R1 失败信息(`RELAY-EGRESS-abcdefgh` 同值)一致;新代码不复现(探针 A) |
| §3 红态 6 红(R1-R6)+原 10 绿 | ✓ red 日志实载 6 failed/10 passed |
| §4 实现 5 点(全量 hash/归属门/严格读取/宽限/teardown 门) | ✓ 代码实证;其中归属门存在 Major-1 洞 |
| §5 单测 18/18 | ✓ 我亲测 18/18;但所引 green 日志实载 16/16(Minor-2) |
| §5 E2E 11/11×3 轮 + enforcement 4/4 + 调用方 ✓ | ✓ 我亲测 15/15+5/5;/tmp 三轮日志各 11/11 |
| §5 "零残留复核(iptables/容器/网络计数 0)" | ✗ 与 VM80 实测矛盾(孤儿网络 ×4 遗留;每轮 E2E 泄漏 1 个)(Minor-1) |
| §6 迭代记录(-N 行教训/空链宽限/两处测试设计修正) | ✓ 与代码注释、R7/R8、每 run 唯一 id 设计一致 |
| §8 生产影响=零、default 不变 | ✓ 亲测(探针 A + 默认面快照 + diff) |
| §9 NOT_RUN(CI/full/release/生产重启) | ✓ 如实 |

## 5. 未验证项

1. exact-head CI:实现者未推送,我无推送授权 ⇒ NOT_RUN(修复 Major-1 后随包推送,由协调方 GitHub 亲核)。
2. quality:full/release 本地 NOT_RUN(合同 D 顺序门,隔离 CI 权威口径)。
3. 生产重启自愈横幅/真实模型 Run(D3 未授予)。
4. 模拟器与真实 iptables 输出的其他潜在差异(如 `-P` 策略行、`iptables-save` 格式)未穷举,由真 docker E2E 覆盖已实证面。
5. 本复核探针的 P4 首轮曾因自身 id 端口碰撞出现一次 `forwarder_not_ready`(即 Minor-3 现象),修正轮(P4R)已给出干净互不伤证据;该现象对实现者测试面为偶发风险,未在实现者测试 id 上复现。

## 6. 复核者自查声明

- 本复核全部探针位于 `/tmp/relay-07r-review/`(复核后按合同删除),对宿主的写操作仅限 relay-test-* 作用域资源,且已全部回收(07rrev/frntla 面零残留,探针容器/网络零残留);默认面前后快照一致;未触碰实现者遗留资源(仅登记);零模型/零生产/零 git 写操作。
- 裁决不受实现者遗留资源影响:Major-1 为代码行为缺陷(真机端到端复现),与残留无关。

---

# 第二轮复核增补(2026-11-14;Round1 REWORK 修复后终裁)

## R2-0. 裁决:**PASS(0 Major;Minor-4/5 非阻断登记)**

Round1 的 Major-1(归属门子串穿透)与 Minor-1(拒绝路径网络泄漏)、Minor-2(证据引述)均已修复并经本 Reviewer 真机独立复测确认;Round1 Minor-3(端口派生跨作用域碰撞)维持登记性质不变。第二轮亲测汇总见下。

## R2-1. 新 Major-1 修复复核(词边界 `lineHasTag`):**真机双方向实测通过**

- **代码实证**(`src/runtime/egress.ts`):`lineHasTag`(309-311 行)= 边界集(行首/空白/双引号)+ 正则转义;`chainScopeOwned`(321)、ensure `hasAccept`/`hasDrop`(716-719)、`verifyEgressRules`(865-868)、`jumpExists`(328,含 `-j ${chain}` 词边界)、`inputRuleExists`(343)全部替换,仓库内已无裸 includes 判定标记(仅 subnet/port 等结构化参数保留 includes,其误匹配需同作用域同 tag 才可达,无实际洞)。
- **真机双方向复测**(Reviewer 自建探针,复用 Round1 实证碰撞对 `frntla`/`frntla-M`,同链 `RELAY-EGRESS-b4888887`,`relay-test-frntla` ⊂ `relay-test-frntla-M`;探针在 /tmp,复核后删除):
  - **D1(短 tag 作用域对长 tag 规则链,Round1 穿透方向)**:ensure(SB) ⇒ `ok:false chain_foreign_or_unowned`;第一方链规则逐字节不变;全规则面(DOCKER-USER/INPUT/链)diff 为空(零 -F/-A/-X);SB 网络/容器未创建;SB tag 词边界语义下零规则面出现;第一方 `verifyEgressRules=true`;第一方二次 ensure `reused:true` 且规则零重写(词边界无假阴性);teardown 全回收含链。
  - **D2(长 tag 作用域对短 tag 规则链,反向)**:同构全部通过(拒绝/零写/零副作用/第一方不变/二次 ensure reused 不重写/teardown 全回收)。
  - **C2 家族控制**:跨 owner 同 tag ⇒ `ok:true reused:true`(default 域家族语义不退化)。
  - 终态 iptables/网络/容器零残留。**探针 30/30 全绿,总失败数 0。**
- **单测 R9/R10 反例先红后绿**:`evidence/red-phase-07r2-before-fix.log`(19:42)实载 20 用例中 R9 单红(旧代码 ok=true 穿透)、R10 守卫绿;`evidence/green-phase-07r2-final.log`(19:47)20/20。R9/R10 采用 Reviewer Round1 实证碰撞对,断言含零破坏性命令与规则原样。本 Reviewer 亲跑单测 **20/20 PASS**。

## R2-2. Minor-1 修复复核(ensureEgress 重排,拒绝路径零副作用):**通过**

- **代码实证**:新序为 ⓪容器处置预判(只读+等待)→ ①a 网络匿名**只读预检**(存在且匿名 ⇒ 拒绝)→ ②链归属门(-N/严格读/3s 宽限/词边界归属判定;拒绝点在任何创建之前)→ ①b 网络创建/复用 → ②b 规则/跳转/INPUT 写 → ③容器。碰撞/读失败/匿名网络三类拒绝路径均先于任何创建。
- **真机复测**:隔离 E2E **两轮 11/11**+enforcement 4/4(本 Reviewer 亲跑);**每轮后 relay-test 网络/容器/iptables 面/INPUT 残留计数全部为 0**(Round1 每轮泄漏 1 网络,现已零)。实现者先行的 4 个孤儿网络与 probe07r INPUT 残留规则亦已清理(本复核开工基线复测 = 全零)。REPORT §5 残留口径现已与实测一致。
- **重排语义边界(登记 Minor-4,非阻断)**:-N 成功(fresh 链)之后、首条 -A 之前的失败(①b 网络创建失败/竞态、subnet 探测失败、写规则失败、进程崩溃)会遗留**空链**;空链对任何人"归属不可证"⇒ 该作用域后续 ensure 永久 fail-closed,且 teardown 因空链门也无法回收(只能人工 `iptables -X`)。该楔死类在 07 旧序中同样存在(-N 与 -A 之间的崩溃窗口),07R2 重排把窗口拉宽(纳入网络创建+5s 竞态重试)并新增匿名竞态触发面;fail-closed 无跨作用域破坏、Runbook 有匿名资源人工处置路径,故登记不阻断。**后续候选修复**:失败路径补偿回滚——若 `createdChain===true` 且链此刻仍为空(严格读),`-X` 该链(空链证明无家族规则写入,回滚安全);或 -N 后移到网络创建之后。

## R2-3. Minor-2 修复复核(REPORT §5 证据口径):**通过**

REPORT §5 现按文件名逐一准确引述(red-phase-07r:R1-R6 六红;red-phase-07r2:R9 红/R10 守卫;green-phase-07r2-final:20/20;×3 轮 E2E 与 /tmp 三轮日志一致)。抽查无失实。

## R2-4. 回归亲测汇总(全部本 Reviewer 独立复跑)

| 面 | 结果 |
| --- | --- |
| mock 单测 `test/unit/egress-isolation.test.ts` | **20/20 PASS**(R1-R10+07 原 10) |
| 隔离 E2E `egress-isolation-e2e.test.ts` ×2 轮 | **11/11 ×2**,每轮后 relay-test 残留 0/0/0/0 |
| enforcement `egress-enforcement.test.ts` | **4/4**(07 用例全绿;FAIL-CLOSED/默认链不受影响实测) |
| 调用方 worker-entry + reviewer-readonly | **5/5** |
| quality:quick | **PASS**(本 Reviewer 亲跑,quick 总裁决 PASS) |
| 默认面前后 | relay-egress-net/fwd/RELAY-EGRESS 链 absent 前后一致;DOCKER-USER 仅 `-N`;13425/13426 free;零触碰 |

## R2-5. 边界合规(第二轮)

保护目录 `config/`、`p0-mvp/soak-r3b/` 零触碰(find -newermt 合同窗口为空);07 旧证据(07 REPORT/REVIEW/CI/e2e 归档)零删改;diff 恰为 4 个授权文件;零模型/零重启/零默认资源/零 git 写。硬禁令 10 项与 Round1 核对表同口径全部通过。

## R2-6. 遗留登记(非阻断)

- **Minor-4**:如 R2-2 所述,`-N` 之后、首条 `-A` 之前的失败/崩溃遗留空链楔死(07 即存在,07R2 窗口变宽);登记后续候选(补偿回滚或 -N 后移)。
- **Minor-5**:Round1 Major-1 修复指令第 5 项(`docs/SECURITY_MODEL.md` §2.6 补"标记匹配为词边界精确匹配"一句)未执行——`egress.ts` 代码注释已完整记载,属文档完整性小缺口,可随收口或下包补一句。
- **Minor-3(Round1,维持登记)**:测试作用域端口确定性派生的跨作用域碰撞(fail-closed,无破坏),未在本轮处理,维持后续候选。

## R2-7. 未验证项(与 Round1 口径一致)

exact-head CI(推送后协调方亲核);quality:full/release(隔离 CI 口径);生产重启自愈横幅/真实模型 Run(D3 未授予);空链楔死窗口的实机触发复现(静态推导+代码路径实证,未做注入实验)。

## R2-8. 复核者自查声明(第二轮)

探针位于 `/tmp/relay-07r-review2/`(复核后删除);对宿主写操作仅限 relay-test-* 作用域资源且全部回收(终态 iptables/网络/容器零残留);默认面前后快照一致;零模型/零生产/零 git 写;未触碰实现者资源。
