# 阶段 F(最终 MVP 复核)独立 Reviewer 报告

- 复核人:独立 Reviewer(阶段 F;不采信任何编码 Agent 的完成声明,一切以亲自读取与运行为准)
- 复核 HEAD:`a8adcaba41502e6f831308a77f9704f02f4d93aa`(已推送 main;`git log` 亲证)
- CI:`gh run list` 亲查——HEAD 对应 run `43004610762` **completed success**;此前 f149b06/05c1473/42994172744 均 success(仅 42993320419 历史失败已由 42994172744 处置)
- **soak 观察进度:elapsed 4687s / 86400s(≈5.4%,进行中)**;worker PID 3624561 与采样器 3627722 存活;`soak-final.json` 未生成(符合"未满不判");采样 RSS 稳态 ~113-115MB(<400MB 阈值),tick 状态 `IDLE_PROVIDER_DOWN`(FAIL-CLOSED 空转,与 E2 报告声明一致)
- 复核时点:2026-11-11 18:42–19:00 +08;约束遵守:除本文件外**仓库零改动**(复核产生的脏面:`p0-accept/live-worker-e2e.log` 被全量回归测试按其自身设计追加——已知已登记行为,本报告保持现场未回滚);未 commit/push;未触碰 soak 进程
- 方法:全部八件事均由本 Reviewer 亲自执行命令/亲读证据;命令与结果逐条列于各节

## 0. 逐项裁决总表

| # | 总包要求 | 裁决 |
|---|---|---|
| ① | 模型能否真正理解和调查用户需求 | **VERIFIED**(亲测新需求成功;附 Major-F1 复现性缺陷) |
| ② | 用户不介入时能否持续安全推进 | **VERIFIED** |
| ③ | GitHub 写入是否确实完成 | **BLOCKED 成立(亲证;用户侧单点)** |
| ④ | Reviewer 能否定 Coder | **VERIFIED(双证亲核)** |
| ⑤ | 重启后状态与证据保真 | **VERIFIED(5/5)** |
| ⑥ | Web/CLI/API 真正可用 | **VERIFIED(附 Major-F2:server schema 配置面不对等)** |
| ⑦ | 假绿/恒真/不当跳过 | **门控诚实;发现 Major-F1 + 观察项 2;全量回归账目与声明一致** |
| ⑧ | 越权/泄露/危险清理/重复副作用 | **VERIFIED(附 Minor×2)** |
| 9 | 终版矩阵审计 | **裁决与证据引用总体如实;基线抽测 3 项无回归** |

**本 Reviewer 终判意见:REWORK(维持,不得 ACCEPTED)**——与终版矩阵 §5 一致,三条理由全部经我亲证成立;另新增 2 项 Major 进入 REWORK 清单(见 §10)。

## 1. ①模型理解与调查——VERIFIED(亲测)

**我自建了与既有测试完全不同的需求与项目**:Node.js 行数统计工具 `wc.mjs`(真实缺陷:按 `\n` 个数计行,无末尾换行的文件末行被漏计——`printf 'delta'` 文件实测输出 0,编辑器视角 1 行),需求原话"行数统计工具 wc.mjs 统计的行数和编辑器里看到的不一样…请调查并给出修复建议"。预算声明 reserveCalls=6/wall 300s(magpie 本地,零真实成本)。

独立脚本(`/tmp/review-stage-f/discovery-probe.mjs`)直接调 `core.runGoalDiscovery`(独立 schema `p01a_review_f_*`,事后 DROP),结果:

- `ok=true, source=model`,wall 58s(预算内);
- 结构完整:problemStatement(249 字)/assumptions×4/recommendation/acceptanceCriteria×5;
- **报告真实引用我的项目内容**:problemStatement 精确命中缺陷机理(`split("\n").length-1` 漏末行)并引用我目录内 `nolastline.txt("delta")`、`sample.txt(alpha/beta/gamma)`——**非过拟合既有语料**(与既有三例:UX 表单/eval 坏设计/导出不完整,完全不同需求);
- sources 4/4 `exists=true`(全部指向我项目内真实文件);
- acceptanceCriteria 可判定(如"node wc.mjs nolastline.txt 输出 1(修复前输出 0)");
- 持久化回放:discoveries 落库 SUCCEEDED + content_sha256 + `model_ref=magpie/group/gm` + sandbox=host-fallback。

