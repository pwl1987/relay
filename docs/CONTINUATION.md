# Relay / HIVE Next 续接(以最新 live main 为准)

状态:**FROZEN(续接指令,不是独立事实源)**。2026-11-09 完成 P0-00(实验)与 P0-01A(状态内核);2026-11-10 完成 P0-01B(有界 Pi Run)、P0-01C(受控 Goal Loop)、P0-02A(候选变更与独立质量验证)、P0-02B(GitHub 安全交付集成)+ 补验包、**P0-02C(最小 Web 控制台与真实用户旅程验证;GitHub 真实写入仍 NOT_VERIFIED,随有效 PAT 补录)**。下一包 P0-ACCEPT 未激活。

## 唯一事实源及阅读

仓库:`https://github.com/pwl1987/relay`,只用 `main`,禁止强推。启动时务必读取 **live** HEAD 和分支、`AGENTS.md`、`CURRENT.md`、`README.md`、架构/契约/ADR,以及:
- 产品:`docs/PRD.md`;技术:`docs/DETAILED_ARCHITECTURE.md`;建设:`docs/CONSTRUCTION_PLAN.md`
- 安全:`docs/SECURITY_MODEL.md`;验证:`docs/VALIDATION_PLAN.md`;环境:`docs/DEPLOYMENT_PLAN.md`
- 各包报告:`p0-00/REPORT.md`、`p0-01a/REPORT.md`、`p0-01b/REPORT.md`、`p0-01c/REPORT.md`、`p0-02a/REPORT.md`(独立验证链)、`p0-02b/REPORT.md`(GitHub 安全交付链)、`p0-02c/REPORT.md`(Web 控制台;REVIEW 见各自 `REVIEW.md`)

产品原则:唯一 Lifecycle/State owner;六阶段 SDLC;Pi first 且 Runtime≠Model;Action Proposal→Policy→Scoped Executor;外部副作用结果不明先 Reconcile;证据/真实体验为 Gate;24×7 是有资源、权限和 Ready Task 时持续安全推进。

## 已裁决并落地(2026-11-10,P0-02C 更新)

- **Web 控制面全通**:`src/server/*`(仅 node:http;写路径只经 core;读模型 views.ts 35 SQL 全 SELECT)+ `web/` 五页零构建(DOM textContent 渲染禁 innerHTML;CSP 'self')。安全面:127.0.0.1 默认绑定(非回环须显式放行,拒绝落 audit_events)、scrypt 口令/服务端会话/HttpOnly+SameSite=Strict/限速锁定、写方法 CSRF+同源、operatorAllowed+expectedStateVersion(409)、全响应双层脱敏、D3 永不自动批准(源码自证+UI 无入口)。
- **能力登记表**(`/api/capabilities`):IMPLEMENTED/NOT_IMPLEMENTED/STUB/NOT_VERIFIED 四态;模型驱动的发现/推荐显式 NOT_IMPLEMENTED,页面不伪造 AI 分析;GitHub 真实写入 NOT_VERIFIED。
- **E2E 基建**:Playwright devDependency + `test/e2e/web-journey.test.ts`(RELAY_E2E=1 门,常规全量自动 skip)+ CI 独立 `e2e` job(Chromium+PG16)。五旅程 J1..J5 证据落 `p0-02c/`。
- **core 增量仅一处**:`deferDecision`(推迟只改截止时间;乐观并发;审计)。状态机/租约/Gate/交付链零改动。
- **测试基建**:196 用例 = 189 passed + 7 skipped(45 文件;skip=凭据门 2 + RELAY_E2E 门 5);E2E 5/5(真 Chromium);"全量绿"权威口径 = CI 隔离运行(R-9:宿主并发窗口下 gate-e2e 可能壁钟超时,隔离绿;与 P0-02B §8.5 风险并档)。
- **复核**:Reviewer 全新上下文两轮——首轮 PASS-WITH-FIXES(R-1 G-1 拒绝未落审计+零测试、R-3 stub 注入未强制标注)→ 处置(4c8118e)→ 复验 PASS(`p0-02c/REVIEW.md` §六/§七)。

