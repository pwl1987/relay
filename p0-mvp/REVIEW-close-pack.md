# 收口包(CLOSE-PACK)独立 Review 记录

- Reviewer:独立窗口(全新上下文,亲测;非 Writer 自证)
- 复核 HEAD:`968cad01de38fdb5db84c309b2eeac9a8437bc55`(968cad0;与远端 main 一致,见 §8)
- 合同:`git show f4ccfa7:CURRENT.md`(CLOSE-PACK ACTIVE)
- 复核时间:2026-11-11 23:30 – 2026-11-12 00:10(+08)
- soak 进度(复核时点):**22547s / 86400s(≈26.1%)**;worker PID 3624561(17:32:52 启动)与 sampler PID 3627722 双进程存活;`soak-final.json` 未生成(正确:未满不写)。

## 结论:**PASS-WITH-FIXES**

交付物本体(验证器、回归、capabilities 口径、R-1 复查、CI 处置)亲测真实有效,验证账本全部对齐;终判维持 REWORK 不变。但存在 2 项流程边界违规(范围外真模型调用未记录、soak 观测中间态三次提交)与若干文档精确性缺口,须按下文修复项处置后方可终态收口。

---

## 1. 实际执行命令与结果

| 命令 | 预期 | 实测 | 裁决 |
| --- | --- | --- | --- |
| `git rev-parse HEAD` | 968cad0 | `968cad01de…`(origin/main fetch 后同为 968cad0) | ✓ |
| `npx tsc --noEmit` | 0 错误 | exit 0,零输出 | ✓ |
| `npx vitest run test/unit/soak-verify.test.ts test/unit/capabilities.test.ts` | 9+5 全绿 | 14 passed(9+5) | ✓ |
| `npx vitest run test/integration/cli.test.ts` | 13/13 | 13 passed | ✓ |
| `npx vitest run`(全量,辅助验证账本) | 249=232+15skip+2fail | 232 passed + 15 skipped + 2 failed(57 文件:1 failed/51 passed/5 skipped) | ✓ 与提交消息账本一致 |
| 2 failed 归属核查 | github-real 凭据面 | 单跑 `test/integration/github-real.test.ts`:2 failed 均为真实远端写入用例,错误=`403 Write access to repository not granted` | ✓ 且为 R-1 BLOCKED 的运行时实证 |

工作区状态:仅 soak 观测产物脏(`samples.csv`/`worker.log` 持续被进程追加,截至复核仍有新行)——符合合同"不 reset 不提交中间态"的存续要求(但见 §6-M2:此前三次提交已违背该令)。

## 2. R-2 诊断审计(`p0-mvp/r2-failure-analysis.md`)

### 2.1 "magpie=路由组"论断——亲自复核:**成立**

`env -u http_proxy -u https_proxy … curl http://127.0.0.1:3425/v1/models` 实测:`group/gm` = "GMD · routing group",`owned_by=zcode`,`reasoning=true`,`tool_call=true`,上下文 1,000,000;端点同时列出大量具体上游模型,但 group 条目不暴露组内上游映射——"路由组、上游对调用方不透明"与文档一致。

### 2.2 六分类对照原始 JSON(逐条核验)

| 文档行 | JSON 证据 | 裁决 |
| --- | --- | --- |
| F2 轮 1 Gate 拒 | `f2/tick-summary.json`:gate FAILED `evidence_not_passed`;`f2/gate-evidence.json` 为空 | ✓ |
| F2 轮 2 预算耗尽(6 上限) | `f2/runs-detail.json`:BUDGET_EXHAUSTED,cap=6,turns=6,`budget_turns_cap` | ✓ |
| F1 TIMEOUT 一次 | `f1/tick-full.json`:run-b1c3a7e4 TIMEOUT | ✓ |
| F1 BUDGET_EXHAUSTED cap=12 | `f1/runs-detail.json`:run-dcd8cfdd cap=12,turns=12 | ✓ |
| F1 首轮 SUCCEEDED 零编辑(2) | run-69939202:零编辑(`diff.modified=[]`)、reviewer 判"无文件变更" | ✓(结果)/ ✗(标注,见缺口 b) |
| 排除"工具错误" | toolDenied 事件存在但均为预期 DENY(`command_not_allowed:ls` 等),无异常工具失败 | ✓ |
| 排除"文件能力受限" | run-abe16b7d 同链路真实模型成功产出 new-task.html 修改候选 | ✓ |

