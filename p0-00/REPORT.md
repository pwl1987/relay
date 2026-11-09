# P0-00 实验报告:Pi 权限隔离 / Lease 恢复语义 / 外部副作用 Reconcile / DBOS 对比

状态:**COMPLETE(P0-00 交付)**。执行:VM80(ubuntu2604)唯一 Writer 会话,2026-11-09,起点 `origin/main == 575ae25`。本报告是 P0-00 的结果证明;所有命令可复现,原始输出存于 `p0-00/evidence/`。

## 0. 环境标识

| 项 | 值 |
| --- | --- |
| 主机 | ubuntu2604(VM80),Linux x86_64,32 vCPU / 121Gi RAM / 102Gi 空闲磁盘 |
| Node.js | v24.21.0;git 2.53.0;Docker 29.1.3 |
| Pi CLI | **1.5.0**(`/home/ubuntu/.npm-global/bin/pi`,npm 包 `@earendil-works/pi-coding-agent`) |
| PostgreSQL | 专用容器 `relay-p000-pg`(postgres:17-alpine,`127.0.0.1:55433`,512Mi 上限,仅实验使用) |
| 模型路由 | magpie 本地路由(`127.0.0.1:3425`,假密钥 `magpie`,真实凭据零暴露) |
| Pi 沙箱 HOME | `.p0-00-lab/pihome`(独立配置,仅含 magpie provider;共享 `~/.pi` 未被读/写) |

**环境观察(非实验结论,但影响后续包)**:
1. Pi 二进制在实验期间自行从 1.4.0 变为 1.5.0(symlink 时间戳 21:01,非本会话显式触发)。**任何 Relay Worker 必须锁定 Pi 版本并校验,不能依赖宿主全局安装**。
2. 宿主 ufw 默认拒绝容器→宿主流量,故实验 A4b 用 `--network host`(FS 隔离不受影响;网络隔离由 A4a `--network none` 独立证明)。
3. `gh` 当前令牌为超范围授权(含 `admin:org`、`delete_repo` 等)。本实验全程未使用;**P0-02 集成前必须改用细粒度最小 PAT**。

## 1. 实验 A:Pi SDK/RPC 权限隔离(ADR-0003,V14,OPEN-A)

方法:哨兵假密钥文件 + 中性任务措辞(避免模型自拒混淆因果),四个子实验 + 一个基线。

| 子实验 | 结论 | 证据 |
| --- | --- | --- |
| A0 默认工具基线 | **默认 Pi 无 FS 边界**:同 UID 下 bash 工具读 sentinel 的 sha256 与宿主真值一致、`/tmp` 越界写成功;首次运行的"模型自拒"被中性措辞绕过,**模型自拒不是确定性防线** | `evidence/exp-a/a0-default-tools-baseline.log` |
| A1 `--no-tools` + RPC | 注入全程 **0 次工具执行事件**;空工具面是结构性保证,Worker 可经 RPC 事件流机器校验 | `evidence/exp-a/a1-rpc-no-tools.log`、`a1-rpc-raw.jsonl` |
| A2 受控作用域工具 | `--no-builtin-tools` + 扩展注入 `relay_read`(realpath+前缀校验):绝对路径/`../`/`../../`/`/etc/passwd` 全部 DENIED;正向对照 `./readme.txt` 读取成功 | `evidence/exp-a/a2-scoped-tool.log` |
| A3 项目扩展自动加载 | 非交互 `--print` 模式下,工作区 `.pi/extensions/` 的"恶意"测试扩展**未被自动加载**(无 trust 决策不加载,两次运行一致,未写 trust.json) | `evidence/exp-a/a3-project-extension-autoload.log` |
| A4 OS 沙箱独立验证 | Docker(`--cap-drop ALL`、uid 10001、仅挂载工作区):sentinel 不在命名空间、宿主目录不存在、无 docker.sock/SSH_AUTH_SOCK/GH token、`/etc` 写失败、`/workspace` 写成功;**容器内 pi(默认工具+敌意提示)读 sentinel → No such file** | `evidence/exp-a/a4a-container-shell.log`、`a4b-container-pi.log` |

**裁决输入(ADR-0003)**:Pi 工具层策略(`--no-builtin-tools` + 白名单扩展工具)可确定性约束模型能力面,但 Pi 扩展与主进程同权限(文档明示"可读取凭据"),**工具层不是安全边界**;OS 层(容器+scoped mounts+非 root+cap-drop)独立成立。两条必须同时用。