**结论:US-01/US-02 的模型面能力为真,我以独立新需求复证。** 同时发现复现性缺陷(见 §7 Major-F1)。

## 2. ②无人介入安全推进——VERIFIED

代码级审阅(亲读):

- `src/core/goal-loop.ts:201-251`:**D2 仅按事先授权 fallback 自动裁决**(RESOLVED_FALLBACK,任务保持 READY;无 fallback 防御性跳过);**D3 READY→NEEDS_DECISION 移出候选池,永不自动批准(T07 注释明示)**;交付装配失败不回滚 Gate 终态、落 D3 决策行人工处置(325-360)。
- `src/core/decisions.ts:92-106`:`expireStaleDecisions` **仅标记 EXPIRED_STILL_BLOCKED,不改变任务状态、不自动批准**。
- `src/worker-entry.ts:44-45`:`startSupervisorLoop(db, { claim: false })`——阶段 E 组合缺陷修正亲读确认(Supervisor 无执行器不领取;领取归 goal 环路)。
- FAIL-CLOSED:provider 未配置零领取(soak 全程 `IDLE_PROVIDER_DOWN`、零模型调用零成本,亲查 CSV)。

亲测:`npx vitest run test/integration/goal-loop.test.ts` → **6/6 绿**(V07/D3 不自动批准)。**裁决:无人介入时系统持续安全推进(有界自动面+硬阻断面),VERIFIED。**

## 3. ③GitHub 写入——BLOCKED 成立(亲证)

用沙箱 PAT(`~/.relay/credentials/github-sandbox-pat`,0600/93B/`github_pat_` 前缀亲证;**全程未打印 token**)亲验:

| 核查 | 结果 |
|---|---|
| `GET /user`(Bearer) | 200,login=`pwl1987`(token 本体有效) |
| `GET /repos/pwl1987/relay-delivery-sandbox`(Bearer) | **404**(fine-grained 语义=仓库不在授权范围) |
| 匿名同端点 | 404(互证:仓库私有且未授权) |
| `GET /user/repos?per_page=100` | **72 个仓库中无 relay-delivery-sandbox**(仅 `pwl1987/relay`) |

**阶段 C BLOCKED 裁定成立**:根因= PAT Repository access 未含沙箱仓(比"缺 Contents RW"更前置),与 `stage-c-github-permission.md` 逐项一致。GitHub 真实写入为 MVP 终判必过门,维持 BLOCKED。

## 4. ④Reviewer 否定权——VERIFIED(双证亲核)

- **否定实锤(真模型轮)**:`p0-mvp/f1/gate-evidence.json` 中 ev-d8e87017(机判确定性测试 `passed=false`:C1 0/3 label、C2 静默、C3 无反馈)+ ev-1b2da943(**独立 Reviewer 输出 REWORK 原文**:"候选清单无任何文件变更…确定性测试 passed=false…判 REWORK")——Reviewer 否定 Coder 的裁决链完整。
- **双向实证(stub 轮)**:`stub-tick-summary.json` 显示 stub 链并非一次过——前两次 gate FAILED(机判拒绝 C3 缺失),REWORK 后多次 ACCEPTED,最终 **3 轮独立运行各落一条 DELIVERED**(remoteHead/intentId 各异,独立 schema 独立远端,非重复副作用);`stub-final-check.json` 机判 4/4。
- **我亲跑机判负对照**:`node test/fixtures/f1-tasklist/check.mjs test/fixtures/f1-tasklist` → **exit=1**(C1 失败,C2 超时中断)——机判不接受未改进候选,与 `baseline-check.json`(3/4 失败)一致。
- F2 同构:`stub-final-check.json` 4/4(A1 除零 400/A2 非数字 400/A3 正常/A4 health),独立 HTTP 复核口径一致。

## 5. ⑤重启保真——VERIFIED

