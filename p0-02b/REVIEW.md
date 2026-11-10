# P0-02B 独立 REVIEW

- Reviewer:**全新上下文独立代理**(与 Coder 无共享会话;全程只读,零模型调用;53 次工具调用,亲测 4 组)
- 首轮复核对象:`aad67bd`(合同 `79187dd`,实现 `61139d5`);复核窗口内写者追加 `0207a6a`(CONSUMED 不可翻转加固)——Reviewer 对其 diff 逐行补审并以亲测覆盖(过程时序如实记录,见 F-6)
- 方法:冷启动读合同/报告 → 逐文件读实现 → 红队视角审凭据面(argv/env/错误文本/helper 侧信道)→ 逐断言读反例测试 → 亲跑 tsc/delivery+git-candidate/reviewer-readonly(容器)/egress-proxy(容器,G-3 inspect 断言)→ 以合同为绳找反例

## 一、首轮逐条核验(G-1..G-5 / D-1..D-10):全部 VERIFIED

| 条 | 裁决 | 一句依据 |
| --- | --- | --- |
| G-1 凭据面 | VERIFIED(机制) | 令牌仅存宿主 0600 原始文件+会话 0600 store;argv 只有 helper 声明与文件路径;env 最小集+`credential.helper=` 空重置+`HOME=/nonexistent`+`GIT_CONFIG_NOSYSTEM=1` 断侧信道;错误文本 redactCredentials 纵深脱敏;审计面无 token 字段;401/缺凭据红队注入均安全失败 |
| G-2 仓库白名单 | VERIFIED | 默认 `allowedRepos=[]` 全拒;大小写/尾随点/URL 编码/多余路径段均归一失败或精确失配;本地路径须白名单显式含(host 缺口见 F-3,由 store host 键兜底) |
| G-3 持钥 0600 化 | VERIFIED(亲测) | FWD_REAL_KEY env 注入面全仓废除;FWD_SCRIPT 只读挂载文件;非 0600 FAIL-CLOSED;亲测 egress-proxy 6/6 含 docker inspect 零 key 断言 |
| G-4 Reviewer FS 只读 | VERIFIED(亲测) | `:ro` 挂载+审计移 /pihome;亲测 2/2:读成功/写删 EROFS/宿主零写入/rw 对照组写成功 |
| G-5 仅 fast-forward | VERIFIED | 执行器无 force 面;前置核对漂移 ⇒ CONFLICT;git 非 fast-forward 双保险;反例4 亲测外来提交未覆盖 |
| D-1 三 SHA 区分 | VERIFIED | 三 git_* 列独立;两处断言两两不等 |
| D-2 候选 Commit | VERIFIED(偏差可接受) | stage 克隆独立对象副本→覆写候选→树==清单逐文件往返→refs/relay-candidates 防gc;失败清理无半成品(实测);偏差理由成立(run 目录证据采集后即删,链接 worktree 会消亡),隔离语义达成且存活性强于 worktree(base 语义弱化见 F-5,内容面被往返核验兜死) |
| D-3 绑定重核 | VERIFIED | Proposal 前核 commit 对象/树 sha/父 base;树 sha 即内容承诺;记录漂移 ⇒ 拒(反例6);绕过路径均需 DB 直写(超威胁模型) |
| D-4 Action Proposal | VERIFIED | 授权基础=已消费绑定 PASS(consumed_at 非空+四绑定对齐);无授权/非 ACCEPTED 双拒(实测) |
| D-5 Policy 默认拒绝 | VERIFIED | 七闸顺序裁决,逐项具体 reason;credential_missing ⇒ 0 intent 0 git(实测) |
| D-6 Intent 两阶段 | VERIFIED | 复用 intents;六要素齐备;幂等键与合同一致 |
| D-7 Scoped Executor | VERIFIED | check=ls-remote 真实头;perform 非 force;执行面仅白名单 main;执行前 check 抛错 ⇒ FAILED 安全失败(反例2b 远端零触碰) |
| D-8 DELIVERED 判定 | VERIFIED | 远端 HEAD==payload **且** fetch-by-sha 逐文件==候选清单双核对;写后核对不可达 ⇒ NEEDS_RECONCILE(覆盖面缺口 F-2 已修);allowAnySHA1InWant 为 fail-closed 供给(缺失 ⇒ 核验必败,不可能 DELIVERED;GitHub 默认支持按 SHA fetch,待 github-real 实证) |
| D-9 幂等 | VERIFIED(0207a6a) | UNIQUE+xmax 判 INSERT;CONSUMED no-op 不重推;F-1(CONSUMED 翻转)已由 0207a6a 修复并亲测 |
| D-10 审计 | VERIFIED | 全链审计动作 + append-only 触发器守卫;漂移 ⇒ CONFLICT+D3 |

## 二、反例核验(9 条):全部 VERIFIED(断言均为具体拒绝原因,非恒真)

1. 未授权仓库 ✅ repo_not_allowed + 按 task 过滤 0 intent + POLICY_DENIED 留痕
2. Token 缺失/不足 ✅ 2a credential_missing(0 intent);2b 本地 401 ⇒ FAILED、changeset 非 DELIVERED、远端头==base 零触碰
3. 未过 Gate ✅ no_gate_authorization + task_not_accepted 双分支均 0 intent
4. 漂移拒绝 ✅ 外部真实推进 ⇒ CONFLICT;六重断言(远端头==外来提交/changeset/D3 恰1/intent/任务 ACCEPTED)
5. 回执丢失 ✅ 真实 push 后抹回执 ⇒ SIDE_EFFECT_CONFIRMED ⇒ DELIVERED;远端提交数不变(非重推)
6. 内容不一致 ✅ tree_sha_drift + content_mismatch + 半成品清理
7. Reviewer 改候选 ✅ EROFS 实测输出+宿主侧不存在断言+候选原样+rw 对照组四层证据
8. 重复触发 ✅ 单 proposal/单 intent/远端提交数不变;0207a6a 增 CONSUMED 不可翻转断言
9. 远端提交失败 ✅ pre-receive 真拒 ⇒ FAILED 非 DELIVERED + DELIVERY_FAILED 审计

