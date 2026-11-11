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