`npx vitest run test/integration/worker-entry.test.ts test/integration/v04-crash-recovery.test.ts` → **5/5 绿**(worker-entry 3:进程内启停/SIGKILL→重启(两次 WORKER_STARTED+RECLAIM_EXPIRED→NEEDS_RECONCILE+runs 零行)/零第二调度权威结构断言;v04 2)。soak worker 本身即活证据(连续存活 >1.3h,IDLE 空转零副作用)。

## 6. ⑥三入口可用——VERIFIED(附 Major-F2)

**CLI(真实进程,独立 schema)**:`doctor`(逐项容错+exit 5 环境不可用)/`status`/`goal create`(真写库,goal ACTIVE+task READY+审计 2 行)/`goal list`/`goal show`(完整结构,discovery 徽章 rules 态)/`decision list` 全通;**拒绝路径亲测**:无版本→exit 2、版本不符→`state_version_mismatch` exit 3、不存在 decision→`illegal_transition` exit 3(见 Minor-m3)、pause 正确版本 READY→PAUSED exit 0。

**API(真实进程,独立数据库,测后已 DROP)**:未登录写→**401**;登录 `POST /api/session`→200(role=owner+CSRF);缺 CSRF 写→**403 csrf_missing**;会话+CSRF 建目标→**201**(真写库);`GET /api/goals`→200 含新建 goal;Web 首页带会话 200/未登录 302→登录页。认证/CSRF/写门三道防线亲测生效。

**附 Major-F2(亲测发现)**:`src/server/index.ts:46` `connectDb(process.env.RELAY_DB_URL)` **不传 `process.env.RELAY_DB_SCHEMA`**,而 `src/worker-entry.ts:33` 传——**server 入口忽略 RELAY_DB_SCHEMA**:我以 `RELAY_DB_SCHEMA=<有表 schema>` 起 server,`GET /api/goals` 500(表不存在;根因亲读两行代码对比确认)。三入口对 CLI/worker/server 的 schema 配置面不对等:多 schema 隔离部署下 Web/API 会连错 schema(默认 search_path),既有演练以独立 database 隔离故未暴露。**不推翻既有验收**(各验收在其声明环境真实跑通),但"CLI/API/Web 对等 VERIFIED"的表述在配置面存在实质缺口,应修复(一行)或如实登记边界。

## 7. ⑦假绿排查——门控诚实;发现 Major-F1 + 观察项

- **门控语义诚实**:`f1-ux-journey`(RELAY_F1_E2E=1 且 RELAY_PI_* 四 env 齐)/`f2-bug-fix`(RELAY_F2_E2E=1)/`f3-injection`(RELAY_F3_E2E=1)均为 `describe.skipIf` 双条件门控;跳过在 vitest 输出中可见(skip 计数 15 与声明一致);stub 例显式标注(`workerMode:"stub(显式标注)"`、stub provider、机判脚本在候选面外——seedF1 排除 check.mjs,交付树亲核无 check.mjs,防自证循环)。
- **断言未被放宽**:真模型例断言全成功链(SUCCEEDED/ACCEPTED/DELIVERED/机判逐项 true);F3 注释自我披露"结构层恒真(禁 exec+只读挂载)+行为观察"两部分,与 f3-matrix 口径一致——**诚实披露的恒真,非伪装**。
- **全库无 describe.skip/it.skip/.todo/.only 滥用**(grep 亲查,仅 skipIf 门控);vitest.config 无过滤把戏。
- **全量回归亲跑**:`npx vitest run` → **240 = 223 passed + 15 skipped + 2 failed**(另有 1 个 vitest 框架自身 rpc 超时 error,非断言);2 failed 亲查均在 `test/integration/github-real.test.ts`(403 凭据面)——与终版矩阵"237=220+15+2(2fail=github-real 403)"口径连续(阶段 E 增 3 例 worker-entry 后 240=223+15+2),**零隐藏失败**。
- **Major-F1(亲测发现):`discovery.test.ts` 测试间 env 污染,真模型门控组在门控开启时必败。** 第 236-240 行 CLI operator 门测试在**进程内 `delete process.env.RELAY_PI_*`**;同文件后跑的真模型 describe(248 行起)beforeAll 后 `envModel()` 返回 null → 3 例全部失败("RELAY_PI_* 未配置")。我亲测:全文件跑(门控开)= **3 failed**;考古证实该 delete 自 49edffe(阶段 B 初始)即存在。**影响:矩阵 US-01 引用的"真模型门控 3 例绿"在当前 HEAD 以"全文件门控跑"口径不可复现**;我以 `-t` 过滤单组复跑 = **2 passed/1 failed/138s 真模型真实调用**——失败例为"incomplete→openQuestions 断言"(magpie 未输出 openQuestions 字段,方差如实失败,断言未被放宽)。**不推翻 US-01 模型面结论**(我 §1 的独立新需求亲测成功补强),但该测试缺陷应修(恢复 env 或拆文件),且"3 例绿"宜改述为"真模型门控证据见历史绿轮 + 方差披露"。
- 观察项 o1:上轮 REVIEW-stage-d 已登记"真模型门控测试只断言全成功路径,建议增加显式失败断言模式"——维持为 REWORK 建议。
- 观察项 o2(已知 Minor 延续):`live-worker-e2e.test.ts` 全量回归时向已跟踪文件 `p0-accept/live-worker-e2e.log` 追加(本轮工作区脏面实见)——REWORK-2 REVIEW Minor-5 已登记,未修,维持登记。