**残余风险(R1,转入 P0-01B 合同)**:Pi 的 project trust 一旦在某工作区被交互模式信任过即写入 trust.json,此后无人值守运行会加载该项目扩展。**Relay Worker 必须为每个 Run 使用一次性独立 HOME(禁共享),并在启动参数层固定 `--no-builtin-tools` + 工具白名单**。

## 2. 实验 B:PostgreSQL Tick/Lease/Fencing(ADR-0007 输入,V04/V06,NFR-02)

方法:最小实现(`p0-00/exp-b/`,227 行,单依赖 `pg`):`tasks`/`leases`(fencing token 单调递增)/`audit_events`(append-only,拒绝也留痕);所有状态推进单事务内完成(行锁 → 租约/fencing/期望状态校验 → 变更+审计 → 提交)。

| 场景 | 结论 | 证据 |
| --- | --- | --- |
| B1 双 Worker 并发争抢 | **恰好一个赢家**;非持有者 ADVANCE 被拒(owner mismatch);重复推进被拒(state mismatch)——无双重有效 Writer | `evidence/exp-b/b1-concurrent.log` |
| B2 租约过期+fencing | 过期后新 Worker 以 token+1 回收;旧持有者旧 token 被拒;冒充新 token 被拒 | `evidence/exp-b/b2-expiry-fencing.log` |
| B3 SIGKILL 崩溃恢复 | RUNNING 中 SIGKILL(worker 进程确认死亡)→ supervisor reconcile 回收 READY → 新 Worker fencing+1 重领至 ACCEPTED → 幽灵写入被拒;**审计 9 步完整历史含全部拒绝事件** | `evidence/exp-b/b3-sigkill-recovery.log` |
| B3b TTL 窗口语义 | TTL 30s 下,SIGKILL 后立即以旧 token 幽灵推进 **成功**(RUNNING→VERIFYING,租约窗口=权威窗口);未过期租约期间他人抢注被拒。窗口外一律 FENCED(见 B2) | `evidence/exp-b/b3b-within-ttl-ghost.log` |

**实验中修复的两个实现缺口(留下证据,非掩盖)**:①claim 状态门最初把"租约过期但仍处 LEASED/RUNNING"挡在门外(先查状态后查租约)——崩溃恢复主路径会被卡死;②reconcile 状态集漏掉 VERIFYING。修正后的语义:**过期租约 + 非终态 ⇒ 可回收**,回收必留审计。

**结论**:~230 行、单依赖、单人可审计的实现即满足 V04/V06/BLOCK 级语义。fencing token 是防"过期幽灵写"的充分手段;TTL 窗口内的权威边界须在 P0-01A 合同中显式声明(心跳续租 + Worker 进程退出/被杀后由 supervisor 在过期后回收)。

## 3. 实验 C:外部副作用 Reconcile(V05,NFR-06)

方法:本地 Mock Git 仓库(工作仓 + bare "remote"),真实 `git push` 为外部副作用,真实 SIGKILL 注入;`action_intents` 两阶段日志(RESERVED → EXECUTING → COMPLETED/CONFLICT),恢复方**先查询目标真实状态再决策**。未使用任何真实 GitHub 凭据;按授权要求先用本地 Mock,验证充分,**无需为本包创建专用 GitHub 测试仓**(P0-02B 再建)。

| 场景 | 结论 | 证据 |
| --- | --- | --- |
| C1 push 成功+回执丢失 | executor 在"副作用已发生、回执未写"窗口被 SIGKILL(进程死亡已核验,意图停留 EXECUTING);reconcile 查询远端真实 HEAD == payload → `SIDE_EFFECT_CONFIRMED`,**不重推**;远端恰好一份提交;重复 reconcile 幂等(`already_completed`) | `evidence/exp-c/c1-lost-receipt-reconcile.log` |
| C2 push 前被杀 | reconcile 查询远端 HEAD 未变 → `SIDE_EFFECT_ABSENT_REEXECUTE_SAFE` → 安全重推**恰好一次** | `evidence/exp-c/c2-before-push-recovery.log` |
| C3 远端漂移 | expected SHA 过期时执行器**前置核对拒绝(CONFLICT)**,候选未覆盖外部新提交,无强推 | `evidence/exp-c/c3-remote-drift-reject.log` |

**结论**:"先 Reconcile 再决策"模式在三种窗口下均正确;决策(确认/缺失重试/人工)全部落审计。该模式直接进入 P0-01A 的 `action_intents` 设计。

## 4. 实验 D:最小 PG Tick/Lease vs DBOS(ADR-0007)

方法:同一任务语义分别以自研最小实现(exp-b)与 DBOS(exp-d,SDK 5.4.0,同样落在本实验 PG)实现,实测三类语义。

