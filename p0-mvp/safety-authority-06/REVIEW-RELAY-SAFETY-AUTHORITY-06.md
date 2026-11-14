# RELAY-SAFETY-AUTHORITY-06 独立 Reviewer 复核记录

> 本文件为独立 Reviewer（隔离上下文冷启动）两阶段复核报告的**原文入库**：第一部分=A 项预检修复独立检查（两轮:REWORK→PASS,合同顺序门）;第二部分=整包终裁（代码+文档+证据+不变量）。实现者未改写 Reviewer 原文;Minor-1~3 的消化记录见文末实现者附注。

## 第一部分：A 项独立复核（第一轮:REWORK,1 Major）

### 裁决：**REWORK**（1 Major，仅 Runbook 一行命令示例；代码修复本身真实、完备、无越界，四项判据全部亲测满足）

**Major（阻断）**

**Major-1：deploy/README-deploy.md §0 新增命令示例中 `XDG_RUNTIME_DIR` 值错误，照抄必失败，文档化复检路径不可用**

- 位置：`deploy/README-deploy.md` 第 54 行：`env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID/bus XDG_RUNTIME_DIR=/run/user/$UID/bus node deploy/preflight.ts`
- 亲测反例（逐字照抄 Runbook 示例，$UID=1000 展开）：
  - `env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_RUNTIME_DIR=/run/user/1000/bus systemctl --user show relay-web.service -p ActiveState` ⇒ `Failed to connect to user scope bus via local transport: Not a directory`，EXIT=1
  - 同 env 跑完整 `node deploy/preflight.ts` ⇒ svc 两项仍 `NOT_RUN 无法查询(...Not a directory)`——操作者照 Runbook 复检永远无法到达文档所声称的"显式 bus ⇒ svc PASS(pid/since 可读)"状态
- 正确值（实测有效，与本次两环境实测所用一致）：`XDG_RUNTIME_DIR=/run/user/1000`（不带 `/bus` 后缀）⇒ EXIT=0、ActiveState=active、完整 preflight svc 两项 PASS(pid=3242781/3242782)
- 附带核验：preflight 工具内 NOT_RUN 提示语本身正确——仅设 `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`（unset XDG_RUNTIME_DIR）实测 svc 两项 PASS，端到端可用
- 定级理由：该命令块是本次 Major 反例的唯一文档化补救路径，且位于生产切换 Runbook §0 入口；示例与同段"实测对照"声明自相矛盾（实测用的不是示例里的命令）。修复量 = 一行。

**Minor（登记不阻断）**

- Minor-1：preflight.ts NOT_RUN detail 提示语只提 `DBUS_SESSION_BUS_ADDRESS`（亲测可用，不算错误）；建议后续在文案中补 `XDG_RUNTIME_DIR=/run/user/$UID` 更规范（部分工具只认 XDG_RUNTIME_DIR）。不阻断。

**判据 1/2/3/4 逐条判定**

- **判据 1（PASS 必须全部可靠读取且真实匹配）— 满足。** 自建 /tmp 注入探针（不依赖实现者测试桩，14 组）：a) 双单元 queryable:false ⇒ svc NOT_RUN+process_vs_head UNKNOWN"缺读取依据"；b1) sinceIso:null / b2) sinceIso:"not-a-time" ⇒ svc PASS 但 process_vs_head UNKNOWN"启动时间未能读取"；c) active:false ⇒ svc FAIL+UNKNOWN"无进程可比对"；d/l) 全部可读且严格晚于 HEAD（含 HEAD+1s 边界）⇒ 唯一 PASS 路径；e) 同秒（== HEAD）⇒ UNKNOWN"早于/等于"（`<=` 歧义保护）；m) HEAD-1s ⇒ UNKNOWN 旧代码；附加 g) 探针缺 worker 单元、h) commitTimeIso 不可解析、i) gitHead.ok=false、j/k) 混合部分可读 ⇒ 全部不 PASS。无任何旁路。
- **判据 2（探针异常="无法查询"，不虚构"未运行"）— 满足。** 探针 a 组：svc detail=`无法查询 systemd user bus(Failed to connect...)$DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined`（真实 stderr 原文含 reason 字段）；VM80 无 bus 实跑同样输出完整真实原因。旧实现（`git show a142935:deploy/preflight.ts`）确将 `!r.ok` 折叠为 `active:false` ⇒ 虚构"未运行"FAIL，根因属实。
- **判据 3（GO fail-closed）— 满足。** 探针 f 组：gitHead dirtyReadable:false ⇒ git_head=NOT_RUN"未能读取被跟踪树状态...fail-closed 不假 clean"，verdict=UNKNOWN 非 GO；探针 h/i：HEAD 时间不可读 ⇒ process_vs_head=NOT_RUN。旧实现确为 `dirty.ok && dirty.out.length>0`（假 clean 折叠）+ 空 stale⇒PASS（双重虚构），与红态日志 7 failed（R1-R5/R9/R10）一致。
- **判据 4（CST 缩写不改挂钟语义）— 满足。** node --input-type=module 三时区亲测 parseSystemdSinceIso：TZ=Asia/Shanghai/UTC/America/Chicago 下 `"Fri 2026-11-13 02:00:08 CST"` ≡ 无缩写 ≡ `new Date("2026-11-13T02:00:08").toISOString()`（Shanghai ⇒ 2026-11-12T18:00:08.000Z，与生产 ps 启动时刻 02:00:08+08 精确对应）；`""`/`"garbage"`/仅日期 ⇒ null；尾随空白容忍。缩写陷阱实证：Node Date.parse 把 CST 当 UTC-6、GNU date(TZ=Shanghai) 当 +16h——修复剥离缩写后完全绕开。