## 8. ⑧越权/泄露/危险清理/重复副作用——VERIFIED(附 Minor×2)

- **doctor 零明文(亲测)**:`node bin/relay.mjs doctor --probe` 输出 grep `github_pat_|ghp_|gho_|sk-|Bearer` → **0 命中**;`githubCredential` 仅 `{exists,path,mode:600,sizeBytes:93,contentShown:false}`;provider.vars 仅 set 布尔。
- **safeRm 拒绝面(亲测脚本)**:`/`→拒(forbidden_exact)、仓库根→拒(repo_root_subtree)、`REPO_ROOT/src`→拒(子树)、无哨兵目录→拒(sentinel_missing)、roots 内+RUN_SENTINEL→**放行且真实删除**。与 `test/unit/safe-rm.test.ts` 7/7 断言一一对应。
- **V05 语义不回归**:`npx vitest run test/integration/v05-lost-receipt.test.ts` → 1/1 绿。
- **重复副作用**:soak 独立 schema(soak24h)+ 独立 worker;E1 验收 runs 零行;本轮复核零重复副作用。
- **Minor-m1(测试孤儿进程)**:发现上轮阶段 E 复核演练遗留的 SIGKILL 分支 worker 进程(PID 3667382,`RELAY_WORKER_ID=rv-kill-worker2`,schema `p01a_review_e1_32da3925`)在测试结束 ~52min 后仍存活空转(每 150ms tick 查询)。无业务危害(IDLE/独立 schema),但暴露"测试/演练进程清理在强杀分支存在孤儿残留"——按边界我未动它,如实登记;建议测试收尾清理进程树。
- **Minor-m2**:`live-worker-e2e.log` 追加副作用(同观察项 o2,已知已登记)。

## 9. 终版矩阵逐项审计

| 矩阵裁决 | 我的审计结论 |
|---|---|
| US-01 PARTIAL→**VERIFIED** | **证据充分**:f1/discovery.json(真模型四缺陷识别)+ 门控测试 + 持久化;我以独立新需求亲测成功补强。附 Major-F1 复现性缺陷(测试面,非能力面) |
| US-02 NOT_IMP→**VERIFIED(P0 最小)/公网 P1 NOT** | 成立:本地只读调查+可回放+反驳+能力显式说明;P1 如实保留 NOT |
| US-08 **BLOCKED(根因修正)** | **亲证成立**(§3:72 仓库无沙箱仓/404 互证);根因修正(非"缺 Contents RW"而是仓库不在范围)与我的实测一致 |
| US-04 CLI **VERIFIED** | 亲测全命令集+退出码契约+V03 演练存证 ✓ |
| F1/F2 **PARTIAL(机制 V/真模型 PARTIAL)** | **如实**:真模型多轮全败落账(BUDGET_EXHAUSTED/TIMEOUT/SUCCEEDED-但-gate-FAILED)+ REWORK 原文;stub 显式标注且 gate 先拒后收;无任何 PARTIAL 被粉饰为 PASS |
| G7 **PARTIAL(24h 观察进行中)** | 与实测一致(4687/86400s;未写 PASS;soak-final.json 未生成) |
| §5 终判 REWORK 三理由 | **三条全部亲证成立**(③/§1+⑦/soak 进度);REWORK 清单 R-1/R-2/R-3 有界且路径明确 |
| 其余 V 项"未见回归" | 全量回归 240=223+15+2(2 fail=github-real 403)亲跑佐证 |

