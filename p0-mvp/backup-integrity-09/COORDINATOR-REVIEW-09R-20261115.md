# RELAY-RESTORE-TARGET-09R 协调方独立复核（2026-11-15）

**结论：PASS（仅恢复目标隔离安全门，非生产 GO）。**

## GitHub 与当前运行事实
- live main fbf32f051e1e79706851b7df989eb6228f139adb，09R 起点 8368cb1，实施 271f2f9，收口 fbf32f0；exact-head GitHub Actions [43704169275](https://github.com/pwl1987/relay/actions/runs/43704169275) test/e2e 两 job SUCCESS，实施 exact-head [43703649584](https://github.com/pwl1987/relay/actions/runs/43703649584) 同样两 job SUCCESS；08R/09/09R 的生产真实操作未发生。
- 源码独立检查 deploy/restore-verify.sh + deploy/restore-target-verify.mjs：源 URL 必填；规范化回环与缺省端口快速门；docker fallback 强制 loopback HostIp + 5432 映射端口绑定到实际 Docker inspect 容器、源同名/ID 拒绝；源与恢复 PostgreSQL 的只读 postmaster 启动时间+服务端端口双探针任一不可证即拒；Docker exec 容器内时间再与 URL 探针比较，身份门先于任何 DROP/CREATE/导入；09 的备份 manifest/审计索引/校验和/异常清理并未被破坏。
- **协调方本人** VM80 定向执行 npx vitest run test/unit/d09r-restore-target.test.ts test/integration/d09r-restore-target-integration.test.ts test/integration/d09-backup-integrity.test.ts --reporter=dot：**38/38 PASS（27 unit + 6 安全真实一次性实例 E2E + 5 真实双租户备份恢复 E2E）**，两个单次测试容器组均无残留。日志确认上轮 127.0.0.1/localhost 同实例别名、错容器发布端口、显式源容器同名、源不可达均 fail-closed，未进入生产 DDL。
- live main == 本地 main == origin/main fbf32f0；Writer auto/released、无 active；工作区未跟踪 7 项为 config/、soak-r3b/、backup CI 回执 bacc849/fbf32f0、deploy CI 回执 27e9259/c22d23f、egress 回执 e28c386，已分类保留原状，零删改。
- read-only deploy/preflight.ts --json：**NO-GO**，process_vs_head UNKNOWN（运行生产进程为旧代码）；evidence_checks_config UNKNOWN；egress_stack UNKNOWN；db_migrations FAIL（0008/0009）；两个 systemd user 服务 active，PID 3242781、3242782 未变，无生产重启、备份或迁移。

## 局限与后续建议
- 协调方没有把 Agent/Reviewer 的自述作为测试替代，独立亲跑上述 38 项；CI 上的 host psql 分支仅有 exact-head CI 与日志证据，本轮未在 VM80 安装宿主 pg_dump/psql（不假称本人实跑）。
- M5-1：restore-target-verify.mjs 的 readInspectMapping 尚未拒绝 5432/tcp 之外的其他已发布端口；M5-2：探针后至 DDL 之间有 TOCTOU 窗口。当前均为 Reviewer 已登记的加固候选，须按真实威胁模型/误配置可达性评估，不以无实证的泛化担忧冒充 Major。源实例离线时当前身份门保守拒绝，灾难恢复需人工留证的替代流程，非自动 DR 验收。
- 准入决策转交 **RELAY-CUTOVER-READINESS-10**：先只读核四项 NO-GO、隔离切换预演与 D3 文件中过时顶注记，准备用户可理解的审批包；不自动选择 D3，也不动生产。MVP=REWORK，模型/UX/Pilot 仍未验收。

**协调方终裁：09R PASS（范围限定），生产 NO-GO 不变。**