**证据缺口(需修正文档,不推翻主因结论)**:

- **缺口 a**:f1 落盘 5 条 tick 中有 **2 条 SUCCEEDED→Gate FAILED**(run-abe16b7d 有编辑、run-69939202 零编辑)。文档 F1 表格仅 4 行,run-abe16b7d(有编辑→Gate 拒,ev-6ce99b64 passed=false)**完全未列**,"Gate 拒"类别只出现在 F2 行。六分类在 F1 侧覆盖不完整。
- **缺口 b**:"F1 首轮(采纳装配前)任务文本=一句模糊原话"与 JSON 矛盾——零编辑轮(run-69939202)的 problemStatement 已是装配后措辞("请调查并改进 new-task.html(保持现有字段与 localStorage 结构)")。"采纳装配前"轮次在落盘 JSON 中无对应记录;若证据仅为会话实录,文档未注明证据等级。
- **缺口 c**:"次轮×2 BUDGET_EXHAUSTED 6→12"中的 **"6" 无 JSON 证据**(run-587a9041 无 detail 记录;cap=6 仅见于 f2)。

主因归因("回合预算内未收敛")总体形态(2 预算耗尽+1 超时+2 Gate 拒)与证据一致,**不因上述缺口推翻**,但表格精确性需修。

### 2.3 对照实验设计边界:**守住**

§3 明确"待用户授权模型与预算后执行;本包零执行";§4 明确未重跑 F1/F2。设计-only,未执行 ✓。(另见 §6-M1:合同期间存在一次范围外 live e2e 真模型调用,与 R-2 无关但涉及"零重跑"措辞。)

## 3. R-3 验证器审计(`deploy/soak-verify.mjs`)

### 3.1 九项核验齐全性与断言强度

①重复表头剔除并计数 ✓;②时间窗(completed=lastElapsed≥target)✓;③存活采样(alive=no→硬)✓;④缺口(相邻 elapsed 差>gapLimit→硬)✓;⑤PG 异常('-'/空→硬;骤变>20→警告)✓;⑥RSS 阈值(硬)+CPU(仅观测)△;⑦tick 意外推进(非 IDLE*→硬)✓;⑧异常退出(与③同源)✓;⑨意外领取(worker.log 扫描,非 '-'→硬)✓。**无恒真断言**;五类阈值断言均真实有效。

弱点(均为 Minor):

- ⑨ 仅在 CLI 显式传 `--log` 才核验,缺省时静默降级为八项、输出无"未核验领取"提示;
- CPU 只有 max 观测、无阈值断言——合同名目"RSS-CPU 阈值"为半项;
- completed 只看末行 elapsed,不校验首行起点(首行 elapsed 异常大仍可判"完成";真实数据 first=32s 无此问题);
- `alive` 列垃圾值(非 "no")静默通过,只认死不认脏;
- verdict 未满分支固定拼接"且存在硬异常或软异常"——该字样引用的其实往往是 `observation_incomplete` 自身,语义循环、易误读(硬异常清单在 `hardErrors` 中如实单列,不受影响)。

### 3.2 恶意 CSV 亲自实测(自构,含五类注入+PG 缺失)

表头重复×1、缺口 660s、死亡行(epoch=280)、RSS 500000、PROGRESSED、PG='-' → 输出 `headerDuplicates:1`、`sampling_gaps:1(660s)`、`worker_dead_rows:1`、`rss_peak_exceeded:500000>400000`、`unexpected_tick_rows:1(PROGRESSED)`、`pg_sampling_failed_rows:1`,hardErrors 共 5 项,**exit=1** ✓ 全部捕获。

