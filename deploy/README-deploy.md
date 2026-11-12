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
