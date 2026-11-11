# R-1 闭环独立确认 Review(2026-11-12)

- Reviewer:独立确认 Reviewer(零采信;全程亲测,不引用执行方自述作为证据)
- 复核对象:live main `fb2693c`(完整 SHA `fb2693ca70edb9c5c6e3e76dbd7dde0940b4a13e`;CI `43072536591` 经 gh 只读核对 = success,headSha 与本 HEAD 一致)
- 本文件是本次复核的**唯一写动作**;仓库零其他改动,不 commit/push;工作区既有脏文件 `p0-accept/live-worker-e2e.log`(live worker 运行日志追加,9 行)如实登记、未触碰。
- 远端副作用声明:复核在**沙箱仓** `pwl1987/relay-delivery-sandbox` 上留有一条评审探针提交(`e52934f`,快进、无 force、唯一文件名);生产仓 `pwl1987/relay` 仅做过只读 GET 与零突变写权探针(见 §4),两个探针引用均已确认 404 未创建。

## 裁决

**R-1 闭环成立**(US-08/G6 BLOCKED→VERIFIED 的证据经独立复核充分,终判理由之一解除成立)。

保留事项(不推翻裁决,见 §6):夹具一次性语义与宿主网络抖动两项工程事实须登记。

## §1 亲测重跑(收口指令命令行,零采信)

命令:`env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy npx vitest run test/integration/github-real.test.ts`

**两次重跑均未复现 `4 passed + 1 skip`**,结果与根因如下(重跑日志存于 Reviewer 会话,未入仓库):

| 轮次 | 结果 | 失败点 | 根因(已钉死) |
| --- | --- | --- | --- |
| 重跑 #1(02:05) | 2 failed / 2 passed / 1 skipped | 用例 3:`executor_error:git ls-remote failed`(executor check 阶段);用例 4:`spawnSync git ETIMEDOUT`(外部写者 push) | 宿主→`github.com:443` **间歇性连接失败**(后续多次独立复现:手动探测中一次 `Failed to connect to github.com port 443 after 135245 ms`;同一时间窗内 curl 与 ls-remote 又可 2s 内成功)——网络抖动,非代码缺陷 |
| 重跑 #2(02:12) | 2 failed / 2 passed / 1 skipped | 用例 3:`git -c failed`(createCandidateCommit 内 commit,`git-candidate.ts:143`);用例 4:`git commit --quiet -m foreign` 失败(`test:435`)——两者 **stderr 均为 0 字节** | **夹具一次性语义**:载荷硬编码(`delivered.txt`="p0-02b real remote write"、`foreign.txt`="external writer was here"),而远端已含闭包跑写入的同名**同内容**文件 ⇒ 重跑时 apply 同内容 ⇒ `add -A` 后空暂存 ⇒ `commit` 退出 1,且 "nothing to commit" 走 stdout、被 `--quiet` 抑制 ⇒ 两个 git 封装(只回传 stderr)表现为静默失败。机制已最小复现(同内容覆盖后 `commit --quiet` → RC=1,stderr 0 字节,stdout 193 字节) |

始终执行的两用例(夹具自证、凭据门)两次全绿;凭据门 `CREDENTIAL_STATE mode=wellformed present=true apiStatus=200` 与闭包日志一致。

**判读**:该测试**对同一远端状态不可重跑**(非幂等):`4 passed + 1 skip` 仅当远端为空分支或不含本测试先前输出时可达。此缺陷**不否定**闭环跑,反而**交叉印证**其真实性——远端当前内容与闭包跑输出逐字节吻合(§2),若闭包跑未真实发生,重跑 #2 不会呈现该碰撞签名。重跑 #1 的失败窗口与宿主 egress 抖动吻合(闭包跑自身 01:43 全程 105s+14s 成功亦在此时间尺度内)。

## §2 独立 API 复核(全部亲自执行;令牌仅入环境变量,未打印)

对 `GET /repos/pwl1987/relay-delivery-sandbox`(细粒度 PAT):

- 仓库:private、default_branch=main、owner=pwl1987、`permissions.push=true` ——与 `r1-closure.md` 前核验一致。
- `GET /commits?per_page=10`(探针写入前,恰好 3 条,即全部历史):
  1. `a49f4317` — Relay Test,"base",无父(根提交)
  2. `175eb071` — Relay Candidate Builder,"relay: task t-gh-real attempt 1 (changeset cs-f7005744-7ea1-4caa-9674-6cd7ad3bf2b9)",父=`a49f4317`
  3. `0dbf08a9` — ext,"foreign",父=`175eb071`
  时间线 17:43:40Z → 17:44:40Z → 17:45:31Z,与闭包跑启动(01:43:38+0800)及日志内 `175eb07..0dbf08a HEAD -> main` 推进完全吻合;**历史形态 = base → relay 交付 → foreign 漂移,只增不减** ✓
