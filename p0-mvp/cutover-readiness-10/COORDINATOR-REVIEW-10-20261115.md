# RELAY-CUTOVER-READINESS-10 协调方独立复核（2026-11-15）

**结论：PASS / PRE-D3 READY，仅指可提交用户生产审批的技术材料齐备，生产执行仍 NO-GO。**

## 真正独立核验
- GitHub live main `02348b6d4a3eed234d1c28abd353ea1fbc4ca256`，合同 `581eee6`→实施 `2fb8a78`→收口 `02348b6`；[exact-head CI 43719744791](https://github.com/pwl1987/relay/actions/runs/43719744791) test/e2e 两 job 完整 success，[实施提交 CI 43719135177](https://github.com/pwl1987/relay/actions/runs/43719135177) 同样两 job success；实际 diff 只修改 CURRENT/CONTINUATION/D3 材料，并增加独立 d10 仿真测试与中文 REPORT/REVIEW/Evidence，未修改生产服务或核心状态机。
- 独立运行 `npx vitest run test/integration/d10-cutover-simulation.test.ts test/integration/deploy-rehearsal.test.ts test/integration/evidence-gate-rehearsal.test.ts --reporter=dot`：**3 test files，17/17 PASS**（d10 5、增量迁移 9、Gate 3），真实一次性 Postgres、备份/恢复/迁移路径成功，用后 d10 容器零残留；Agent 所称 56/56 为其本地+CI 证据，协调方没有冒称自己重跑全部 56 项。
- 亲读 d10 测试：先备份目标 schema 且只含预期 16 表、09R 隔离恢复到独立库、真实迁移文件模拟 0008/0009、真实 preflight 指向模拟库的 db_migrations FAIL→PASS 但总体仍非 GO、旧代码兼容/断点恢复/Gate 配置负例；合成数据与真实生产差异明确，未以测试模拟假冒生产切换。
- VM80 `main == origin/main == live main`，Writer auto/released 无 active；本地 8 项受保护未跟踪物 config/、soak-r3b/ 与 6 份 CI 回执未删除/修改/入提交。
- 生产只读 `deploy/preflight.ts --json` 本轮复跑：**NO-GO**，四项为 db_migrations FAIL(0008/0009)、evidence_checks_config UNKNOWN、process_vs_head UNKNOWN、egress_stack UNKNOWN；其他 14 项 PASS，包括 Web LAN 绑定、数据库可达、db_inflight、systemd user 服务及证据权限。故生产 GO 尚不成立，且用户并未批准 D3。

## 技术判断与下一步
- 原 D3 材料在本包内更新了具体对象/七步顺序/失败停机/回滚/来源与验收分层，作为**可提交用户的审批材料**合理。材料 PASS ≠ 生产准备全部 PASS；不能自动给 Agent 启动生产迁移、真实备份或重启。
- 不选择立即实施 MODEL-POLICY-01：`docs/MODEL_POLICY.md` 明确“激活前置：MVP 最终 ACCEPTED 后”，而当前 MVP=REWORK，真实模型 F1/F2 能力尚未稳定验收。无权为了当前需求绕过冻结约束。
- WEB-UX-03 工程已通过但用户 Mac 实机 UX 仍未 ACCEPTED；早期用户明确提出“打开后不知从何开始”，真实用户价值优先于继续堆新预备脚本。下一唯一 ACTIVE 设为 RELAY-WEB-UX-ACCEPTANCE-11：基于真实前端和隔离浏览器完成首次使用阻断排障及中文操作交接；除非有可复现障碍，不为审计而制造 UI 改动，不替用户验收。

**最终裁决：10 PASS/PRE-D3 READY；生产 NO-GO；用户 D3 审批尚未发生。**