**必做清单其余各项**

- 清单 2（VM80 两环境实测）：无 bus ⇒ svc 两项 NOT_RUN"无法查询"+真实原因、process_vs_head UNKNOWN、EXIT=2；显式 bus ⇒ svc PASS(pid=3242781/3242782，since=2026-11-12T18:00:08.000Z)+process_vs_head UNKNOWN"旧代码"（2026-11-14T09:45:39+08:00 为 a142935 真实提交时间，亲测 `git show -s`）。ss/ps/systemctl 三方实证：pid 3242781=`node src/server/index.ts`（持有 10.30.5.80:8787 监听）、3242782=`node src/worker-entry.ts`，均 Fri Nov 13 02:00:08 2026 启动、systemd ExecMainStartTimestamp=`Fri 2026-11-13 02:00:08 CST`——无 bus 会话中"未运行"误报的反例确属真实，修复后两环境行为正确。
- 清单 5：`npx vitest run test/integration/deploy-preflight.test.ts` ⇒ **16/16 全绿**（6 旧 + R1-R10，实测复跑非转录）。
- 清单 6（边界合规）：`git status --porcelain` 仅 3 个修改文件（deploy/preflight.ts、deploy/README-deploy.md、test/integration/deploy-preflight.test.ts）+ 3 个既有未跟踪目录；`git diff a142935 --stat` 全仓库仅这 3 文件（297+/31-），**零 src/ 改动**；`find config p0-mvp/soak-r3b -newermt '2026-11-14 00:00'` 为空（今日零触碰）；全部操作只读或 /tmp 隔离，零重启/零写入/零网络外联。

## 第二部分：A 项收口复核（第二轮:**PASS**）

只核两处变更（Major-1 修复+Minor-1 采纳），亲测确认：

- **Major-1 修复确认**：`deploy/README-deploy.md` 示例现为 `env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID/bus XDG_RUNTIME_DIR=/run/user/$UID node deploy/preflight.ts`（`/bus` 后缀已去除）。亲测（$UID=1000 逐字展开）⇒ `svc_relay-web.service PASS(pid=3242781, since=2026-11-12T18:00:08.000Z)`、`svc_relay-worker.service PASS(pid=3242782)`、`process_vs_head UNKNOWN"旧代码"`（如实）——照抄文档命令即可到达文档所声称的状态，Major-1 闭合。
- **Minor-1 采纳确认**：`deploy/preflight.ts` svc NOT_RUN detail 现含 `…可显式 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID/bus 且 XDG_RUNTIME_DIR=/run/user/$UID 后复检`。纯文案，逻辑未动。
- 无新问题：`git diff a142935 --stat` 与上轮复核逐字节一致（本轮改动纯行内字符串替换）；快速回归 vitest 16/16 全绿；判据 1/2/3/4 此前已全部亲测满足，本轮改动不触及任何判据路径。
- **最终裁决：PASS**（0 Major，0 新增 Minor）。A 项复核收口：修复真实、完备、fail-closed、无越界；文档化复检路径照抄可用；边界合规。

## 第三部分：整包终裁（**PASS**，0 Major；Minor-3 项登记不阻断）

（隔离上下文冷启动，全程亲测。）

### 冷启动挑战结论：**通过**