- `GET /git/trees/0dbf08a9`:README.md、delivered.txt、foreign.txt、src.txt 四文件共存(交付产物与外来内容并存);内容核对:`delivered.txt`="p0-02b real remote write"、`foreign.txt`="external writer was here" ——与 `r1-closure.md` §独立复核及测试载荷逐字一致 ✓

## §3 Reviewer 独立真实写入探针(R-1 运行时能力的亲证)

以与夹具相同的最小 env(无代理变量、`HOME=/nonexistent`、credential.helper=store)亲自执行一次快进写:

- 写前远端头 `0dbf08a9` → 新提交 `e52934f`(文件 `reviewer-r1-probe-20261112.txt`,内容含 UTC 时间戳;提交者 Relay Reviewer;消息 "reviewer: independent R-1 write probe (no-force fast-forward)"),**全程无 force 标志**。
- `ls-remote` 写后头 == `e52934f`;API 复核:提交在顶、父=`0dbf08a9`;`GET /git/trees/e52934f` = README.md、delivered.txt、foreign.txt、reviewer-r1-probe-20261112.txt、src.txt。历史 3→4 **只增不减** ⇒ **真实 GitHub 写入能力在复核时点(HEAD fb2693c 代码面)再次成立** ✓
- 无 force/历史保护亲证:基于旧头 `0dbf08a9` 的无 force 再推送 → `! [rejected] HEAD -> main (fetch first)`,RC=1;API 复核历史链(base→relay→foreign→probe 父子关系)完好,远端头未被改写 ✓
- 无强推迹象(git log 面):本地 main=`fb2693c` 为本地 origin/main 跟踪引用(`2ae241a`)的快进后代(merge-base --is-ancestor 通过);本地 log 作者全部 `pwl1987`、时间连续、消息与各阶段语义吻合;沙箱远端历史父链逐一验证无分叉改写 ✓

## §4 边界复核(未触碰其他仓库/未扩大权限/未用宽权限 token)

- `git diff 2ae241a..fb2693c`:仅 6 文件——`p0-mvp/r1-closure.md`(新)、`p0-mvp/github-real-closure.log`(新)、`p0-mvp/final-coverage-matrix.md`(US-08/G6/真实交付三项状态+§5 理由 1 划线)、`src/server/capabilities.ts`(加 VERIFIED 态+delivery.github.real 翻转)、`test/unit/capabilities.test.ts`(同步)、`p0-accept/live-worker-e2e.log`(运行日志 +9)。**无凭据材料、无其他仓库路径、无权限扩张代码** ✓
- 夹具安全(亲读源码逐条确认,`test/integration/github-real.test.ts`):
  - 目标仓库硬编码 `SANDBOX_REPO="pwl1987/relay-delivery-sandbox"`(L33);`RELAY_DELIVERY_SANDBOX_REPO` 环境变量改指被显式断言拒绝(L140-141);生产仓清单 `FORBIDDEN_REPOS=["pwl1987/relay"]`,断言目标不在清单、不含 `pwl1987/relay/` 前缀(L143-145)——**env 不可改指、生产仓永不为目标** ✓
  - 自证用例对 本文件+`github-push.ts`+`git-push.ts` 可执行代码面断言无 `--force`/`--force-with-lease`;执行器 `perform` 注释"刻意非 force:远端若在核对后再次漂移,git 以非 fast-forward 拒绝(不覆盖)"(github-push.ts:83-84)✓
  - 凭据唯一来源 `~/.relay/credentials/github-sandbox-pat`(实测 0600/93 字节);经典令牌(ghp_/gho_/ghs_/ghu_)直接拒;绝不读 gh hosts.yml(自证断言)✓
  - 漂移实验外部写者为**普通快进** push(L437,无 force);git 子进程 env 全部最小化(测试 L126、执行器 L52-57、`gitEnv()` L304-311;`GIT_TERMINAL_PROMPT=0`、`HOME=/nonexistent`)✓