## 已裁决并落地(2026-11-10,P0-02B 更新)

- **交付链全通**:Candidate ChangeSet → Git Commit(stage 克隆+树==清单往返核验)→ Gate(已消费绑定 PASS 为授权基础)→ Action Proposal → Policy(默认拒绝:仓库白名单/仅 main)→ Action Intent 两阶段(幂等键 sha256(task+changeset+commit+expected))→ Scoped Executor(非 force;凭据 0600 store 文件,argv/env/错误文本零令牌)→ Observation(远端 HEAD+逐文件内容双核对)→ **DELIVERED**;结果不明 ⇒ NEEDS_RECONCILE 先查真实状态;CONFLICT/FAILED 不回滚 ACCEPTED,落 D3 行(永不自动批准)。
- **三 SHA 区分**:candidate_sha(清单)≠ git_tree_sha ≠ git_commit_sha;Proposal 前绑定重核(commit 对象/树 sha/父 base)——树 sha 即内容承诺。
- **DELIVERED ≠ 用户 ACCEPTED**:goal 聚合语义不变;交付层失败仅落 changeset CONFLICT/FAILED + D3。
- **G-3 持钥 0600 化**:代理真实 key 从 docker env 改为宿主 0600 文件只读挂载;inspect 零可见(容器实测断言)。
- **G-4 Reviewer FS 只读**:docker 模式共享候选面 `:ro` 挂载+工具审计移出候选面;EROFS 实测(host-fallback 保持 prompt 级隔离并如实标注)。
- **测试基建(P0-02B 终态)**:163 用例(40 文件;全量 161 passed+2 skipped);非模型全新克隆 152+11skip+tsc 0 可复现;CI 落盘(`.github/workflows/ci.yml`:typecheck+全量 vitest+PG16 service;模型/凭据门自动 skip,容器确定性门真跑)。
- **补验收敛(P0-02B 第二轮)**:测试夹具**零强推**(剥离注释后的可执行代码面自证)+ 目标固定沙箱仓库(env 不可改指)+ 每轮读真实远端 HEAD 建候选 + 外部写者正常快进 + 历史未丢断言(祖先关系/提交数恰好 +1/旧头对象仍在);Policy **host 白名单**(默认仅 github.com,含端口维度)+ **userinfo 拒**;候选 base **恒等于 runs.input_commit_sha**(runner 取 Run 前记录 + stage 复位 + Proposal 一致性校验);relay_exec/relay_read **拒绝提示可行动化**(审计码不变);Reviewer 预算 4+4≤8 且提示明确可读范围(断言未放宽)。
- **运行环境事实(新增)**:① Node strip-types 子进程(裸 `node` 跑 .ts)不支持 TS 参数属性——helper/子进程加载链上的类禁用 `constructor(readonly x)`;② vitest 全量与克隆复现共享宿主 egress 栈,**不可并行**(fileParallelism:false 已设,人工并行跑两份会互踩);③ provider 门文件(gate-e2e/pi-e2e/egress-proxy)**必须自备 ensureEgress**(FAIL-CLOSED 自洽,不得依赖他文件残留的全局栈);④ executeRun 的 exec 白名单来自 RunSpec.allowedCommands(不读 DB),漏传 ⇒ 全拒。
- **治理流程(累计)**:ACTIVE 合同先于实现提交落盘;证据文件内嵌产出时 HEAD SHA;模型预算分阶段声明经 budget_ledger;复核窗口内的追加提交须在 REVIEW 中记录时序并由 Reviewer 补审(0207a6a 先例)。

## 遗留(前置检查单,接真密钥/后续包前)

⑥ **R-2**:登录限速键盲信 X-Forwarded-For(默认回环面无影响;非回环放行需求出现时与可信代理配置一起加固)。⑦ **R-5**:Origin:null 放行(三层兜底,维持登记)。⑧ **R-9**:全量 vitest 须无并发窗口;CI 隔离运行为权威口径。⑨ worker 生产模式(RELAY_WEB_WORKER=live)与 external relay-worker 进程编排属部署包,未实施(控制台 external 口径 tick=501)。

