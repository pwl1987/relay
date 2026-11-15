# RELAY-DEPLOY-REHEARSAL-08R 协调方独立复核（2026-11-15）

**裁决：PASS（仅 08R 的临时 PG 容器回环安全纠偏，不代表生产部署 GO）。**

## 已核实
- GitHub live main c22d23f9f69cf808a09d11ed91a876550fce4584，最低合同 SHA 395091f；Agent 实施 db51067 + 阻塞期状态登记 cc8cab5 + 收口 c22d23f。GitHub Actions [43687864325](https://github.com/pwl1987/relay/actions/runs/43687864325) 严格绑定 c22d23f，test/e2e 两 job completed success；实施提交 db51067 的 [43666136828](https://github.com/pwl1987/relay/actions/runs/43666136828) 同样双 success。真实 diff 仅新增 08R 一次性 PG 启动/端口校验助手、单测及 E2E 接入，其他是 REPORT/REVIEW/证据/续接；src/、deploy/、migrations/ 未被本包修改。
- 代码独立核验 test/integration/d08-ephemeral-pg.ts：Docker run 的 -P 被替换为显式 -p 127.0.0.1::5432；随后读取真实 Docker inspect NetworkSettings.Ports 只接受单个 5432/tcp=127.0.0.1 且无其他端口绑定、有效 HostPort；失败则销毁本包带 nonce 的容器。旧 E2E 的随机端口、PG SELECT 1 重试、迁移/恢复/afterAll 清理语义保持。单测覆盖 wildcard/IPv6/其他端口/缺失 HostIp/非法 HostPort/inspect 失败。
- **协调方 VM80 本轮亲跑**：npx vitest run test/unit/d08-ephemeral-pg.test.ts test/integration/deploy-rehearsal-e2e.test.ts --reporter=dot，结果 2 files/16 tests PASS（其中 15 unit + 1 真实一次性 Docker PG E2E，约 5.33s），之后 docker ps -a 过滤 relay-test-d08-* 无残留。没有启动旧 -P 危险容器；Agent 报告/Reviewer 真 Docker 差分 TCP 探针和 28/28 测试为**其独立证据**，不冒充协调方全部亲跑。
- VM80 本地 HEAD=GitHub live main c22d23f，branch=main；origin/main 本地跟踪 ref 尚停在 cc8cab5（落后一提交的缓存，非本地代码分叉），下一 Writer 须安全 fetch+核祖先。Writer 当前 auto 无 active task；未跟踪 config/、soak-r3b/ 及三个 ci-checkruns 回执已分类，未擅自触碰。
- 正确 systemd user bus 的 read-only deploy/preflight.ts --json **NO-GO**：db_migrations FAIL（0008/0009 未实施）、process_vs_head UNKNOWN（旧进程）、evidence_checks_config UNKNOWN（未配置）、egress_stack UNKNOWN（缺席）；relay-web/relay-worker MainPID=3242781/3242782 未改变。

## 后续新风险
- deploy/backup.sh 在无宿主 psql 时直接 docker exec relay-p000-pg/relayp000，查询无 schema 限定的 audit_events；有宿主 psql 时同样无 schema。更大的一致性风险：默认 pg_dump 整库，backup-manifest.mjs 枚举全部 candidate_changesets schema，restore-verify-check.mjs 合并全部 schema 行数。目标备份（如 relay_console）不应静默包含同库其他项目数据或把跨租户总量作为目标验收。**这是源码证实的潜在数据范围缺陷；本轮没有读取或拷贝其他 schema 的生产原始数据，也没有宣布已经发生泄露。**
- 已发布唯一 ACTIVE RELAY-BACKUP-INTEGRITY-09 以合成双租户一次性 PG 做真实脚本红绿与隔离恢复验证，兼容旧 E3 调用方须由代码/测试审计证明。09 不能执行生产备份/迁移或 D3。Mac UX、真实模型交付、24h Pilot 依然未验收；MVP 总裁决维持 REWORK。
