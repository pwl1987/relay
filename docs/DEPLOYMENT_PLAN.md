# Relay 开发环境与自托管部署方案

状态：**FROZEN（隔离/角色/依赖边界） / OPEN（VM80 资源、端口、TLS、备份参数及凭据）**。此方案是候选部署拓扑，不表示已经部署。

## 1. 选址决策

**首选 VM80 作为唯一项目写入/运行环境，Mac 作为浏览器/终端/远程控制与人工验收。** 来自 2026-11-09 的只读 VM80 观测：控制器 ready，ZCode 和 Pi 可用，LoopX 可用，配置开发根 `/home/ubuntu/dev`，项目列表未列出 Relay。这仅证明现有 Agent 控制基础可用，**不说明 Relay 已安装或 VM80 资源足够**。

选 VM80 的理由：持续运行避免 Mac 睡眠/移动，易固定 OS 环境，已有自托管 Agent 工具，但环境内存在多个其他项目，必须严格租户/目录/进程隔离。Mac 不应同时写入同一 Relay 仓库；仅作远程操作、评审和应急控制。**若 VM80 资源/安全基线不足，再评估独立 VM，而不是强行共机**。

## 2. 目标拓扑（P0 单节点）

```text
Mac (Web/SSH/CLI) ──私人加密网络/授权代理── VM80
                                      ├─ relay-server (localhost/private bind)
                                      ├─ relay-worker (最小宿主权限)
                                      ├─ PostgreSQL (仅内网/Unix socket)
                                      ├─ 受限 workspace / artifacts / logs
                                      └─ Pi Runtime 子进程 -> 本地/远端模型 API
                                      GitHub API (最小授权+限流)
```

Server/worker 可以同容器编排两个入口，也可在 P0-01A 同进程起步；最终持续服务用 Docker Compose 或 systemd 取其简，**Docker Compose 是部署工具，不意味着 Agent 拥有 Docker 管理权限**。不得默认暴露 PostgreSQL 或管理 API 至公网。

## 3. 前置检查（未通过不能写环境）

- `uname`/内核、CPU/RAM/disk/inodes/IO、Node.js/Pi/Git/Docker/PostgreSQL 版本及可用容量；
- 是否已有 Relay 目录/锁/未提交文件/其他任务；VM80 Controller 当前 writer 和 LoopX 占用；
- 模型 API 可达性（本地/远端）与认证、代理/出网到 GitHub、端口/TLS/内网 ACL；
- VM80 项目目录下其他仓库的保护/最小权限；不能借 Relay 实验清理其他工作区；
- 备份空间与恢复目标，使用真实但非生产凭据的测试 Repo；
- 如使用 VM80 Agent Kit/LoopX 作为 Bootstrap 执行端，必须遵守该系统既有 Writer Lock/Review，不将其状态当 Relay 的数据库。

## 4. 目录与持久化建议

候选路径（需 P0-00 核实后批准）：
```text
/home/ubuntu/dev/relay/     # Relay 的唯一工作树（只保存代码）
/var/lib/relay/db/          # PostgreSQL volume（实际安装时由权限/编排决定）
/var/lib/relay/workspaces/  # 每次 Run 独立受限工作区
/var/lib/relay/artifacts/   # 截图/日志/报告，按内容哈希与保留策略
/var/log/relay/             # 结构化脱敏日志
```

不得把可变 Task/Run/状态写入代码 Git checkout；工作区/日志/数据库需隔离到托管路径，开发 Agent 无权限删除系统其他项目。具体 POSIX 用户/容器 UID、磁盘配额与目录权限 P0-00 决定。

## 5. 服务运行/健康

Server 暴露 `live` 与 `ready`（后者校验 PostgreSQL 可达、迁移版本、关键依赖），Worker 周期发心跳并记录当前 Lease。失联有内置退避和停机策略。外部进程守护使用 systemd 或 Compose restart，服务自动重启前确保 DB 事务和动作 reconcile 是安全的；不能让进程守护代替业务恢复。

初始并发建议单 Worker/单 Run；逐步测量并发/队列/IO。模型推理设备可在其他机器，通过 Provider 受控接入；**不要为了 Relay 自身引入 GPU、向量数据库或消息队列强依赖**。

## 6. 网络与认证

P0 优先绑定 `127.0.0.1` 或私网接口，通过 SSH 隧道/VPN/反向认证代理访问；授权写接口须认证与 CSRF/重放保护，明确 session/token 有效期和权限范围。浏览器可以访问 Mac 上的 Web 端，但 server 和 DB 仍部署 VM80。公网发布、TLS 证书自动化、外部 OAuth 对接留到有真实需要时的独立安全包。

## 7. 备份/恢复/升级

至少备份数据库、Artifact 索引/内容、启动配置与 schema 版本，并对敏感内容加密或隔离；实际备份频率、Retention、RPO/RTO 在 P0-00 容量/风险评估后决定。恢复演练从一份备份在**隔离实例**恢复，检查 Task/Run/Audit/Evidence 引用以及外部写动作是否需要 Reconcile。

发布采取 immutable image 或明确的 commit/release 版本记录，升级前健康检查+DB 迁移兼容评估；不允许未经审批的破坏性 Schema 迁移。Relay 自己开发自己时，新候选版本必须部署到隔离环境，通过自动测试和外部 Reviewer，稳定版本才允许受控推广。

## 8. 运维日常

观察：Goal backlog、Ready/Blocked/Decision、Worker heartbeat、Lease age、Run 重试、Token/成本、GitHub API 错误、Postgres 连接、磁盘、密钥脱敏、备份时间、测试假绿风险。告警先支持本地日志/健康端点及可读 CLI，通知推送属于 P1。

应急 Runbook：`relay pause`→只读检查数据库/外部 Git 状态→导出脱敏 Evidence→处理权限/异常动作→恢复到上一个受信版本→重新验证恢复；禁止用无证据的 reset/删库/force push 修复所谓死锁。

**部署验收**：在 Mac 不开 ChatGPT、VM80 重启/Worker 退出后能再次读取事实状态并继续安全任务；外部服务断供时可见降级；管理界面不可匿名访问；没有用户/测试仓生产写凭据暴露。