- **token 窄权判定(对照实验,物理零突变)**:`POST /git/refs` 携带必然非法的 SHA(授权失败 403 / 授权通过则 422 且对象不存在 ⇒ 引用物理不可能被创建):
  - 生产仓 `pwl1987/relay` → **403 "Resource not accessible by personal access token"**(无 Contents:write)
  - 沙箱仓(对照,已知有写权)→ **422 "Object does not exist"**(授权通过、验证拒绝)
  - ⇒ **token 写权限确仅覆盖沙箱仓**;`GET /repos/pwl1987/relay` 返回的 `permissions{admin,push:true}` 为**资源所有者角色回显**,不代表 token 授权(本次实证澄清,避免后续误读);两仓探针引用 `__reviewer_probe_never_created__` 事后均 404(零突变确认)✓
  - 附:Actions 控制探针(sandbox 403 / relay 200)仅反映公私仓可读性差异,对写权无信息量——如实记录,不作为判据。
- 生产仓在本复核中的全部交互:只读 GET(repo/contents/actions/commits)+ 上述零突变探针;**未发生任何对 `pwl1987/relay` 的写操作** ✓

## §5 对终判的确认

- `p0-mvp/final-coverage-matrix.md` §1/§3/§4:US-08、G6、真实 GitHub 交付三项 BLOCKED→VERIFIED(2026-11-12,R-1 闭环)——证据链(闭包日志+本文 §2/§3/§4 独立再证)**充分**,升级成立。
- §5 终判:**REWORK 维持**口径一致;理由 1(US-08/G6)划线解除成立;剩余理由:
  - **R-2**:F1/F2 真模型业务交付 PARTIAL(机制面 VERIFIED,magpie 能力不足以稳定通过业务级机判;需更强模型路由,用户授权后重跑门控测试即闭环)——仍待解除 ✓
  - **R-3**:24h 长稳观察未满(真实计时;未满不判 PASS)——仍待解除 ✓
- 即:终判理由由 1+2+3 收敛为 **R-2/R-3 两项**,与执行方口径一致,本 Review 确认。

## §6 保留事项与登记(不推翻裁决)

