# Relay Operator Console · VM80 部署(WEB-UX-01 阶段六)

- 部署时间:2026-11-12;方式:systemd **user** 服务(Linger=yes 已确认)+ 独立 schema + LAN 单接口绑定。
- 边界:仅 LAN(当前无 VPN 接口;阶段八手机验收时按实际 Headscale 路由评估,**禁 0.0.0.0/公网**);口令认证(0600 文件);写 API = session + SameOrigin + CSRF + operator。

## 组件

| 项 | 值 |
| --- | --- |
| web 服务 | `relay-web.service`(user)→ `node src/server/index.ts`;绑定 `http://10.30.5.80:8787`(ens33 LAN;`RELAY_WEB_ALLOW_NON_LOOPBACK=1` 显式放行) |
| worker | `relay-worker.service`(user)→ `node src/worker-entry.ts`;schema=`relay_console`;sandbox=docker;provider=Magpie/`zcode/GLM-5.3`(占位 key,真实凭据由 Magpie 持有) |
| DB | 同一 PG 容器(relayp000 库),**独立 schema `relay_console`**(与 soak24h 零共享;互不影响) |
| 凭据 | `~/.relay/credentials/web-password`(0600;FAIL-CLOSED,server 启动强制) |
| 环境文件 | `~/.relay/console/env`(0600;两服务共用;禁入仓) |
| 项目注册表 | `<repo>/config/projects.json`(运行时文件,不入仓;当前注册 `pilot-demo`=/home/ubuntu/pilot-demo) |
| schema 初始化 | `node deploy/init-schema.ts relay_console`(幂等;已存在则跳过迁移) |

## 安装步骤(复现用)

1. `node deploy/init-schema.ts relay_console`
2. 生成 `~/.relay/credentials/web-password`(0600)+ `~/.relay/console/env`(0600,变量见模板/上表)
3. 按 `deploy/relay-web.service.template` / `deploy/relay-worker.service.template` 安装到 `~/.config/systemd/user/`(ExecStart 的 node 用绝对路径)
4. `systemctl --user daemon-reload && systemctl --user enable --now relay-web.service relay-worker.service`
5. 验证:`curl http://10.30.5.80:8787/api/health`(未登录 401)+ 登录回路 + `journalctl --user -u relay-worker` 出现 `egress ready` + `tick status=IDLE`

## 行为与恢复

- 两服务 `Restart=always`(RestartSec=3):崩溃/退出自动拉起(已演练 restart → active → health 401)。
- worker FAIL-CLOSED 链:provider 未配置 / sandbox 非 docker / docker 不可用 / egress 未就绪 ⇒ 一律不领取(worker-entry 首拍前 `ensureEgress`;本包补齐该接线,soak 期间的空转行为不受影响)。
- 日志:`journalctl --user -u relay-web|-u relay-worker -e`。
- 停止:`systemctl --user stop relay-worker relay-web`(不会触碰 soak 三进程)。

## 阶段七/八前置状态

- Mac LAN 验收:浏览器打开 `http://10.30.5.80:8787` → 登录(口令见运维交接)→ 8 项旅程(ADR-0010)。
- 手机 VPN:当前主机无 VPN 接口;待用户确认 Headscale 路由能否直达 `10.30.5.80`(禁为此开放公网)。

---

## 生产切换前 Runbook(RELAY-DEPLOY-PREFLIGHT-05;2026-11-14 登记)

> 本节仅为**手动 Runbook**:生产切换(重启/配置变更/schema 写入)必须由用户**单独 D3 授权**后执行;本包(PREFLIGHT-05)未实施任何生产动作。PASS 只代表"具备提出生产切换审批申请所需材料",不代表可自动发布。

### 0. 只读预检入口(零写入/零重启/零凭据值输出)

```bash
node deploy/preflight.ts            # 文本输出(脱敏);退出码 0=GO / 1=UNKNOWN / 2=NO-GO
node deploy/preflight.ts --json     # 机器可读(同样脱敏)
```

检查面:git HEAD/被跟踪树、systemd user 服务运行态、进程与 HEAD 版本差(代码已更新/进程仍旧/未能读取三区分)、凭据文件 0600、env 必需键名(仅键名)、`RELAY_EVIDENCE_CHECKS_JSON` 结构合规(与 worker 启动校验 `resolveEvidenceChecks` 单一同源)、`RELAY_MAX_OUTPUT_TOKENS` 合规、Web 绑定(LAN 单接口,禁 0.0.0.0)、Docker/检查沙箱镜像(`node:24-bookworm-slim`)/出口约束栈、DB 可达/16 表结构/迁移标志物(0006/0007/0008/0009)/在途任务聚合计数/Run 归属绑定聚合计数。DB 全部聚合计数,零原始数据。

### 1. 切换前 GO/NO-GO/UNKNOWN 基线(2026-11-14 实测,证据=p0-mvp/deploy-preflight-05/evidence/preflight-prod-20261114.log)

