# RELAY-DEPLOY-REHEARSAL-08 协调方独立审计（2026-11-15）

**裁决：REWORK（Major-S1；临时 PostgreSQL E2E 暴露不必要的宿主网络接口）。** 08 有真实实现与测试结果，但不可将 CI 双绿自动视为测试安全边界验收。

## 已核实
- GitHub live main 27e9259fc39b1d7e5e894e20bcabec41a5518f01；合同 241893d、实施 071210e、CI 预备修复 16fb5e2、收口 27e9259。exact-head GitHub Actions 43609188075 test/e2e 全部成功，逐任务步骤亦核实；早先 43608012978 因 pg_isready 早通失败，后续 SELECT 1 就绪修复有新 CI 证据。
- 独立审查了新增的迁移脚本、D3 决策文档、E2E 与 Gate 的真实执行路线。VM80 上单独安全运行 test/integration/deploy-rehearsal.test.ts 与 test/integration/evidence-gate-rehearsal.test.ts：**12/12 通过**。未重跑存在 -P 的临时 PG E2E，以免重现端口暴露。已知的备份审计索引 F-1 未修，08 自身如实登记。
- VM80 local main==origin/main==live main；Writer 已释放、无 active task；四个未跟踪对象已识别：config/、p0-mvp/soak-r3b/、p0-mvp/deploy-rehearsal-08/evidence/ci-checkruns-27e9259.json、p0-mvp/egress-isolation-07/evidence/ci-checkruns-e28c386.json，保持原样。

## Major-S1 实证与界限
- test/integration/deploy-rehearsal-e2e.test.ts 中 docker run -d ... -P postgres:17-alpine。Docker -P 自动发布镜像声明端口到随机宿主端口；脚本随后从 docker port 提取端口并在客户端连接 127.0.0.1。客户端使用回环**不能证明**容器的宿主发布地址仅为回环。
- VM80 只读 docker network inspect bridge 返回 com.docker.network.bridge.host_binding_ipv4=0.0.0.0；docker run --help 将 -P 解释为 publish-all。E2E 源码注释甚至明确写出 -P 默认只绑定 0.0.0.0。此路径可能对宿主 LAN 接口发布短期测试数据库，与多租户开发宿主的最小暴露原则冲突。
- **未检测或断言存在外部访问、攻击、凭据泄露或公网可达。** 网络层还受防火墙/路由影响；这里判定的是应用代码直接选择了不必要的 wildcard HostIp，不应依赖外围 ACL。原 CI 没有断言 Docker inspect HostIp，因此不能证明安全。
- 生产只读预检仍 NO-GO：db_migrations FAIL(0008/0009)、evidence_checks_config UNKNOWN、process_vs_head UNKNOWN、egress_stack UNKNOWN；relay-web/relay-worker MainPID 仍是 3242781/3242782，无重启/配置/DB 写入。

## 处置与下一包
唯一 ACTIVE 合同 **RELAY-DEPLOY-REHEARSAL-08R**：改为明确 127.0.0.1 随机端口发布，inspect 保证只映射回环并在失败时清理，先 mock 反例再隔离真实 E2E，独立 Reviewer/CI 复核。保持 08 迁移/Gate 已有成果，禁止生产操作。待该安全缺陷关闭后，优先解决 F-1 备份审计索引路径，D3 仍须用户单独授权。