### 3.3 真实 soak 数据对照(亲自运行)

`node deploy/soak-verify.mjs p0-mvp/soak-24h/samples.csv`:

- verdict 含"**观察未满(22547/86400s)**" ✓;`hardErrors` 如实列出 `pg_sampling_failed_rows:2`;exit=1(因硬异常,从严合理)。
- 带真实数据的三处"异常"溯源(均非伪造):
  - `pg_conns='-'` 2 行 = 启动后 32–92s(PG 容器未就绪期);
  - `headerDuplicates:1` = 采样器 17:34 重启痕迹(sample.sh 重写表头;start-epoch 未变故 elapsed 连续);
  - RSS 峰值 312936 kB = worker 启动冲高(前两行),此后稳态 108–118 MB。
- 带 `--log worker.log` 复核第⑨项:`claimedTasks=[]`、`unexpectedClaimed=false`(零领取,空闲口径成立);tick 计数 **IDLE_PROVIDER_DOWN×1510**(详见 §7 口径说明)。
- 单测覆盖:9/9(①②③④⑤⑥⑦⑨+no_samples),超出合同最低合成场景 ✓。
- RSS 一致性:`/proc/3624561/status` VmRSS=114596 kB == `samples.csv` 末行 rss_kb=114596 ✓。
- `soak-final.json` 未生成 ✓(sample.sh 仅满 86400s 或死亡时写;与"soak-final 仅初步报告"口径一致)。

## 4. R-1 复核(`p0-mvp/stage-c-github-permission.md`)——**BLOCKED 维持成立**

亲自再跑(零 token 打印,凭据仅入内存变量):

- token 形态 `github_pat_` 前缀、93 字节(fine-grained);
- `GET /user` → 200,login=`pwl1987`(token 有效);
- `GET /repos/pwl1987/relay-delivery-sandbox` → **404**(仓库不在 PAT 范围);
- `GET /user/repos?per_page=100` → **72 个仓库,无 relay-delivery-sandbox**。

与文档"复查记录(~18:00 +08)"四项完全一致;且全量测试中 github-real 2 个失败用例的运行时错误(403 Write access not granted)实测复现了文档"404/403 是同一缺权两种表现"的说明。**用户补权前零 Git 远端实验边界:本包未见任何越界写入实验** ✓。

## 5. 治理项

- **capabilities BLOCKED 口径**:`src/server/capabilities.ts` `CapabilityStatus` 增加 `BLOCKED`(注释明确"外部阻断…不得与 NOT_VERIFIED 混用");`delivery.github.real` status=BLOCKED,note="细粒度 PAT 有效但 relay-delivery-sandbox 不在其仓库授权范围(2026-11-11 逐项核查;72 可见仓库无此仓)…机制面(本地 bare 全链)已 VERIFIED"——与 stage-c 文档及本 Review 亲测一致;单测 5/5 断言同口径 ✓。
- **CURRENT.md HEAD 口径:残留漂移(Minor-m2)**。当前 HEAD(968cad0)的 CURRENT.md 第 5 行仍为静态快照"HEAD == origin/main == `abd7d8e`"。合同第 4 条要求"自指 e39ed68 → **动态口径**",实际只做了一次快照替换(e39ed68→abd7d8e),动态口径未落实——同类漂移复发(此刻 HEAD 已是 968cad0,该行再次过时)。收尾更新 CURRENT.md 终态时必须改为动态口径(如"HEAD==origin/main 以 `git rev-parse` 实时为准"),不得再写死 SHA。
- **origin/main 跟踪引用**:复核起点 `git rev-parse HEAD origin/main` 为 `968cad0` vs `abd7d8e`(本地跟踪引用未刷新);`git fetch` 后 origin/main=968cad0 与 HEAD 一致,`git rev-list origin/main..HEAD` 为空。即"已推送"属实,漂移源于本地未 fetch,非推送缺失。
- **试验残留**:`/tmp/e3-backup` 已不存在 ✓;/tmp/relay-run-* 为历史运行工作区目录,不在合同清理清单内,未处理(如实记录)。