① **真实远端写入 + 漂移实验(P0-02B 唯一待办)**:宿主凭据文件存在但**内容不是有效 GitHub 令牌**(11 字节、无 `github_pat_` 前缀;GitHub API 四端点 401)⇒ 两例诚实 skip;已实测真实远端**安全失败**(鉴权被拒 ⇒ FAILED、非 DELIVERED、写入零调用、远端零变化;API 核验留证 `p0-02b/github-api-verification.log`)。有效细粒度 PAT(仅 `pwl1987/relay-delivery-sandbox` 的 Contents RW)放 `~/.relay/credentials/github-sandbox-pat`(0600)后运行 `npx vitest run test/integration/github-real.test.ts` 即闭环并补录日志——**不需要新授权**(合同内既定实验)。② base 一致性纵深(execute 阶段不复校;F-12)。③ base 仅存 reflog 时的阻断边界。④ 经典 ghp_* 令牌仅限开发者 infra,严禁入 Operator 面(补验已源码自证)。⑤ ~~Policy host 钉扎 + userinfo 拒绝 + 候选 base 一致性~~ —— **补验包已实现**(host 白名单默认仅 github.com + 端口维度;userinfo 拒;候选 base 恒等于 runs.input_commit_sha)。

## 唯下一任务:P0-ACCEPT(独立复核与长稳报告,NOT_ACTIVE)

1. 只读冷启动,核对 live main、写者、工作区。
2. 先起草 ACTIVE 合同并独立提交落盘,再实施。按 CONSTRUCTION_PLAN P0-ACCEPT 行:P0 端到端验证矩阵复核、故障注入核对、设计/实现一致性独立复核、长稳报告。
3. 验收:按合同;独立 Reviewer 复核通过、完整测试达标后才能快进推送 main。
4. 边界:不生产部署、不 RSI(接受之前禁止自改)、不权限扩大、不加模型预算。
5. 模型预算分阶段经账本预留;完成后更新 CURRENT.md 与本文件,报告最终 SHA/CI/复核。

## 新窗口可复制指令## 新窗口可复制指令

> 继续 Relay / HIVE Next,全部使用中文。唯一事实源为 https://github.com/pwl1987/relay 的 live main。先核对 HEAD、分支、写者锁和脏工作区,读取 README.md、AGENTS.md、CURRENT.md、ARCHITECTURE_BASELINE.md、CONTRACTS.md、ADR/README.md、docs/PRD.md、docs/DETAILED_ARCHITECTURE.md、docs/CONSTRUCTION_PLAN.md、docs/SECURITY_MODEL.md、docs/VALIDATION_PLAN.md、docs/CONTINUATION.md、docs/UI_UX.md,以及 p0-00..p0-02c 的 REPORT/REVIEW。严格 main-only、单 Writer、禁强推。**先把 [下一包] ACTIVE 合同独立提交落盘,再实施**。复用 src/core 状态层/绑定 Gate/验证租约/budget_ledger/交付链(delivery.ts/delivery-policy.ts/github-push 执行器,凭据只经 0600 文件)/src/server 控制面(auth/api/views/capabilities/worker;写路径只经 core;D3 永不自动批准;全响应脱敏)。另:若**有效**细粒度 PAT 已放 ~/.relay/credentials/github-sandbox-pat(0600;内容须为 github_pat_ 前缀),先补跑 `npx vitest run test/integration/github-real.test.ts` 完成真实写入 + 漂移实验并补录 p0-02b/ 证据(合同内既定,无需新授权);凭据无效时该两例诚实 skip,不得改用本机 gh 宽权限令牌替代。测试沿用 Vitest+独立 schema+真实故障注入;E2E 走 RELAY_E2E=1 门与 CI e2e job;"全量绿"以 CI 隔离运行为准(本地全量须无并发窗口,R-9);预算分阶段经账本预留。遇写者冲突、门禁失败或需要增加预算时阻断并说明,不自动扩大。完成后独立复核、快进 push main、核验 SHA 与干净工作区、更新 CURRENT.md 和 docs/CONTINUATION.md。