| 维度 | 自研最小实现 | DBOS 5.4.0 |
| --- | --- | --- |
| 同 workflow/任务去重 | Lease:fencing token(实测 B1) | `workflowID` 去重:同 ID 并发启动 → 单次执行、结果共享(D1 ✅) |
| 崩溃恢复 | supervisor reconcile + fencing(实测 B3) | **强项**:launch() 自动恢复,步骤恰好一次记录,`DBOS.sleep` 断点续跑(D2 ✅,recoveryAttempts=2) |
| 任务级单写者 | 内建(Lease+行锁) | **不提供**:不同 ID 的 workflow 并发同任务均 SUCCESS,防双写仍需应用层原子 claim(D3 实证) |
| 外部副作用语义 | 实验 C 的 Reconcile 模式 | 文档承认对用户库/外部系统不能无条件 exactly-once(与我们的 Reconcile 需求一致) |
| 代码量 | 227 行(含 schema 31 行;应用代码 196 行) | 211 行(应用 src/app.ts 165 + 复用 schema 31 + tsconfig 15)+ 隐性:系统 schema 13 张 `dbos.*` 表 |
| 依赖 | 1 个(pg,900K) | dbos-sdk + pg + typescript 等,5 个直接依赖、50M;v3→v5 破坏性迁移 |
| 集成摩擦(实测) | 无 | ①v3.5.8 事务需 datasource 包且 npm 无独立 pg 实现;②v5 `DBOSConfig` 无 `databaseUrl`(仅 systemDatabaseUrl);③workflow/step 首参 ctx 注入语义未文档化,实测**不注入**——首参写 ctx 会吞掉第一个业务参数(本实验实锤:`claimTask received taskId="dbos-A"`);④装饰过的静态方法调用需 `as any`,Context 类型不导出 |
| 诊断 | 审计表直查 | `dbos.*` 系统表(信息更丰富,但多一套概念) |

证据:`evidence/exp-d/d0-setup.log`、`d1-same-uuid-dedup.log`(成功运行:两个句柄同结果 ACCEPTED,库内恰 1 行 workflow_status、audit 仅 dbos-A 一套)、`d2a-killed.log`、`d2b-recovery.log`(D3 见上表,库内两 workflow 均 SUCCESS)。

**裁决输入(ADR-0007)**:DBOS 的 durable 步骤记录与断点恢复是真实且优秀的,但它**不解决任务级单写者与外部副作用 Reconcile**——这两项恰是 Relay 状态机核心,自研最小实现已全部满足且依赖面小一个数量级。引入 DBOS 会叠加第二套调度概念与升级风险(v3→v5 已示范),违背"禁止第二 Workflow Engine"边界。

## 5. 裁决(写入 ADR)

- **ADR-0003(Pi 集成方式,OPEN → 裁决)**:采用 **RPC 子进程模式**(`pi --mode rpc`)+ 启动参数强制 `--no-builtin-tools` + 扩展注入白名单受控工具 + **每 Run 一次性独立 HOME** + OS 容器隔离(scoped mounts/非 root/cap-drop)作为双层边界。工具层策略防模型能力面失控,OS 层是真正安全边界;两者缺一不可(V14 双层留证)。
- **ADR-0007(durable workflow,OPEN → 裁决)**:**REJECT DBOS FOR P0**。自研 PostgreSQL 事务+租约+fencing+append-only 审计满足全部实测语义;DBOS 不提供任务级单写者与外部副作用核对,依赖与升级成本高一个数量级。P1 若需要步骤级 durable(长链路 Run 恢复),可重启评估,但不改变"Relay 状态机唯一所有者"约束。

## 6. P0-01A 最小执行契约(建议,待激活)

1. **Schema**:将 exp-b 的 `tasks/leases/audit_events` + exp-c 的 `action_intents` 正式化为 Drizzle migrations(字段可从 `DETAILED_ARCHITECTURE.md` §2 裁剪);审计含拒绝事件。
2. **状态机**:CREATED→READY→LEASED→RUNNING→VERIFYING→ACCEPTED + REWORK/NEEDS_RECONCILE/BLOCKED;过期租约+非终态 ⇒ 可回收(留痕);终态不可重复推进。
3. **Worker**:单 Tick 循环;claim/advance 全部走单事务 + fencing;心跳续租;PI 适配器按 ADR-0003 双层边界启动。
4. **外部动作**:执行前核对 expected 状态;RESERVED→EXECUTING→(COMPLETED|CONFLICT);恢复先 Reconcile 后决策,三分类(确认/缺失重试/人工)落审计。
5. **验收映射**:V04/B3、V06/B1、V05/C1、V14/A4 的实验脚本升级为 Vitest 集成测试;新增 V02(越权写 DENIED)与 V08(假 DONE 不过 Gate)的最小单测。

