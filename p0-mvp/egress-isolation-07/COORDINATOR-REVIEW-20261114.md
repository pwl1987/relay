# RELAY-EGRESS-ISOLATION-07 协调方独立审计（2026-11-14）

**裁决：REWORK，Major-1（跨作用域 iptables 链名碰撞）。** 07 Agent 的工程成果和 CI 真实存在，但原有 PASS 只代表旧测试覆盖的情况；没有证明所有不同合法 scope 真隔离。

## 已核实证据

- GitHub live main 为 a31d9479a0180c9e2e88c8b31dc514e7b49db878；合同比较 5cca5a8..a31d947 为 2 提交；exact-head CI [43579979419](https://github.com/pwl1987/relay/actions/runs/43579979419) test/e2e 双成功，实施提交 a88b0f4 对应的 CI 43575650845 亦双绿；存档日志报告隔离 E2E 6/6。不能把 CI 通过当作未覆盖负向场景通过。
- VM80 本地 main 与 GitHub main 同步，原有两个未跟踪受保护目录仍在；Writer 已释放。独立运行 npx vitest run test/unit/egress-isolation.test.ts --reporter=verbose 为 10/10 PASS（mock-only，未操作宿主默认网络）。
- 直接在 VM80 运行现有 createTestEgressScope 纯函数：abcdefgh-one 与 abcdefgh-two 的网络/代理容器/规则标记/端口各不相同，链名却**同为 RELAY-EGRESS-abcdefgh**。例如端口 27744 与 32838，规则标记分别为 relay-test-abcdefgh-one 与 relay-test-abcdefgh-two。此名称碰撞是**独立亲测事实**。
- 源码 src/runtime/egress.ts：chainNameFor 对合法 ID 只 slice(0,8)；ensureEgress 若缺第二作用域 port/tag 规则会执行 iptables -F scope.chain 并改写规则；teardownEgress 的 owned chain 注册只用物理链名，存在跨 scope 误清风险。**实际跨作用域破坏性清链尚未在隔离 Docker 实跑**，属于代码可达风险，下一包必须 mock 先红、CI 双 scope 真运行后才可关闭。
- 原测试固定唯一测试作用域 ID，未覆盖两个不同合法 ID 的链名碰撞；原报告的“全资源隔离”结论因此不能接受。

## 最小纠偏

唯一 ACTIVE 合同为 **RELAY-EGRESS-ISOLATION-07R**，见根 CURRENT.md。修复不仅应避免前八字符碰撞，还须在强制同链/摘要碰撞情况下 fail-closed、不碰他人资源；所有旧 E2E 必须保持通过。禁止在生产宿主默认链上运行破坏性复现，生产部署仍 NO-GO。
