# RELAY-QUALITY-LOCAL-01 最终报告

状态：**实施完成，待独立 Reviewer 与 exact-head CI 终验**
日期：2026-11-13
合同：CURRENT.md「RELAY-QUALITY-LOCAL-01 ACTIVE」（登记提交 2b57f04）
前置收口：RELAY-ARCH-FREEZE-01（60a970b，独立审计 PASS）

## 1. 基线与 Writer

- 开工 live main = dcb26cd（与本地一致 0/0）；合同登记后推送链 60a970b → 2b57f04，exact-head CI 见 §8。
- Writer：本窗口唯一；main-only 快进推送；未跟踪受保护 `config/`、`p0-mvp/soak-r3b/` 全程零触碰（`git status` 仅此两项）。
- 生产影响：零（未触碰 relay-web/relay-worker/生产 schema/生产凭据；无模型调用）。

## 2. 上一包独立复核（阶段 A 摘要）

裁决：**RELAY-ARCH-FREEZE-01 = PASS（收口）**。A1~A5/A7/A8 PASS；A3/A4 设计层 PASS（OPEN 项如实标注）；A6 判 REWORK——属实现缺口非设计缺陷，修复列入本包阶段 D。详见 CURRENT.md 收口行与 docs/CONTINUATION.md 对应节。

## 3. 本轮代码/文件修改范围

**质量流水线（阶段 C）**：
- `biome.jsonc`（新增）：唯一格式/Lint 配置（2 空格/120 宽；基线降级规则全部留注释）；本地与 CI 复用。
- `scripts/quality.mjs`（新增）：quick/full/release 三级统一入口；每步 PASS/FAILED/NOT_RUN + 命令 + 退出码 + 时长 + 日志，证据 JSON 落 `test-evidence/`（gitignore）。
- `package.json`：`quality:quick/full/release` 三命令；devDependencies 精确固定 `@biomejs/biome@2.6.7`（唯一新依赖）。
- `.github/workflows/ci.yml`：test job 改跑 `quality:full`（除浏览器，`RELAY_QUALITY_SKIP_BROWSER=1` 显式 NOT_RUN）；e2e job 与 runner browser 步骤同一命令；格式检查范围 = `RELAY_QUALITY_BASE_SHA`(push before)..HEAD 变更集。
- 基线微修（行为中性）：`noImplicitAnyLet`×3 补类型注解（git-candidate/workspace-manifest）；`noAssignInExpressions`×2 循环重构（pi-rpc/stub-pi）；`icon.svg` 补 `<title>`；unused 规则降 warn（历史 ~55 处，清理列后续）。

**Gate 最低机器证据（阶段 D，反例先行）**：
- 反例实证（修复前，入库证据 `p0-mvp/quality-local-01/evidence/counterexample-prefix-run.log`）：代码变更候选 + 零机器检查 + 仅 reviewer_output ⇒ **ACCEPTED**（`reviewer_output` 计入证据非空检查即过）；`gate_required=false` 为显式豁免通道。
- 修复（最小，不新增第二套 Gate/规则引擎/质量库）：
  - `src/core/gates.ts`：`isDocsOnlyChanges`（确定性 N/A 规则：全 .md/.markdown；空清单视同代码变更 fail-closed）；PASS + 代码变更候选必须含 ≥1 机器证据（`MACHINE_EVIDENCE_KINDS`）；record/consume 双侧同规则（纵深防御）。
  - `src/core/gate-orchestrator.ts`：机器证据预检三级——显式 checks > 注入 `manifestVerify`（内建候选清单复验）> 保守停机 NEEDS_DECISION（不烧 Reviewer）；`gate_required=false` + 代码变更仍强制 Gate（`GATE_REQUIRED_OVERRIDE` 审计）；docs-only/无变更集保留 SKIPPED。
  - `src/runtime/workspace-manifest.ts`：`verifyCandidateManifest`（重采清单比对 candidate_sha + 拦截零编辑空提交）。
  - `src/core/evidence.ts`：kind 增 `candidate_manifest_verify`；`src/server/worker.ts`：注入 manifestVerify（纯验证；落库统一由 orchestrator 单点执行）。
  - 生产语义：默认机器证据=候选清单复验（真实确定性语义：交付内容与 Gate 绑定面一致且非空）；任务级更强检查经 `evidenceChecks` 配置（全部旅程测试已具备）。

**测试（阶段 D/F）**：
- 新增 `test/integration/gate-machine-evidence.test.ts`（7 用例）：反例 A（修复后不 ACCEPTED 且零 Reviewer 消耗）、反例 B（docs-only 豁免保留）、纵深防御（直录 PASS 拒绝）、D6 豁免通道关闭、合法 SKIPPED 保留、manifest 兜底通过/拦截。
- 夹具更新：`gate-orchestrator.test.ts` 4 用例、`delivery.test.ts` 1 用例补恒真确定性检查（原夹具在预检语义下不再走到裁决消费路径，属夹具缺陷非产品缺陷）。

## 4. 质量入口实测（阶段 F）