仅凭 README.md（"唯一当前开发合同见 CURRENT.md"）→ AGENTS.md（权威顺序/写入授权规则）→ CURRENT.md 顶部，定位唯一 ACTIVE=**RELAY-SAFETY-AUTHORITY-06（2026-11-14，最低祖先 a12a5a7）**，验收面 A-E 与实际变更面完全吻合。HEAD=a142935 为合同登记提交，实现以工作区未提交 diff 存在（26 修改+3 未跟踪），与合同"每包 ACTIVE 合同先于实现提交"纪律一致。

### Minor（登记，不阻断）

1. **DELIVERY.md L46 句子重复**：新文本中"机器测试证据以实际命令、退出结果、候选 SHA、环境指纹为准；必需测试未执行、跳过或失败不能视为 PASS。"连续出现两次（编辑拆句残留）。语义零丢失，单行可修。
2. **EXTERNAL_PATTERN_COMPARISON 汇总计数不一致**：该文"裁决汇总"称"DEFER=3 项"但随后列出 4 项（多 Runtime/按需手册/MCP 身份/空闲休眠）；REPORT §4 与 P0_P1_ROADMAP 均记 DEFER=4。实体清单各处一致，仅该处计数错。
3. **CURRENT.md ACTIVE 合同"原文保留"有字节级偏差**：A/B/D 三行中文弯引号""被规范化为直引号（diff 亲测，语义零变化）。与 REPORT §5"ACTIVE 合同(原文保留)"的精确声称不符，建议回填弯引号或弱化措辞。

**未验证项（非缺陷）**：REPORT §1/§6 的 exact-head CI 43542514450@a142935 双 job success 声称——Reviewer 受网络外联禁令无法独立复核，登记为未验证（当前实现尚未提交，不存在对其的 CI 声称）。

### 合同 A-E 逐项判定

**A 预检误判修复：满足**
- 四判据源码亲审（`git diff a142935 -- deploy/preflight.ts`）：①PASS 唯一路径=两目标单元 queryable+active+sinceIso 可解析且严格晚于 HEAD，`<=` 同秒归 stale→UNKNOWN；②探针失败 `queryable:false`+真实 reason→NOT_RUN"无法查询"（非"未运行"）；③`dirtyReadable:false`→git_head NOT_RUN fail-closed；④`parseSystemdSinceIso` 剥星期/缩写按本机时区解析。
- 自建 /tmp 注入探针 25 项全过：**12 场景**含指定三反例——web 可读+worker 无法查询⇒process_vs_head 不 PASS+svc NOT_RUN"无法查询"+verdict UNKNOWN；HEAD+1s⇒PASS；HEAD-1s⇒UNKNOWN；另含同秒/单元缺失/混合/stale 第三单元/非法时间等 9 场景；**8 组解析反例**（CST 剥离=无缩写挂钟=本机时区语义，本机 Asia/Shanghai 下 `Fri 2026-11-13 02:00:08 CST`→`2026-11-12T18:00:08Z` 与 05 报告实测一致）；**5 组 computeVerdict 不变量**。
- 两环境亲测：无 bus ⇒ svc 两项 NOT_RUN"无法查询"+process_vs_head UNKNOWN，**无 05 版双重虚构**；显式 bus ⇒ svc PASS(pid=3242781/3242782,since=2026-11-12T18:00:08.000Z)+process_vs_head UNKNOWN"旧代码"。两环境均 NO-GO 由真实迁移缺失主导（诚实）。
- 定向测试（仅授权两文件）：**22/22 绿**（deploy-preflight 16=6 旧+10 新 R1-R10；worker-evidence-checks 6）。测试后 docker/systemctl 复查：服务仍 active、egress 栈状态不变、PG 容器未动。
- 红态证据真实：red-phase-before-fix.log 7 红 3 绿，R10 红=TypeError"parseSystemdSinceIso is not a function"（函数当时不存在）、R1 红=expected FAIL to be NOT_RUN——与旧代码语义逐点吻合。