## 6. 诚实性:三边界核查(`git diff abd7d8e..968cad0` 全量审阅)

diff 全貌:12 文件,+1619/−36。`.github/workflows/ci.yml`、CURRENT.md、deploy/soak-verify.{mjs,d.mts}、r2-failure-analysis.md、stage-c 复查、capabilities+单测、soak-verify 回归、soak 观测产物、p0-accept/live-worker-e2e.log。**无 src 运行时逻辑改动**(仅 capabilities 常量与 note)。

- **不动 soak 进程:守住** ✓。worker/sampler PID 未变、持续 tick;产物仅进程自然追加。抽验三个提交内 `samples.csv` 末行 epoch 与提交时刻(2800669→22:29:28、1b55400→22:52:31、968cad0→23:36:37)逐一吻合,数据无伪造迹象。
- **不扩权:守住** ✓。PAT 范围未变(BLOCKED 维持);账本 limit=8 未扩大;无新凭据面。
- **不重跑真模型:按合同字面守住;预算消耗透明化须向用户明示(见 M1/m1)**。`p0-accept/live-worker-e2e.log` 在本 diff 中新增 9 行,事件时间 2026-11-11T14:25:40Z–14:26:38Z(**=本地 22:25:40–22:26:38**),一次 live 真模型调用(provider=magpie/group/gm,workerMode=live,ledger `model_calls used=5 limit=8`,DELIVERED sum=87)。**溯源更正(Review 过程中的关键新证据)**:该日志由 `test/integration/live-worker-e2e.test.ts` 写入——该测试是全量 vitest 套件固有组成(P0-ACCEPT 缺口 A-4 既有授权实验;门控=provider 探测+docker+sudo iptables 三门齐备才跑,CI 无模型自动 skip;goal limit=8 固定)。因此 22:25 这次调用是 **Writer 全量验证(提交消息账本 249=232+15skip+2fail 必然含该用例)时测试套件的自动行为**,与 abd7d8e 收官全量(18:50,used=5)、以及本 Review 自己的全量复核(23:56,used=6)同源——**本 Review 的全量 `npx vitest run` 同样消耗了一次真模型调用(used=6,limit=8 未变),如实记录**。合同两条字面边界均守住:非替代模型(F1/F2 与替代模型零重跑 ✓)、预算 limit 未扩大(8 不变 ✓)。遗留事实:每次全量验证=消耗 1 次真模型 e2e 预算(used 连续递增),该预算面应向用户明示;`r2-failure-analysis.md` §4"未重跑任何真模型任务"措辞与全量套件固有行为之间存在字面歧义(语境=R-2 诊断的 F1/F2/替代模型,可辩护,但建议精确化,见 m1)。
- **不提交 soak 中间态:违反(Major-M2)**。合同明令"工作区仅 soak 观测产物脏(**不 reset 不提交中间态**)",而 2800669(+187/+748)、1b55400(+23/+93)、968cad0(+44/+176)三个提交均带入 `p0-mvp/soak-24h/samples.csv` 与 `worker.log` 增量。内容真实、未篡改,但三次将合同要求保持"脏"的中间态写入 main,属明确字面违约。既成事实不可逆,须在终态记录该偏差;后续提交不得再犯(soak 终态应在观察结束后随终态提交一次性入库)。

## 7. 口径诚实性补充(IDLE_PROVIDER_DOWN)

24h 观察期 worker **全部 1510 个 tick 均为 `IDLE_PROVIDER_DOWN`**(provider 判定不可用,FAIL-CLOSED 空转)。`REPORT-final.md` 已如实记录("tick 全 IDLE_PROVIDER_DOWN FAIL-CLOSED 空转;未满不写 PASS")✓。Review 结论:该事实下,24h 观察结论只能支撑"**worker 进程存活与 tick 循环稳定性**",弱于"空闲稳定性"合同口径——终态报告沿用合同措辞时建议保留这层限定,不得升格为"业务负载稳定性"(现有文档未见升格,✓)。