- `quality:quick`：**PASS**（lint 0 error + format 变更集 0 差异 + typecheck + 单测 17 文件 105 用例）。
- `quality:full`：首轮发现 cli/delivery 2 处夹具未配机器检查（已修，属夹具缺陷）；次轮 271 过 + github-real 2 例失败——**归因=基础设施**（VM80 出口链路瞬断 + 跨 run 沙箱远端资源竞争；失败签名 `remote_drift` CONFLICT 恰为 Relay 防漂移语义正确拒绝；非本 diff 产品缺陷，同工作树早前轮次 github-real 通过）。两轮有界复跑定性（零代码修复）后第三轮 **github-real 4/4 全绿**（写入 16s/漂移 20s）。
- `quality:release`：**PASS**（evidence=test-evidence/quality-release-2026-11-13T08-25-54/；步骤 lint 0.5s/format 0.4s/typecheck 9.3s/unit 11.2s/pg 复用/tests 243.2s/browser 109.4s/backup-restore 7.9s 全 PASS；tests=56 文件 273 用例全过 + 50 环境门禁 skip 可见；github-real 真实远端 4/4 含一次真实 main 写入+漂移拒绝实验；备份→隔离实例恢复 13 表全实体核对一致）。
- NOT_RUN 显式登记（不伪装）：性能（无实测基线，不虚构阈值）；模型门禁 e2e（RELAY_A4_E2E/RELAY_GATE_E2E/RELAY_EGRESS_E2E/pi-e2e，需独立授权）；生产部署验证（不在本包授权）。
- 跳过区分：环境门禁 skip（如 RELAY_E2E 关闭时浏览器用例）在 vitest 输出可见，证据 JSON 含 skip 计数；非模型消耗类 skip 不影响 full 裁决。

## 5. 格式/Lint 基线（C5，可审计）

- 历史 format 偏差：**123 处 / 20 文件**（清单 `test-evidence/quality-baseline/format-baseline-files.txt`），根因=历史超长单行对象/签名（>120 字符）；本包不做全仓重排，仅在触达文件内对齐。
- 历史 lint 偏差：93 warn + 3 info（unused 变量/导入 ~55 处集中在 test/ 与 web/ 旧脚本；useArrowFunction/useLiteralKeys/noNonNullAssertion/useTemplate 等按仓库惯用法降级，全部在 biome.jsonc 注释留痕）。
- 新增/修改代码：全部通过 error 级检查（lint 0 error + format 0 差异）。

## 6. 差距登记（阶段 E）

见 `p0-mvp/quality-local-01/GAP-REGISTER.md`（8 项，只读）：E-1/E-7/E-8 已符合设计；E-3（steer/abort）、E-4（接管/交还）、E-2（终态 Goal 消息）为 P1；E-5/E-6 为 P2。后续大包建议=「用户控制面最小实现」（E-3+E-4+E-2 共享 ControlCommand 审计面）。

## 7. 风险与回滚

- 风险①：生产代码任务在新 Gate 下依赖 manifest 兜底——若 Run 工作区在 Gate 前被清理，复验失败 → NEEDS_DECISION（保守停机，可经 ops 恢复重跑；不会假通过）。
- 风险②：manifest 复验弱于任务级测试——它是完整性下限而非功能验证；更强检查经 evidenceChecks 配置（旅程测试已示范）。
- 回滚：整包单提交，`git revert` 即回滚；Gate 行为回退到 reviewer-only 语义（即本包修复前状态）。
- 未验证项：真实模型 E2E（门禁关闭）；生产部署行为（未触碰）；release 性能专项（无基线）。

## 8. 提交与 CI

- 实施提交 SHA：`de3ba229ac4560e705f9459cd8afe62a141e6782`（17 文件，+1446/-121；逐文件点名，再生证据已 restore 未混入）。
- 合同链：60a970b（ARCH-FREEZE-01 收口）→ 2b57f04（本包合同登记）→ de3ba22（实施）→ 收口提交（见 CURRENT.md）。
- exact-head CI：**run 43398045983 @ de3ba22 = success**（test job=quality:full 除浏览器 2m44s ✓；e2e job=浏览器旅程 2m13s ✓；https://github.com/pwl1987/relay/actions/runs/43398045983）。
- 推送方式：main-only 快进；直连超时后按合同经 VM80 代理 127.0.0.1:8118（未改系统全局代理，未输出凭据）。
- 干净树 quality:quick 复验：PASS（format=NOT_RUN no_changed_files，M-1 关闭验证）。

## 9. 独立 Reviewer（阶段 G）

- **首轮裁决：REWORK（范围收窄）**——A~H 八项中 A/B/C/D/E/F/G/H 全部 PASS 或 PASS-with-Minor；Gate 修复本体"语义正确、证据真实、测试充分，可达 PASS"；唯一 Major M-1=quality.mjs changedFiles 与 biome includes 不相交（干净树上假 FAILED）。完整报告=同目录 REVIEW-QUALITY-LOCAL-01.md。
- **消化**：M-1（includes 根过滤+受保护文件排除+空集 NOT_RUN）+ m-1~m-6 全部；复验=typecheck OK + lint 0 error + gate 相关 37/37 绿 + quality:quick PASS（修复后）+ 干净树 changedFiles 模拟通过。
- **终裁：PASS**（第二轮复验，同日）——M-1 实证关闭、m-1~m-6 全消化零漂移；条件=①逐文件点名提交 ②exact-head CI 双 job 绿为权威终验 ③按真实 SHA 收口。残留登记 r-1（37/37 以 CI 为权威）、r-2（push 仅删文件时 format 响亮失败，择期）。
