# 第四包:测试与治理小缺口(2026-11-12)

- 合同:CURRENT.md 第四包行(b30a492 激活);边界:不触碰 soak 采集/第一包证据面;零模型预算消耗声明见"披露"节。
- HEAD 基线:b30a492(实施前);本报告随实施提交入库。

## ① github-real 夹具幂等(每轮唯一载荷)

- 修复:`test/integration/github-real.test.ts` 三处硬编码载荷改 `RUN_TAG=randomUUID().slice(0,8)` 每轮唯一——`delivered.txt`(t-gh-real)、`drift.txt`(t-gh-drift)、**`foreign.txt`(外部写者;第二处非幂等系本轮重跑实证发现**:R-1 首轮已将 `external writer was here\n` 推入远端历史,重跑 `reset --hard` 后同内容 ⇒ `git commit` 空 diff 失败——d75ee9d "夹具非幂等登记"的另一半,已一并修复)。
- 真实验证(代理净化环境):首轮发现 foreign.txt 空提交失败(实证价值)→ 修复后 **4 passed + 1 skipped(经典 token 拒,预期 skip)**;DELIVERED 13.5s+漂移 13.6s;断言含唯一载荷全文(`toContain(p0-02b real remote write ${RUN_TAG})`)。
- 远端事实:沙箱仓新增 4 提交(验证消耗,如实披露):`57ea8c63`/`35f1ab8d`/`4bf5986a`(t-gh-real 交付)+`6c035203`(外来写者,当前头);历史只增、零强推(祖先链延续 `e52934fa`/`0dbf08a9`/`175eb071`)。

## ② 模型测试向已跟踪日志追加的副作用清除

- 修复:三个模型门控测试证据写点改独立未跟踪目录(`.gitignore` 增 `test-evidence/`):
  - `f1-ux-journey.test.ts`:`p0-mvp/f1` → `test-evidence/f1`
  - `f2-bug-fix.test.ts`:`p0-mvp/f2` → `test-evidence/f2`
  - `live-worker-e2e.test.ts`:`p0-accept` → `test-evidence/live-worker-e2e`
- 验证:live-worker-e2e 本轮真实运行后新目录产出 `test-evidence/live-worker-e2e/live-worker-e2e.log`,`git diff HEAD -- p0-accept/ p0-mvp/f1 p0-mvp/f2` **空(零触碰)**;历史证据文件原样保留不动。

## ③ SIGKILL 孤儿进程与清理边界核查(只读审计)

- 机制:Run 容器 `docker run --rm -i`(src/runtime/sandbox.ts:220)——父进程 SIGKILL ⇒ stdin 管道 EOF ⇒ 容器内 pi 退出 ⇒ `--rm` 自清理;容器按 runDir basename 可寻址(测试注入 docker kill 的断连实验即用此);有序路径 `cleanupSandbox()`(safeRm 哨兵守卫)。
- 残余风险(如实):父进程被 SIGKILL 且 pi 恰在忽略 EOF 的长工具调用中 ⇒ 容器暂留至自然结束;可经 `docker ps` 观察、按名 `docker kill` 兜底。**现网核查:零 relay 孤儿进程、零残留测试容器**(仅 `relay-p000-pg` 正常服务);VM 上 46 天龄 `node src/index.js` 为无关项目进程,非本仓库产物。未发现需改代码的缺陷;保持最小垂直切片不改。

## ④ CURRENT/能力登记表/SHA 口径一致性

- 登记表核对:`src/server/capabilities.ts` `delivery.github.real=VERIFIED`(与 R-1 闭环/矩阵一致)、`decision.d3.auto_approve=NOT_IMPLEMENTED`(与"D3 永不自动批准"一致)、`worker.model` 按 workerMode 动态 ✓。
- 修复:第 15 行 VERIFIED 注释带 BLOCKED 行残尾(d75ee9d 注释修正的漏网处)——注释去重,零行为变更(本轮唯一 src 触碰,如实声明)。
- SHA 口径:全库扫描 `d75ee9d/247afca/a8adcab` 引用均在**历史记录**语境(REPORT-final 提交链/REVIEW 亲验记录/矩阵演进链),无"过期当现势"误用;矩阵演进链在本轮(第一包)收官时按惯例追加新 SHA。

## ⑤ skip-worktree 使用与解除复核

- 全库 `git ls-files -v` 核对:**仅** `p0-mvp/soak-24h/samples.csv`+`worker.log` 两文件带 S 标(观测产物中间态防误提交),其余全 H——无被掩盖的真实改动。
- 解除程序(第一包收官执行):`git update-index --no-skip-worktree <两文件>` → 终版内容以正常 modified 面入库;解除前后 `git status` 对比留痕于第一包收官提交信息。

## ⑥ 定向回归与披露

- `npx tsc --noEmit`:0 错误。
- `npx vitest run test/unit/capabilities.test.ts`(5/5 绿)+ f1/f2(无门控 skip 2+2)+ live-worker-e2e + github-real(终态 4+1skip)。
- **披露(如实)**:live-worker-e2e 三重门控在本机全开(magpie+docker+iptables)⇒ 定向回归触发了 **A-4 既定授权实验真实运行 1 次**(33.5s,DELIVERED;非 F1/F2 对照实验)。消耗实证:magpie 路由日志本次运行总窗(06:59:46~07:00:08)**5 次 `zcode:200` 上游调用**(Minor-p4-1 口径对齐:此前按命名窗 06:59:57~07:00:08 计 3 次系窗口取窄;按"每运行=上游调用数"口径为准);测试 schema 随 afterAll 清理故常设账本零变动(历史累计 used≈6+本次=7 次运行,limit=8 未触及,`r2-failure-analysis.md` §4 义务条款)。
- **零 F1/F2 对照消耗**:`RELAY_F1_E2E/F2_E2E` 未置位,两测试 skip;替代模型授权仍未到位,零对照实验运行。

## ⑦ 遗留补充(用户指令 2026-11-12 07:32;合同 c6b3e4e)

- **账本与上游请求对账(三.3)**:第一手证据 `test-evidence/live-worker-e2e/live-worker-e2e.log`:`ledger model_calls used=5 limit=8 reserved=0` == magpie 路由日志同运行窗 **5 次** `zcode:200` 上游调用——**1:1 吻合**。口径钉死:**测试次数(1 次运行)≠ 模型请求次数(5 次)**;`limit=8` 为**每 Goal** 的 model_calls 上限(coder 预留 4+reviewer 预留 4,goal 随测试 schema 清理),非终身实验配额——此前"累计 used≈7"表述作废,各历史 A-4 运行各有独立 goal 账本。
- **显式模型调用门禁(三.2)**:`live-worker-e2e`(RELAY_A4_E2E)/`gate-e2e`(RELAY_GATE_E2E)/`egress-proxy`(RELAY_EGRESS_E2E)三测试在基础设施门(provider/docker/iptables)之上增加显式 env 门——本机三重门全开时**不再自动执行真模型**;"零模型定向回归"默认零模型。验证:无 env 回归 3 文件 8 测试全 skip(3.7s;此前同命令意外真实运行 33.5s);`npx tsc --noEmit` 0 错;CONTINUATION 门控清单已同步。
- 07:00 A-4 意外运行的教训根因:三重基础设施门≠授权门;授权面在合同(用户),门禁在 env。

## 结论

第四包六项全部完成/核查完毕;github-real 夹具现为"每轮唯一载荷→正常快进→历史只增"可重跑形态;模型测试证据面与已跟踪目录完全解耦。独立 Reviewer 复核见 REVIEW-r1-closure.md 追加节(随收官提交)。