**B 文档审计矩阵：满足**
- 矩阵与修改面完全吻合：CORRECT/REVALIDATE 全部在 diff 清单；KEEP 抽 9 个（README/PRD/DOMAIN_MODEL/OPERATIONS/SECURITY_MODEL/PI_WEB_REFERENCE/MODEL_POLICY/CONSTRUCTION_PLAN/AUTOLOOP）全部 `git diff --quiet` 零改动。
- 重点四项全部属实：①CONTRACTS.md L22"已实现"=migrations/0008/0009 存在+`p0-mvp/control-ready-03/` 证据+授权测试存在，且含"线上以重启为界"限定（与实测旧进程一致）；②DELIVERY.md 三级入口=package.json+scripts/quality.mjs 存在；③WEB_UX_03_ARCHITECTURE 迁移引用 0003→0002 修正属实（0002_tricky_roulette.sql L15 含 goal_id，0003 不含）；L114-115 重复行已删；④FINAL_AUDIT 头部"历史快照"+L43 时点标注落地。另抽 ARCH_BASELINE/INTEGRATIONS（DBOS OPEN→ADR-0007 REJECT）/UI_UX/WEB_UX_03_CONTRACT 阶段表/GOAL_FEED 偏离登记——均与代码事实相符（api.ts L13 注释"游标=消息 id；快照整体替换"逐字吻合）。

**C 四项目借鉴裁决：满足（零实施）**
- 三项 NO-CHANGE 到代码实证：`src/core/intents.ts` 两阶段+三分支 Reconcile+idempotency_key；`src/core/lease.ts` fencing_token 单调递增（L139-146）；`web/app.js` 轮询可见 8s/后台 30s（L380-392）。
- POC 池仅登记：P0_P1_ROADMAP「POC 候选池」节注明"全部未实施"；全仓 diff 零 src/ 文件——零移植、零新依赖属实。许可证边界已注明。

**D 纠偏与压缩：满足**
- 体积声称精确：CURRENT.md 75946→12220 字节、CONTINUATION.md 70837→6053 字节。
- 8 个历史事实抽查全部可追溯：WEB-UX-01 终裁（新 CURRENT 索引行）、R-3 缝 365s（基线终账）、Minor-PF-1~5（登记指针→05 报告 §9）、R-2 四参数（指针报告 p0-mvp/r2-contrast/REPORT-r2-contrast.md L3 原文）、门控 env 清单/ssh:443/safeRm 教训/setsid（新 CONTINUATION 运行环境节全文保留）、口令轮换（经声明归档路径 git 历史完整可查）。未创建第二状态文件、无物理改名。

**E Reviewer/测试/CI 收口：满足**
- 本报告即独立 Reviewer 亲测（冷启动+全项亲审）；REPORT §7 整包节留空待回填=预期（不预写）。quality:quick 证据 PASS，与 quality.mjs 步骤定义一致（quick=lint+format+typecheck+单测）；full/release 本地 NOT_RUN 与合同 egress 保护硬约束一致（full 含 integration+browser，teardownEgress 风险真实）。

### 硬禁令逐条核对

| 禁令 | 结论 | 证据 |
|---|---|---|
| 零生产迁移 0008/0009 | ✓ | 亲测 preflight：迁移缺失 FAIL 依旧（未补） |
| 零生产 DB/env/口令写入 | ✓ | preflight 全程只读；--json 无凭据值/连接串 |
| 零 restart/stop/reload | ✓ | 全会话服务 PID/启动时间恒定（3242781/3242782@2026-11-13 02:00:08 CST） |
| 零模型调用 | ✓ | 测试全桩/门控 |
| 零远端写入/网络改造 | ✓ | Reviewer 自身零网络操作；diff 无远端相关变更 |
| 零分支/强推 | ✓ | 仅 main，单 worktree，无 stash |
| 零触碰 config/ 与 soak-r3b/ | ✓ | `find config p0-mvp/soak-r3b -newermt '2026-11-14 00:00'` 为空 |
| 零改 Core/Gate/Policy | ✓ | 全仓 diff 零 src/、零 web/、零 migrations/ 文件 |
| 零移植外部源码 | ✓ | C 项纯裁决登记，无新代码 |

### 不变量

computeVerdict 纯函数行为 5 组探针全过（FAIL 优先级/NOT_RUN→UNKNOWN/空集不假 GO）；preflight --json 脱敏亲测零泄漏（env 仅键名、DB 仅聚合）。

**终裁：PASS。** Minor-1~3 均为单行级修正，不阻断收口流程；CI 复核义务按合同由推送后 exact-head 双 job 承担。

---

## 实现者附注（Reviewer 原文之外，时序记录）

- Reviewer 整包终裁后，三项 Minor 已全部消化：Minor-1=DELIVERY.md 重复句已去重；Minor-2=EXTERNAL_PATTERN_COMPARISON DEFER 计数 3→4；Minor-3=CURRENT.md ACTIVE 合同块已恢复与 a142935 字节级一致（弯引号回填，`git diff a142935 -- CURRENT.md` 中 A/B/D 行已不再出现）。
- 消化后复跑：定向测试与 quality:quick 复跑绿（见 REPORT §6 最终证据）。