| 类别 | 项 | 状态(实测) |
| --- | --- | --- |
| GO | git 被跟踪树清洁;两 systemd 服务运行;凭据/env 0600;env 必需键齐备;Web LAN 单接口绑定;Docker 可用;沙箱镜像在位;DB 可达;16 表齐备;在途阻断态=0(仅 BLOCKED/PAUSED);Run 绑定仅终态残留(BUDGET_EXHAUSTED,不重入 Gate) | ✅ |
| NO-GO(须处置后复检) | **迁移缺失:0008(goal_messages.execution_request)、0009(tasks.abort_requested_at)** —— 重启后新代码依赖(停止旗标/对话授权);`init-schema` 对已存在 schema 跳过、`applyMigrations` 全量重放会撞表 ⇒ 须按迁移文件逐条精确执行(见步骤 3) | ❌ |
| UNKNOWN(用户 D3 决策项) | ①`RELAY_EVIDENCE_CHECKS_JSON` 未配置 ⇒ 重启后代码变更候选 Gate 保守停机 `functional_evidence_unconfigured`→NEEDS_DECISION(fail-closed 安全;Gate 自动放行不可用):配置功能性检查(步骤 2)**或**显式接受保守停机运行;②进程启动(2026-11-13 02:00:08)早于 HEAD ⇒ 线上为旧代码,新语义以重启为界(切换本身消解);③出口约束栈当前不在(测试套件 `teardownEgress` 拆除共享栈)⇒ 运行中 worker 已降级,重启后首拍 `ensureEgress` 幂等重建自愈(重启后必须核对 `egress ready` 横幅) | ⚠️ |

### 2. 配置决策项(用户 D3)

- **功能性检查配置(可选)**:参考 `deploy/evidence-checks.sample.json`(样例,非生产取值;当前生产无已配置检查)。写入 `~/.relay/console/env` 时**必须压平为单行** `RELAY_EVIDENCE_CHECKS_JSON=[...]`(env 文件为 KEY=VALUE 行格式);改前先备份 env 文件;写后重跑 preflight 应 `evidence_checks_config=PASS`。注意:检查命令在容器内以 UID 10001 读取工作区文件 ⇒ 候选文件需 o+r 权限(runner 工作区目录已 chmod o+rwX)。
- **迁移补齐(必做,写生产 schema)**:在 relay_console schema 上精确执行缺失迁移文件内容(`migrations/0008_goal_messages_execution_request.sql`、`migrations/0009_tasks_abort_requested.sql` 的 SQL 主体,search_path 置 relay_console;0008 加列 NOT NULL DEFAULT false[旧行自动回填 false]、0009 加列可空;幂等以 preflight 复检为准);补后重跑 preflight 应 `db_migrations=PASS`。迁移无自动化=既有登记项(DEPLOY-03D 新发现)。
- **沙箱镜像**:如需覆盖 `RELAY_SANDBOX_IMAGE` 默认值,先在隔离演练验证镜像对既定命令的支持,不得以"存在配置"冒充执行通过。

### 3. 备份与隔离恢复演练(切换前必做)

```bash
RELAY_DB_URL=$(grep '^RELAY_DB_URL=' ~/.relay/console/env | cut -d= -f2-) \
  deploy/backup.sh /tmp/relay-backup-$(date +%Y%m%d)   # db dump + artifacts manifest + audit index + checksums
# 恢复演练(宿主无 psql ⇒ 需 psql 可用的恢复容器:RELAY_RESTORE_CONTAINER 覆盖,缺省 relay-restore-verify;
# 可起一次性 PG 容器充当;自动化等价路径=RELAY_BACKUP_E2E=1 的 test/integration/backup-restore.test.ts,quality:release 内置)
deploy/restore-verify.sh /tmp/relay-backup-YYYYMMDD "<隔离实例连接串>"   # 隔离实例恢复+交叉核对
```

- 恢复目标必须是**隔离实例**(独立容器/独立库),禁止在生产库上重放备份。
- 外部 Git 交付状态不在备份范围:恢复后核对 `candidate_changesets.delivered_remote_head` 与 GitHub 实际 HEAD(Reconcile 语义见 V05/V10)。

### 4. 切换操作顺序(仅在用户 D3 批准后执行)

1. 复跑 `node deploy/preflight.ts`:确认 NO-GO 项已清零(迁移已补)、在途阻断态=0(`VERIFYING/DELIVERING/NEEDS_RECONCILE/RUNNING=0`;READY=排队不阻断)。
2. `systemctl --user restart relay-web relay-worker`(旧进程停止→新代码进程;Restart=always 兜底)。
3. 启动横幅核对(`journalctl --user -u relay-worker -e`):`evidenceChecks=<N|未配置>` 与步骤 2 决策一致、`maxOutputTokens=<取值>`、`egress ready(network=relay-egress-net)`、`tick status=IDLE`。
4. 健康与边界核对:`/api/health` 未登录 401;登录回路;`ss -tln` 仅 `10.30.5.80:8787` 单接口(禁 0.0.0.0/公网);preflight `web_bind` PASS。
5. 失败回滚:代码回退 `git checkout <上一 CI 绿 SHA>` + 服务重启;env 文件恢复步骤 2 备份;0008 加列 NOT NULL DEFAULT false、0009 加列可空,旧代码不读这两列 ⇒ **回退代码无需回滚 schema**(如实登记)。生产数据零手工改写;异常状态经 supervisor 回收/Reconcile 或 D3 人工处置,禁止无证据 reset。

### 5. 显式未自动验收(不得由本包宣称)

用户 Mac 实机 UX、真实模型 Run 端到端、真实 GitHub 交付、长期稳定性(24h+)均未自动验收;生产切换授权与实施独立于本包。