抽查 delivery.test.ts 三用例断言强度(正链六重/反例4 六重/反例8 五重)——达标,无恒真断言。

## 三、Reviewer 亲测结果

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **0 错误** |
| delivery + git-candidate | **16/16**(归属 0207a6a) |
| reviewer-readonly(容器) | **2/2**(真实 EROFS 输出) |
| egress-proxy(容器,加分项) | **6/6**(含 G-3 inspect 断言) |
| github-real / gate-e2e / pi-e2e | 未跑(凭据门/真实模型,遵守任务禁令) |
| REPORT 诚实性 | **如实**(用例账/修复清单/预算账/未解决项逐条对上代码,无夸大) |

## 四、发现清单(首轮)

| # | 级别 | 内容 |
| --- | --- | --- |
| F-1 | MINOR(已修) | aad67bd 上 proposeDelivery ON CONFLICT 无状态守卫:CONSUMED 可翻回 POLICY_APPROVED 且 expected 变化产生第二 intent(远端同 SHA push 无重复副作用,但违反 D-9 记录面语义)→ 0207a6a WHERE 守卫+幂等读回+审计+断言,亲测通过 |
| F-2 | MINOR(建议修) | executeDelivery 两处 `io.verifyRemoteContent` 无 try/catch(CONSUMED 恢复路径/写后核对):核验实现抛错会穿透(tick 中断、changeset 卡 DELIVERING,可经 reconcile 恢复);方向安全(绝不误标 DELIVERED)但与 REPORT §3.6 意图不完全一致;测试 io 包装层吞抛错故未暴露 |
| F-3 | OBSERVATION | normalizeRepoSlug 忽略 host:白名单 owner/repo 会放行任意 host 同 slug URL;store 的 host 键兜底(非 github.com 无凭据必败);建议 Policy 钉 host |
| F-4 | OBSERVATION | 含 userinfo 的 target URL 原样进 git argv(argv 泄露面);当前编排面不产生该形态;建议执行器入参拒绝 `://...@` 形 target |
| F-5 | OBSERVATION | runner baseCommitSha 事后从工作区 .git/HEAD 重探测而非比对 runs.input_commit_sha:模型 Run 中自行 commit 时 base_parent 防线弱化(内容面仍被往返核验兜死,无内容风险);建议与 runs.input_commit_sha 比对 |
| F-6 | OBSERVATION(过程) | (a) 0207a6a 提交发生在独立 REVIEW 落盘前(恰好处理复核任务书点名的面),Reviewer 已补审 diff+亲测,收尾须记录该时序;(b) 0207a6a 是 REPORT §3 之后第 10 个修复,REPORT 未及更新;(c) sandbox.ts/egress.ts 两处注释仍描述 G-3 前 env 机制,文档漂移 |
| F-7 | OBSERVATION | github-real 夹具 force-push 自清理:注释+REPORT 双声明为非 Relay 行为,限定清楚;Relay 链内确无 force 面。VERIFIED |

**首轮裁决:PASS-WITH-FIXES**(无令牌泄露路径、无 force 面、无未授权写路径、DELIVERED 不可能在未核对下成立;REPORT 如实;真实写入挂起为 G-1 门禁合规挂起而非违约)。收口条件:F-2 随收尾修复;REPORT 补记 0207a6a 并在最终 HEAD 重跑全量留证;F-3/F-4/F-5 排后续加固包。

## 五、处置(写者)

| # | 处置 |
| --- | --- |
| F-1 | **已修**(0207a6a,先于 REVIEW 落盘;Reviewer 已补审+亲测 16/16) |
| F-2 | **已修**(处置提交):CONSUMED 恢复路径与写后核对路径各补 try/catch ⇒ NEEDS_RECONCILE(结果不明先查真实状态;不误标 DELIVERED);专属测试:注入抛错核验 ⇒ NEEDS_RECONCILE、changeset 非 DELIVERED、reconcileDelivery 补 DELIVERED 且远端无重复推送(17/17 过) |
| F-3 | **声明保留+排后续**:host 钉扎属 Policy 加固(纵深已有 store host 键兜底);记入 CURRENT 遗留检查单 |
| F-4 | **声明保留+排后续**:执行器 target 入参校验(userinfo 形态)属纵深加固;同上 |
| F-5 | **声明保留+排后续**:base 与 runs.input_commit_sha 比对属语义加固;当前无内容风险(往返核验兜死);同上 |
| F-6 | **已办**:(a) 本节如实记录 0207a6a 时序(Reviewer 已补审+亲测覆盖);(b) REPORT §3 补第 10/11 条;(c) 两处陈旧注释已改为 G-3 现行机制描述 |
| F-7 | 无需处置(核验通过项) |

复验:处置提交后送 Reviewer 复验(见末尾)。

## 六、Reviewer 复验(处置提交后)

**复验对象**:处置提交(F-2 try/catch + 专属测试 + F-6 注释清理 + REPORT §3 补记 + 最终 HEAD 全量证据)。

(占位:待 Reviewer 实际复验后由其结论落盘,写者不得代写。)