## 7. 独立复核(不同上下文 Reviewer,2026-11-09)

由独立 ZCode 会话对 16 项声明做只读核验(证据逐行 + 数据库直查 + 凭据模式扫描)。**总裁决:PASS(带修正条件)**,13/16 完全 VERIFIED。发现的修正条件与本轮处置:

| # | 复核发现 | 处置 |
| --- | --- | --- |
| 1 | C1/B3 的 `kill -9 $!` 只杀 subshell 包装,node 进程存活("SIGKILL 注入"机制失效;reconcile 语义仍被证明但因果链不严谨);遗留 3 个 run-hold 僵尸进程 | 已修复:`exec` 使 `$!` 即 node 进程,kill 后增加 `ps` 存活断言;僵尸进程已清理;**B3/B3b/C1 全部重跑**,新证据落盘(worker-dead(good)、EXECUTING 态被杀、窗口内幽灵 ok:true、幂等 reconcile) |
| 2 | D1 落盘证据是旧构建的失败运行(DB 中 d1e 成功但事后被 D3 setup 重置,无法事后复核) | 已重跑成功 D1 并把 DB 快照(task 状态、workflow 行数、审计序列)追加进证据文件 |
| 3 | exp-d 行数口径不一致(211 行把 tsconfig 计入"应用") | 已统一口径:应用 165 + schema 31 + 配置 15;exp-b 同口径注明 |
| 4 | B3b 落盘版为窗口外结果(首跑窗口内观测未落盘) | 已以 TTL 30s 重跑,窗口内幽灵成功 + 抢注被拒均已落盘 |
| 5 | C1"幂等 reconcile"无落盘证据 | 脚本增加第二次 reconcile,`already_completed` 已落盘 |
| 6 | 各实验共用同一 PG,schema 顺序副作用使事后复核不可能 | 已写入建议(§8):P0-01A 各实验应使用独立 schema/database |
| 7 | 安全扫描(6 类凭据模式)0 命中;哨兵假值未泄漏 | 无需处置 |

复核人另观察到:magpie 模型曾把工具原始输出中的 hash 行"渲染"成乱码(工具层原始记录正确)——再次印证**必须以机器层证据而非模型复述作为验收依据**(与 G5/证据原则一致)。

## 8. 未验证项与风险(诚实清单)

1. **E 类 fixture(三类样例端到端)未执行**——不在本轮授权顺序(A→B→C→D)内,留 P0-01/P0-02。
2. 实验 A 的模型仅为 magpie 本地路由(成本低、行为有代表性);**其他模型提供商的注入鲁棒性差异未测**,但 A1/A2/A4 的保证是结构性的,不依赖模型行为。
3. A2 的 `relay_read` 是最小原型:**符号链接到 allowed root 内部再逃逸、TOCTOU、压缩包逃逸**等对抗性变体未穷举;OS 层(A4)兜底不受此影响。
4. DBOS 结论文本基于 SDK 5.4.0 真实行为与 npm 生态现状(npm 上无独立 pg datasource);若 DBOS 后续提供无 ORM 的 pg 事务路径,结论可复核,但不改变 P0 决策。
5. 本包未触碰真实 GitHub 测试仓(授权允许,Mock 已足够);P0-02B 须建专用最小权限仓+PAT。
6. 各实验共用一个 PG 实例,顺序执行时 setup 会重置共享表——复核必须按"阶段顺序 + 证据文件"进行,库内事后状态不代表各阶段当时结果;**P0-01A 起每个实验包应使用独立 schema/database**。
7. PG 容器/卷(`relay-p000-pg`)与 `.p0-00-lab/` 保留至验收复核完成,随后可清理。

## 8. 复现命令

```bash
# 前置:专用 PG(docker run --name relay-p000-pg -p 127.0.0.1:55433:5432 postgres:17-alpine)
# 实验 A(需本地 magpie 路由;模型调用约 7 次)
p0-00/exp-a/run-exp-a.sh all
# 实验 B/C/D(无需模型)
cd p0-00/exp-b && npm install && ./run-exp-b.sh all
cd ../exp-c && ./run-exp-c.sh all        # 注:c2 依赖 c3 前重置,顺序 setup→c1→c2→c3 或每次先 setup
cd ../exp-d && npm install && npm run build 2>/dev/null || ./node_modules/.bin/tsc -p tsconfig.json
node dist/app.js setup && node dist/app.js d1 wf-x t-d1  # D2/D3 见 exp-d 源头注释模式
```
