# RELAY-EGRESS-ISOLATION-07R 协调方独立审计（2026-11-14）

**结论：PASS（仅 07R 有界 Egress 隔离纠偏）；不代表生产部署 GO 或 Usable MVP 用户体验 ACCEPTED。**

## 已核实事实

- GitHub live main = `e28c386ad151557f0aeec83105eeccb803d4c6d4`，合同 b3dea03 至结果两次后续提交（实施 6749ed3，收口 e28c386），compare 文件仅 `egress.ts`、两类 Egress 测试、Security 文档、CURRENT/续接及报告证据。没有第二控制面、新依赖、生产迁移文件改动。GitHub Actions [43597388421](https://github.com/pwl1987/relay/actions/runs/43597388421) 与此 SHA 精确对应，test/e2e 两个 job 成功；实施 SHA 的 [43592822713](https://github.com/pwl1987/relay/actions/runs/43592822713) 同样成功。CI 由隔离 runner 执行，不等于 VM80 真生产测试。
- 在 VM80 亲跑 `npx vitest run test/unit/egress-isolation.test.ts --reporter=dot` ⇒ **20/20 PASS**；亲自调用代码 `createTestEgressScope('abcdefgh-one/two')` ⇒ 链名分别 `RELAY-EGRESS-1223599d`/`RELAY-EGRESS-12236d83`，原前 8 字符碰撞消失。
- 对照独立 Reviewer 留证的 `frntla` 与 `frntla-M`：VM80 亲测两者仍同链 `RELAY-EGRESS-b4888887`，但不同 ruleTag 且一方为另一方前缀；源码 `chainRulesStrict` 读失败保守拒绝、`chainScopeOwned` 对每条规则使用词边界 `lineHasTag`、`ensureEgress` 的 -F/-A 前置归属、`teardownEgress` 清链前复核，R9/R10 反例测试已包含。07R Agent 隔离 CI Egress 11/11 留证，独立 Reviewer 自建真机碰撞探针 Round1 发现子串穿透 REWORK，Round2 修复后双向 30/30 PASS（证据已入库，协调方本轮**未在 VM80 亲自运行破坏性双 scope Docker 实验**）。
- VM80 local main = GitHub SHA；本地未跟踪 `config/`、`p0-mvp/soak-r3b/`（均保护）和额外 `p0-mvp/egress-isolation-07/evidence/ci-checkruns-e28c386.json`（8534 字节、包含 GitHub check_runs、时间 2026-11-14 21:03:58），均已分类，不触碰、不混入合同提交。Writer 核查为 released/无 active task。
- 用户总线正确连接的**只读** `node deploy/preflight.ts --json` 再次得到 NO-GO：`db_migrations=FAIL`（缺 0008/0009），`evidence_checks_config=UNKNOWN`，`process_vs_head=UNKNOWN`（服务实际运行的仍是旧进程），`egress_stack=UNKNOWN`（默认网络与代理缺失）。两 systemd user unit 仍 active。**从未批准生产切换。**

## 遗留与下阶段裁决

- 07R 记录的 **Minor-4**：在 iptables -N 与首条 -A 间失败或进程崩溃可能遗留空链，fail-closed 阻止覆盖但需要人工处理；**Minor-3**：不同测试作用域派生端口可能碰撞并拒绝启动。这两项在当前合同下非阻断，后续按证据与优先级处理；不擅自改生产默认名、链或端口。
- 当前更阻断功能验收的是已有生产 schema 缺 0008/0009、真实 Gate 未配置；这些需要用户单独 D3 授权，不应借单元测试成功自动执行。下一包选择 `RELAY-DEPLOY-REHEARSAL-08`，**只在隔离合成数据及独立 schema 验证可控增量升级、备份/恢复与功能性检查，形成提交 D3 的决策材料**。07R 按已核实范围独立 PASS。
