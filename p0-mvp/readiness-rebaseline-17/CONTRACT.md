# RELAY-MVP-READINESS-REBASELINE-17 · ACTIVE 合同

状态：**ACTIVE**  
Writer：本地开发 Agent（单 Writer）  
基线：`6a2f51fe6d00510b7424c2dc04998447eefe2d7c` 的后继治理提交  
性质：当前主线 MVP 重新基线 / 准入审计  
生产权限：**无**

## 一、最终目标

不要继续按历史 backlog 机械加功能。以当前 live main 为唯一事实源，重新回答：

1. Relay 当前已经做到什么程度？
2. 哪些历史 MVP 缺口已经被 11R～16R 实际解决？
3. 哪些仍是工程阻断？
4. 哪些其实属于用户 UX 验收、真实模型能力、生产 D3，而不应再混入“工程未完成”？
5. 下一阶段真正值得做的最小包是什么，或者是否应该停止编码等待用户/生产决策？

## 二、必须重新核对的权威资料

至少读取并交叉核对：

- `CURRENT.md`
- `docs/PRD.md`
- `docs/DETAILED_ARCHITECTURE.md`
- `docs/VALIDATION_PLAN.md`
- `ADR/0010*`
- `ADR/0011*`
- `p0-mvp/final-coverage-matrix.md`
- `p0-mvp/REPORT-final.md`
- 11R、12、12R、13、14、15、16/16R 的实施/复核记录
- live code 与 exact-head CI

旧报告只能作历史证据，不得高于当前代码与 live main。

## 三、必须分开的四个准入层

禁止再把不同门混成一个“REWORK”：

### A. Engineering Usable
本地/隔离环境能否完成：
需求创建 → 项目绑定 → Discovery/执行 → 测试 → Reviewer/Gate → changeset → 仓库交付 → 结果展示 → 用户接受/拒绝。

### B. User UX Acceptance
Mac/手机真实用户是否觉得界面、流程、文案可用。此项只能由用户本人 ACCEPTED/REWORK，Agent 不得代判。

### C. Model Capability
真实模型在当前 Runtime 下是否具有足够编码质量/稳定性。R-2 历史 PARTIAL/UNRESOLVED 必须与工程链路是否正确分开。

### D. Production Cutover
生产迁移、evidence 配置、进程版本、egress、重启等是否满足 GO。任何生产写入/迁移/重启仍须用户 D3，本包只允许只读核对。

## 四、执行要求

### 1. 重建当前覆盖矩阵

以当前 main 重新生成一份新的 readiness matrix，不修改历史矩阵原文。每项只能标：

- VERIFIED：有当前代码/测试/CI/独立实证；
- PARTIAL：一部分成立，边界明确；
- BLOCKED：需要用户授权/外部条件；
- NOT_VERIFIED：当前没有足够证据；
- N/A：已被 ADR 明确移出该层准入。

每项必须附证据来源；Agent 自述不能作为唯一证据。

### 2. 对历史 REWORK 逐项消账

逐项核对旧 `final-coverage-matrix.md` 的未通过项，明确：

- 已由哪个提交/测试实际解决；
- 仍未解决；
- 已被 ADR-0010 重分类；
- 已转成用户决策或生产 D3。

禁止为了让矩阵变绿而改口径。

### 3. 当前主路径独立冒烟

在零生产条件下至少做一次最新 main 的隔离主路径验证：

- clean Git 注册项目；
- Goal 创建与冻结绑定；
- Worker/执行链；
- Gate/changeset；
- 本地 bare 交付；
- 结果页 provenance / delivery truth；
- 用户接受结果；
- 新版本出现后旧验收不污染当前结果；
- 用户拒绝结果不改变内部 Gate。

允许 stub 作为确定性工程链验证，但必须显式标注；不得把 stub 成功写成真实模型能力通过。

### 4. 只读生产 readiness 刷新

只读核对历史生产 NO-GO 项是否仍成立：

- migrations 0008/0009；
- RELAY_EVIDENCE_CHECKS_JSON；
- 线上进程是否仍旧于当前 main；
- egress readiness；
- 其他 Runbook 明确前置项。

不得 apply migration、改 env、restart、写凭据、改生产数据。

## 五、输出必须形成一个“真实下一步裁决”

最终只能推荐以下之一：

1. **ENGINEERING_READY → USER_ACCEPTANCE**  
   工程主链已够用，停止新增功能，交给用户实机体验。

2. **ENGINEERING_READY → MODEL_CAPABILITY**  
   工程链已够用，但真实模型能力仍是唯一合理下一包。

3. **ENGINEERING_READY → PRE-D3**  
   工程链已够用，下一步只应准备生产 D3 决策材料，不实施生产。

4. **REWORK → 一个最小工程包**  
   只有发现当前主路径真实 Major 时，才允许提出一个最小修复包，并必须给出反例。

不得为了“还有东西可以优化”而继续创建泛化重构包。

## 六、默认禁止

- 新增架构层；
- 新表/migration；
- 大规模 UI 重做；
- 生产写入/重启/配置；
- 真实 GitHub 外部交付；
- 清理历史 dirty/protected 文件；
- 把历史 Minor 候选自动升级成当前任务；
- 把用户 UX 未验收误写成工程 REWORK。

## 七、完成定义

- 新 readiness matrix 已生成；
- 旧 MVP REWORK 已逐项重新分类；
- 最新主路径有独立实证；
- 四层准入完全分开；
- 生产只读刷新完成；
- 给出唯一下一阶段建议及理由；
- 若没有工程 Major，不改产品代码；
- quality/文档检查与 exact-head CI 通过；
- 独立 Reviewer PASS。