1. **夹具一次性语义(工程缺陷,建议后续修复)**:`test/integration/github-real.test.ts` 载荷硬编码导致远端一旦含有其先前输出即不可重跑(§1 根因)。建议后续把载荷改为每轮唯一(时间戳/UUID)或显式接受"每轮净增 2 提交"的语义;修复前,该文件的回归结论只能在净空远端状态上取得。
2. **宿主 egress 抖动(运维事实)**:宿主→github.com:443 存在间歇性连接失败(重跑 #1 及本复核多窗口复现);github-real 类测试失败须先区分网络抖动与真实缺陷(与闭包文档"代理变量净化环境"教训并列登记)。
3. **CURRENT.md 治理留痕滞后**:`CURRENT.md` 仍停留在 CLOSE-PACK 口径(基线事实写 "R-1 PAT 仍未授权/保持 BLOCKED";脏区清单未含 `p0-accept/live-worker-e2e.log` 追加)。fb2693c 未按规则 7 同步更新 CURRENT.md/CONTINUATION.md——属写者收尾欠账,须下轮由写者补正(本 Review 零代改)。
4. `src/server/capabilities.ts` VERIFIED 枚举行注释尾缀复述了 BLOCKED 的注释文字(纯注释瑕疵,不影响行为)。
5. 闭包日志与本复核两轮重跑中均出现 vitest `Unhandled Error: [vitest-worker]: Timeout calling "onTaskUpdate"` ——vitest RPC 基建噪音,闭包跑在出现该错误的同一轮取得 4 passed,与测试结果无因果(如实登记)。

## 结论

- **R-1 闭环成立**:真实写入(执行方闭包跑 + Reviewer 亲测探针双证)、漂移拒绝、历史只增不减、无强推、夹具安全面、窄权 token、单一沙箱仓边界——全部经零采信独立复核通过。
- **终判确认**:REWORK 维持;解除项仅剩 **R-2(模型路由)** 与 **R-3(24h 观察)**。
- 复核 HEAD:`fb2693ca70edb9c5c6e3e76dbd7dde0940b4a13e`(CI 43072536591 success)。

## 附审:R-2/R-3 收口轮(2026-11-12;独立 Reviewer)

- Reviewer:独立 Reviewer(零采信;全部证据亲自执行/亲测,不引用执行方自述)。
- 复核时点:2026-11-12 06:22 CST;本地 HEAD=`8393ee3`(`8393ee309f4e68a1393fbcf49c02b583d86eec91`)。
- 本附审为本次复核**唯一写动作**;未 commit、未 push、未改动其他任何文件、未触碰 soak 两进程、未跑任何真模型调用、未跑全量 vitest。
- CI(gh 只读核对):`04acf94` → run `43109964724`(e2e+test 均 success);`8393ee3` → run `43110241076`(e2e success,**test in_progress**——复核时点尚未完成,如实记录)。
- 提交链亲验:`d75ee9d → 04acf94`(06:13:24+0800,仅 CURRENT.md,合同先行)→ `8393ee3`(06:15:15+0800,5 文件证据轮;`8393ee3^`==`04acf94` 亲证);`git diff d75ee9d..8393ee3` 逐文件审:**零代码变更、无凭据材料、无越权改动**(全部为文档+一份核验快照 JSON);远端 main 经 `GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand=none" git ls-remote` 亲验 == `8393ee3`,两笔均已推送 live。

### A~F 逐项复核结果

| 项 | 执行方主张 | 复核结果 | 关键亲测证据 |
| --- | --- | --- | --- |
| A | 授权参数缺失⇒只出待授权清单,零真模型运行,PARTIAL | **确认** | 清单四项(替代模型/预算/超时/凭据来源)逐一齐备且缺省建议均标注"须用户确认";§2 为"**授权后**即刻可执行"、§3"授权到位后按 §2 执行"——无未授权即跑安排;预算账本全 schema 扫描零 11-12 变动;DB 全 schema runs/discoveries 零 11-12 新增行;`/tmp` 11-12 05:00 后零试验残留 |
| B | 06:05+0800 会话解体 SIGTERM 波及两采集进程 | **确认** | `worker.log` 行 3010-3011 `SIGTERM received;graceful stop…`+`stopped`(最后 tick 22:05:08.614Z);SIGTERM 全 log 仅 1 次;dmesg/`journalctl -k`/kern.log 三源零 OOM;无 `soak-final.json`;末样本 45100s alive=yes;`alive=no` 计数=0 ⇒ 采样器同波及推论成立 |
| C | 06:10 按原始口径续采,setsid 脱离会话,起点不重置,缝 365s 落账 | **确认** | PID 810994(node worker-entry.ts)/811916(sample.sh)存活,etime 09:53/09:19(≈06:10 启动);`/proc/810994/environ` 亲读:`RELAY_DB_SCHEMA=soak24h`+`RELAY_WORKER_ID=soak-worker`+`RELAY_WORKER_INTERVAL_MS=15000`,RELAY_PI_* 计数=0;两进程 PGID=SID=自身且 PPID=`systemd --user`(完全脱离会话);`start-epoch` 内容 1794389572、mtime=2026-11-11 17:32:52.942+0800(未被改写);pid 文件与实际进程一致;旧 banner pid=3624561(行 1)仍在+新 banner pid=810994(行 3012),日志只追加;CSV 缝两侧行 45100→45465=365s 如实 |
| D | 中期快照:未满+缝 1 条+pg 2 行历史痕迹+RSS 峰<400000+tick 全 IDLE 零领取 | **确认** | 我亲自重跑 `node deploy/soak-verify.mjs …` 输出与快照 JSON **硬异常结构完全一致**(gaps 恰 1 条 365s+pgAnomalies 2+RSS 峰 312936<400000+hardErrors 恰 2 项+claimedTasks 零+errorTicks 零),差异仅时间推进字段(elapsed 46007>45526/samples 761>753/tick 3049>3017);pg 2 行=CSV 头两行 `pg_conns=-` 亲证,与 REVIEW-stage-e §3②"首实例 docker exec 未通"记载吻合;RSS 峰 312936 独立 awk 复算=312936(恰来自首两拍,亦亲证) |
| E | 期满点 2026-11-12 17:32:52+0800;缝在⇒终验 PARTIAL;REWORK 维持 | **确认** | `date` 换算亲验:1794389572=2026-11-11 17:32:52 CST,+86400=2026-11-12 17:32:52 CST ✓;grep 全部相关文档:所有 PASS/业务负载/ACCEPTED 命中处均为禁令语境("不得改 PASS"/"不得称业务负载稳定性"/"不得 ACCEPTED"),无一处正向宣称 |
| F | 矩阵/CONTINUATION 同步+教训入库;未跑全量 vitest,定向 9 例合成 | **确认** | `git diff d75ee9d..8393ee3` 亲读:矩阵 G7/长稳24h/§5 行与事实逐字同步;CONTINUATION 新增"长跑任务必须脱离会话进程组"教训;未跑全量 vitest 的旁证=预算账本零变动+A-4 零消耗迹象;`npx vitest run test/unit/soak-verify.test.ts` 我亲跑 **9/9 绿** |

### 证伪尝试记录(R-2/R-3,均未成功证伪)

- **R-2 三路证伪全落空**:①预算账本——`budget_ledger` 全 schema(22 个)逐个 count/max(updated_at)/max(used),最新更新 2026-11-11 10:41 UTC(p01a_review_f_cli_r28bt5),零 11-12 变动;②DB 足迹——全部 22 个 schema 的 runs/discoveries 行数与最新 started_at,零 11-12 新增(soak24h.runs 唯一 1 行=11-11 09:36 UTC soak worker 自身长跑行,ended_at 空,非模型调用);③/tmp——`find -newermt "2026-11-12 05:00"` 仅 ssh/zcode/orca 基础设施条目。清单引用的 `r2-failure-analysis.md` §3(对照实验设计,标注"待授权后执行;本包零执行")存在,引用有效。
- **R-3 钉死中断与续采两面**:中断面——SIGTERM 时间戳/零 OOM 三源/无 final 文件/alive 全 yes 四点互证,排除"worker 崩溃自写 final"与 OOM 两种替代解释;续采面——env 逐项亲读/进程组亲查/起点 mtime 亲查/pid 三方一致(进程↔pid 文件↔banner)/schema 存在亲查,无一处与声明不符;核验器重跑+9 例回归亲跑构成独立数值验证。

### 发现问题(无 Major)

- **Minor-m1**:文档数字与同笔提交证据文件存在 ±2 偏差——`r1-closure.md` 附记与 `final-coverage-matrix.md` 写"**3015** 拍全 IDLE_PROVIDER_DOWN",而同笔提交的权威快照 `verify-interim-20261112T0613+0800.json` 为 **3017**。差 2 tick=30s,系执行方生成文档文本与生成 JSON 两次核验器运行之间的时间差;不影响判定方向(两侧口径均为零领取、全 IDLE_PROVIDER_DOWN),数值应以 JSON 为准。建议下轮文档引用直接取自快照 JSON。
- **观察 O-1(历史,非本轮)**:提交 `1b55400`/`968cad0` 曾将 samples.csv/worker.log 中间态(+23/+44 与 +93/+176 行)入库——发生在 f6c6dd7 的 Major-M2 修复(skip-worktree 登记)之前,属已收口的既往问题;本轮两提交对两文件零触碰(`git ls-files -v` 亲验两文件均为 S 标记)。
- **观察 O-2(pid 文件处置评估)**:工作区仅剩 `sampler.pid`/`worker.pid` 两 modified(3627722→811916、WORKER_PID=3624561→WORKER_PID=810994),diff 与进程实况一致,无 untracked、无其他脏文件。执行方声明"随终提交入库"——**处置得当**:pid 文件是"期满时点进程身份"证据链一环,与 samples.csv/worker.log 终版同批入库可固定证据;但须确保入库时点与终验绑定且注明对应时点,避免与后续进程状态再漂移产生失真。

### 裁决

**确认执行方裁决成立**:①R-2 待授权清单是本轮授权参数缺失下的正确且唯一动作,零真模型运行经三路独立证伪未成立,不伪造结果;②R-3 中断取证完整、续采保真逐项吻合、缝 365s 如实落账;③存在中断缝 ⇒ 期满终验(2026-11-12 17:32:52+0800)按"缺失样本或中断时保持 PARTIAL"执行——**R-3 终验口径 PARTIAL 确认**;④R-2 PARTIAL + R-3 PARTIAL ⇒ **MVP 终判 REWORK 维持,不提前 ACCEPTED——确认**;⑤"24h=空闲稳定性"口径处处一致——确认。

- 复核时点 HEAD:`8393ee309f4e68a1393fbcf49c02b583d86eec91`;CI:04acf94→43109964724 success / 8393ee3→43110241076 e2e success+test in_progress。
- 期终权威事实(供终验窗口直接引用):start-epoch=1794389572(未重置,mtime 原始);缝=45100→45465s(365s)唯一一条;两进程 810994/811916 detached 存活(PGID=SID=自身,PPID=systemd --user);RSS 峰 312936<400000;tick 全 IDLE_PROVIDER_DOWN 零领取;唯一 Minor=文档 3015 vs 快照 3017(±2 tick)。

## 附审:第四包 测试与治理小缺口(2026-11-12 独立 Reviewer)

- 复核身份:全新上下文独立 Reviewer,零采信、亲测为准;只读+仅本文件末尾追加;禁 push;仅运行零模型消耗面(`tsc --noEmit`/`capabilities` 单测),**未跑** github-real/live-worker-e2e/f1/f2/全量 vitest。
- 复核基线:HEAD `f8e0263`(第四包实施提交),合同 `b30a492`(CURRENT.md 第四包行);复核时点 **2026-11-12 07:13:12+0800**(`TZ=Asia/Shanghai date '+%F %T%z'` 亲取)。

### 亲测命令与关键输出摘录

1. `git show b30a492 --stat` → 仅 CURRENT.md(1 file changed,合同先行,边界在案)。
2. `git show f8e0263 --stat` → **恰 7 文件**:`.gitignore(+2)`、`src/server/capabilities.ts(1 mod)`、`p0-mvp/pack4-test-governance.md(+45)`、`test/integration/{f1-ux-journey,f2-bug-fix,live-worker-e2e}.test.ts(各 2 add/1 del)`、`test/integration/github-real.test.ts(7 add/4 del)`;61 insertions/8 deletions 与 hunk 逐一吻合;**无 p0-mvp/soak-24h/、无凭据材料、无 src/core|runtime 运行时语义文件**。
3. capabilities.ts 逐行审:唯一变更=第 15 行注释残尾删除,代码面 `| "VERIFIED"` 原样;python 注释剥离对比 `b30a492` vs `f8e0263`:剥离行注释后**逐字节相等(True)**——零行为变更钉死(块注释变体的差异经溯源仅为该行注释文本本身,非真实差异)。
4. `git status --porcelain` → 仅 `?? p0-mvp/soak-24h/final-runner.log`(未跟踪,第一包 §9 收尾处置面,非本包)。
5. github-real.test.ts 亲读:`RUN_TAG=randomUUID().slice(0,8)`(行 48);使用 4 处=行 355(delivered 载荷)/394(delivered 断言 `toContain` **唯一载荷全文**)/425(drift 载荷)/436(foreign.txt 载荷);行 42-43 FORCE_FLAG/FORCE_LEASE_FLAG 片段拼接构造 + 行 139-140 对本文件与两执行器 stripComments 后 includes 自证断言**原样完好**;行 153 gh hosts 自查、行 146-148 目标固定断言完好;新增行零 force 字样。
6. 证据重定向:f1:29/f2:30/lw-e2e:49 均指 `test-evidence/`;`.gitignore:4=test-evidence/`;`git diff HEAD --stat -- p0-accept p0-mvp/f1 p0-mvp/f2` **空**;`git check-ignore -v test-evidence/x` 命中 `.gitignore:4`(exit 0);mtime 亲查:p0-accept 最新 11-11 11:09、p0-mvp/f1 11-11 16:26、p0-mvp/f2 11-11 16:28 —— **11-12 零写入**;test-evidence/ 仅 live-worker-e2e/live-worker-e2e.log(06:59→07:00)。
7. 沙箱仓只读 API(`curl --noproxy '*'`,token 经 `$(cat ~/.relay/credentials/github-sandbox-pat)` 内联,**未读/未打印/未复制该文件内容**):首 8 提交=`6c035203(foreign,2026-11-11T23:02:47Z=07:02:47+0800)←4bf5986a←35f1ab8d←57ea8c63(3×relay t-gh-real)←e52934fa←0dbf08a9←175eb071←a49f4317(root)`,每提交 parents 恰 1;`compare/e52934fa...6c035203`→`ahead_by:4/behind_by:0`。
8. `/home/ubuntu/.config/magpie/routing/2026-11-12.jsonl`(46 行):命名窗 **06:59:57~07:00:08+08 恰 3 条** `group/gm→zcode status:200`(06:59:57.879/07:00:03.749/07:00:08.899);同一运行总窗 06:59:46~07:00:08 共 **5 条 200**(另 06:59:46.900/06:59:52.677,conv magpie-71307;07:00:03/08 属 conv magpie-0ebd3);**07:00:08 后零条目**(本 Reviewer 会话不在日志中);01:48~01:57 pi 调用簇早于第四包合同(06:56:58)且当日三历史证据目录零写入 ⇒ 非 F1/F2 门控运行,归属不在本包范围。
9. `docker exec relay-p000-pg psql -U postgres -d relayp000`:`diag_cli_e5b7c761.budget_ledger`=1、`p01a_rev1_pogqulj4`=8、`p01a_review_f_cli_r28bt5`=1 —— **1/8/1 确认**;R-1 schema 8 行 updated_at 全 ≤2026-11-11 14:27:59+0800(第四包零触碰);其余 21 个 schema 全 0 行(与"测试 schema 随 afterAll 清理、常设账本零变动"一致)。
10. `git ls-files -v` 全库:346 个跟踪文件,非 H **恰 2 个**=`S p0-mvp/soak-24h/samples.csv`、`S p0-mvp/soak-24h/worker.log`,其余全 H。
11. 口径:capabilities.ts:110-115 `delivery.github.real=VERIFIED` ↔ 矩阵 US-08"VERIFIED(R-1 闭环;2026-11-12)"+G6"VERIFIED(R-1 闭环)";:75-80 `decision.d3.auto_approve=NOT_IMPLEMENTED` ↔ src/core/decisions.ts:4-5,92-98(D3 永不超时自动批准,仅 EXPIRED_STILL_BLOCKED)+ 基线矩阵 US-06/V07"D3 永不自动批准 VERIFIED"+ CURRENT 第五包"D3 无自动批准" —— 一致;`worker.model` 按 workerMode 动态(:140)✓。
12. `npx tsc --noEmit` → exit 0 零输出;`npx vitest run test/unit/capabilities.test.ts` → **5/5 passed**(313ms)。

### A~H 逐项结论表

| 项 | 结论 | 关键证据(对应上列摘录条目) |
| --- | --- | --- |
| A diff 面审 | **确认** | 恰 7 文件(#2);capabilities 仅注释、剥注释逐字节相等(#3);无 soak 证据面/无运行时语义/无凭据材料(#2/#4)。注:审计口径"三个 test 文件"实为 **4 个**(f1/f2/live-worker-e2e + github-real,后者属 B 项授权面),与提交信息/报告自述一致,无越权 |
| B github-real 唯一载荷 | **确认** | RUN_TAG 定义+3 载荷+1 断言(含唯一载荷全文)(#5);强推自证机制原样完好、零强推标志引入(#5) |
| C 证据目录重定向 | **确认** | 三测试→test-evidence/、.gitignore:4 生效、三历史目录 diff 空+11-12 零写入、check-ignore 命中(#6) |
| D 沙箱远端事实 | **确认** | 近 4 提交=3×t-gh-real+1×foreign,6c035203 当前头;0dbf08a9/e52934fa 仍在链;behind_by=0/ahead_by=4 历史只增零改写(#7) |
| E A-4 披露 | **确认(附 Minor-p4-1)** | 命名窗恰 3×zcode:200(#8);账本 1/8/1 未动(#9);零 F1/F2(#6/#8);但同轮总消耗为 5 次上游 200(见 Minor-p4-1) |
| F skip-worktree | **确认** | 全库仅 2 个 S 标(两 soak 观测文件),其余 344 全 H(#10) |
| G 口径一致性 | **确认** | VERIFIED/NOT_IMPLEMENTED 与矩阵、代码教义、CURRENT 一致(#11) |
| H 可运行项 | **确认** | tsc 0 错、capabilities 单测 5/5;禁跑清单全部未跑(#12) |

### 证伪尝试记录(4 条,均未成功证伪)

1. **越权改动搜索**:对 f8e0263 全部 hunk(共 10 个)逐一审读并按路径反查 soak/凭据/运行时面——零命中;对 capabilities.ts 施加注释剥离字节对比寻找隐藏语义变更——剥离后逐字节相等。证伪失败。
2. **远端历史改写证明**:若存在强推/改写,`e52934fa` 不可能是当前头祖先——compare API 实测 `behind_by=0/ahead_by=4`,全链单亲线性,三祖先(175eb071/0dbf08a9/e52934fa)仍在首 8 列表内。改写假说不成立。
3. **F1/F2 隐匿运行证明**:门控 F1/F2 产出必落盘(f8e0263 前落 p0-mvp/f1|f2,其后落 test-evidence/f1|f2)——两处 11-12 均零新文件,且第四包窗口内无第二模型调用簇;01:48~01:57 调用簇因当日历史证据目录零写入被排除为 F1/F2。证伪失败。
4. **账本暗耗证明**:扫描全部 22+ schema 的 budget_ledger——常设三 schema 1/8/1 不变(最新行 11-11),其余全 0、无新 schema。证伪失败。

### 发现问题

**Major:无。**

- **Minor-p4-1(A-4 披露口径精度;登记,不构成修必)**:pack4 报告披露"06:59:57~07:00:08 三次 zcode:200 上游调用"——命名窗内恰 3 次,字面属实;但同一 live-worker-e2e 运行总窗(06:59:46~07:00:08)实际 **5 次上游 200 调用**(06:59:46.900/06:59:52.677 两条落在命名窗之前)。按 A-4 条款"每次运行应向用户明示"的义务,消耗披露宜以**单次运行上游调用总数(5)**为口径,否则"used≈6+本次=7"算术低估实际消耗。预算账本本身零变动(limit=8 未触、零新行)——**无突破,仅披露精度**;建议第五包终账按运行级口径重述本轮消耗。
- **观察 O-3(登记)**:第四包审计口径"三个 test 文件"与实际 diff 的 4 个 test 文件之差即 github-real——在合同第①项授权面内,提交信息与报告均如实自述,非越权;备查。
- **观察 O-4(登记)**:`RELAY_F1_E2E/F2_E2E 未置位`属环境变量,无法事后直接取证;本轮以行为证据链(证据目录缺位+历史目录零写入+模型调用簇唯一性)间接钉死,结论成立但取证为间接;建议后续在测试输出中打印门控状态留强证据。

### 裁决

**PASS-WITH-FINDINGS**。

- 第四包六项(①~⑥)与提交 f8e0263 的 diff 面、沙箱远端事实、预算账本、skip-worktree、口径一致性全部零采信亲测确认;**零 Major**。
- 唯一 Minor=Minor-p4-1(披露口径:单轮实际 5 次上游调用 vs 命名窗 3 次;账本未动、无预算突破)。
- 报告"独立 Reviewer 复核见 REVIEW-r1-closure.md 追加节"的自指承诺由本节兑现。
- 复核时点 HEAD:`f8e0263dddce9eda1094a44258d097d67a020289`(工作区仅未跟踪 `p0-mvp/soak-24h/final-runner.log`,属第一包收尾面);复核时点 2026-11-12 07:13:12+0800。

### 增量附审:遗留②③(1ec7aad)

- 增量范围:合同 `c6b3e4e`(CURRENT.md 第四包行改完成+新增遗留行②显式 env 门禁/③账本对账;零模型消耗);实施 `1ec7aad`(已推送,`git ls-remote origin main` 亲验 == `1ec7aad116856c7cd86ed6fc2d8626fd2dd1e37f`);复核时点 **2026-11-12 07:38:03+0800**。
- **diff 面审(确认)**:`git show 1ec7aad --stat` 恰 5 文件——三个测试(live-worker-e2e/gate-e2e/egress-proxy)各仅在 `describe.skipIf` 谓词**追加** `|| process.env.RELAY_A4_E2E/RELAY_GATE_E2E/RELAY_EGRESS_E2E !== "1"` + 注释行:skip 谓词取析取,条件只会使跳过集合增大 ⇒ **门禁只会更严不会更松**;零断言/fixture/timeout 改动,无 soak/凭据/运行时语义面;`docs/CONTINUATION.md` 门控清单同步(纯文档);`pack4-test-governance.md` +6 行⑦节(全插入,原披露节 5×200 口径已在 715c35e 对齐)。
- **无 env 回归亲测(确认)**:`env` 亲查三变量未置位;`npx vitest run test/integration/{live-worker-e2e,gate-e2e,egress-proxy}.test.ts` → **3 文件 8 测试全 skip**(egress 6+gate 1+lw-e2e 1)、Duration 3.47s/tests 0ms,与提交声称 3.7s 一致;"修复前同命令真实运行 33.5s"的对比由 07:00 运行窗 magpie 5×200 实锤支撑(两次运行间唯一 diff 变量即本 env 门)。`npx tsc --noEmit` → 0 错。
- **账本对账亲验(确认)**:第一手证据 `test-evidence/live-worker-e2e/live-worker-e2e.log` 行 9 `2026-11-11T23:00:18.101Z(=07:00:18+0800) ledger model_calls used=5 limit=8 reserved=0` == magpie 路由日志 06:59:46~07:00:08 窗 **5 次** `zcode:200`(06:59:46.900/52.677/57.879/07:00:03.749/08.899)——**1:1 吻合**;pack4 ⑦"测试次数(1 次运行)≠模型请求次数(5 次);limit=8 为每 Goal 口径"与源码一致(live-worker-e2e.test.ts:10 注释+行 128-129 `reserveCallsPerRun:4/reviewerReserveCallsPerRun:4` ⇒ limit 8;账本随测试 schema 清理,常设账本 1/8/1 不变)。
- **零模型副作用实证**:本附审两次跑 skip 回归(07:36)后,路由日志仍 46 行/末条 07:00:08.899/其后零新增——本 Reviewer 全程零模型消耗。
- **观察 O-5(登记,非本次引入)**:`gate-e2e.test.ts:7` 头注释"coder 预留5+reviewer 预留3"与其自身代码陈旧不符(行 104/128 实际 `reserveCallsPerRun:4`+`4`,内联注释"4+4 ≤ 8"为准)——该注释先于 1ec7aad 存在(本次 diff 上下文行,未触碰);建议后续顺手对齐,不阻塞。
- **增量裁决:PASS**——遗留②(env 门禁,更严不更松)与③(账本 1:1 对账)均亲测确认,无 Major/Minor;O-5 为先前遗留注释漂移仅登记。合同遗留行①(REVIEW/CI 核查)由本节及后续 CI 核查兑现,④已在 c6b3e4e 完成。