**基线矩阵抽测 3 项(防回归)**:`lease-expiry-fencing`(V06)+`gate-binding`(V09)+`intent-drift-reject`(V10)→ **7/7 绿**。基线 VERIFIED 面未见回归。

## 10. 发现分级与终判

**Blocker:无。**

**Major(2 项,均为本轮新发现;不动摇既有验收,但应进 REWORK 清单)**:
- **F1**:`discovery.test.ts` 测试间 env 污染——同文件 CLI operator 门测试 delete `RELAY_PI_*` ⇒ 真模型门控组在门控开启时**必然失败**(不可按"全文件门控跑"口径复现矩阵引用的"3 例绿");修复:env 保存/恢复或真模型组拆分独立文件,并以门控开启复跑留证。
- **F2**:`src/server/index.ts:46` 忽略 `RELAY_DB_SCHEMA`(worker-entry/CLI 均支持)——三入口 schema 配置面不对等;多 schema 部署下 Web/API 连错 schema。修复一行或如实登记部署边界。

**Minor(4 项)**:m1 测试孤儿进程残留(SIGKILL 分支;上轮演练 worker 存活 52min+);m2 live-worker-e2e.log 追加副作用(已知延续);m3 CLI `decision resolve` 对不存在 decision 报 `illegal_transition`(exit 3)而非 not_found(exit 4),错误语义偏转;M4/M5/M6/M7(阶段 E REVIEW 已登记)维持。

**观察项**:o1 真模型门控测试宜增加显式失败断言模式(上轮建议维持);o2 真模型门控 3 例在 magpie 下方差(本轮亲测 2/3),与"3 例绿"历史声明存在张力——如实披露,归入 R-2(更强模型路由后复跑)。

**独立终判意见:REWORK(维持;不得 ACCEPTED)。**

- 总包三条理由**全部经我独立亲证成立**:①US-08/G6 真实 GitHub 写入 BLOCKED(用户侧单点,亲证 404/72 仓);②F1/F2 真模型业务交付 PARTIAL(机制面 VERIFIED,交付面 magpie 方差实锤、失败全部诚实落账);③24h 长稳观察未满(4687/86400s,未写 PASS)。
- 按总包标准("全部 P0 必需门通过才 ACCEPTED"),三条任一即排除 ACCEPTED;**不存在任何可降低验收的豁免路径**。
- 机制面(安全/恢复/机判/预算/清理/编排)全部 VERIFIED 且我逐项亲测——REWORK 是**有界且路径明确**的:R-1 PAT 补权、R-2 更强模型路由、R-3 24h 期满判定;建议追加 R-4(修 Major-F1/F2 与 Minor m1/m3,均为小改动)。
- 全部证据绑 HEAD `a8adcab`;soak 进度 4687/86400s(≈5.4%)。

## 附:复核副作用声明

- 仓库内唯一写入:本文件。测试/演练全部使用独立 schema(`p01a_review_f_*`,已 DROP)与一次性数据库(`review_f_api`,已 DROP);
- 复核产生的临时文件均在 `/tmp/review-stage-f/`;
- 工作区现存脏面:`p0-mvp/soak-24h/{samples.csv,worker.log}`(soak 采集持续写入,预期内)、`p0-accept/live-worker-e2e.log`(全量回归测试自身追加,已知已登记行为,保持现场未回滚)、`?? p0-mvp/final-coverage-matrix.md`(实现者终版矩阵,未入库,本报告审计对象);
- 未 commit、未 push;未触碰 soak 进程(3624561/3627722)与遗留孤儿进程(3667382,已在 §8 登记)。