## 8. CI 事实

| run | HEAD | 结果 | 核验 |
| --- | --- | --- | --- |
| 43036370634 | f4ccfa7 | e2e failure / test success | apt 层故障链一环 |
| 43038996567 | 2800669 | e2e failure / test success | 日志实证:`Temporary failure resolving 'security.ubuntu.com'` 等 + `E: Unable to fetch some archives` + `Installation process exited with code: 100` |
| 43042781942 | 1b55400 | e2e failure / test success | 同类:apt 镜像 DNS 解析失败(azure.archive.ubuntu.com 等) |
| 43050134811 | 968cad0 | **e2e success / test success(双绿)** | 免 apt 策略后通过 |
| 43050134831 | (任务给定) | **GitHub API 404,查无此 run** | 该 ID 在本仓库不存在(如实记录;双绿以 43050134811 为准) |

- `ci.yml` diff 仅 chromium 安装策略(免 apt 优先 + `--with-deps` 兜底),`browser journeys(J1..J5)`/`npx vitest run test/e2e` 测试步骤未放松;e2e 测试代码自 abd7d8e **零改动**(diff 无 test/e2e)。
- **"基建型失败非代码"定性:成立** ✓(四连败全在 install chromium 的 apt 层,test job 全程绿;换安装策略后 e2e 即绿)。

## 9. 发现清单与分级

**Major(1 项,必记)**

- **M2** 三个提交(2800669/1b55400/968cad0)带入 soak 观测中间态,违反合同"不提交中间态"(见 §6)。已成事实,修复=终态如实记录该偏差+后续不再重犯(soak 终态应在观察结束后随终态提交一次性入库)。

**Minor(4 项)**

- **m1** 真模型预算消耗透明化与措辞精确化:(a) live-worker-e2e.test.ts 为全量套件固有组成,每次全量验证消耗一次真模型调用(used 5→6 递增,limit=8 未变)——须向用户明示该预算面;(b) `r2-failure-analysis.md` §4"未重跑任何真模型任务"与全量套件固有行为存在字面歧义,建议精确为"F1/F2 与替代模型零重跑";(c) R-2 表格证据映射三处缺口(abe16b7d 行缺失/"采纳装配前"标注矛盾/"6"无 JSON 证据,见 §2.2)。均为修文档即可。
- **m2** CURRENT.md 动态 HEAD 口径未落实,静态 SHA 再次过时(见 §5)——收尾必修。
- **m3** 验证器弱点五处(⑨可选无提示/CPU 无断言/首行起点不校验/alive 垃圾值静默/verdict 未满措辞,见 §3.1)——可选修,不阻塞(现有硬断言真实有效)。
- **m4** 任务口径中 run 43050134831 在本仓库查无此 run(404)——记录在案,双绿以 43050134811 为准。

## 10. 终判

- **本包裁决:PASS-WITH-FIXES**——交付物本体合格且亲测全绿(tsc 0;14/14 单测;13/13 集成;全量 249=232+15skip+2fail 与账本一致;验证器五类恶意注入全捕获;R-1 BLOCKED 亲测维持;magpie 路由组论断亲测成立),不要求重做包;但 M2(soak 中间态提交)必须在终态收口时如实记录并防止复发,m1/m2 文档修复一并完成后终态收口。
- **MVP 终判:维持 REWORK**(本包合同即声明不改变终判;R-1/R-2/R-3 解除项仍未由用户动作解除)。
- 复核后动作:本文件入库;不 commit/push;不动 soak 进程(复核全程零写动作,除本文件;另如实披露:全量 vitest 复核触发了 1 次 live e2e 真模型调用 used=6,系测试套件固有门控行为,limit=8 未变)。
