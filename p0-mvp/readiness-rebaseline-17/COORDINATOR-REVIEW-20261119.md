# RELAY-MVP-READINESS-REBASELINE-17 · 协调方独立复核

日期：2026-11-19  
实施提交：`2c32f9f83c7db954940d1ff6903ee5e246e077b4`  
exact-head CI：`44425684041`

## 裁决

**PASS（0 Major；发现 1 项用户交接材料文案漂移，已在同次协调方收口提交中修正）**。  
下一阶段 **ENGINEERING_READY → USER_ACCEPTANCE**；**不启动新的开发大包**。这不是整个 MVP ACCEPTED，更不是生产 GO。

## 独立核验

- GitHub live main = VM80 本地 HEAD = origin/main = `2c32f9f83c7db954940d1ff6903ee5e246e077b4`；main-only；Writer 空闲，暂存区空；已存在的 76 项脏文件未清理。
- 与上一治理提交 `9db5c56` 的差分仅 **7 份中文文档与审计证据，+539/-0**；无产品代码、迁移、生产配置变更。
- exact-head GitHub Actions run `44425684041` 的 `test` 与 `e2e` 均 success：
  - unit：**191/191**；
  - 非浏览器：**517 passed / 103 skipped = 620**；
  - browser：**83 passed / 2 skipped = 85**。
  - 注意：门控 skip 保留，不能把 E2E 绿等同于真模型或生产测试。
- 协调方独立从当前本地 main 重跑六套隔离 E2E：**40/40 passed**（web-journey 7、three-dirs 4、dirty-project 6、webux12 15、result-truth 6、result-truth-16r 2）。
- **额外打破“脏工作树预览可用≈干净 GitHub 克隆可用”的假设**：在一次性目录中从本地 Git 克隆已提交 HEAD `2c32f9f83c7db954940d1ff6903ee5e246e077b4`（不携带工作树脏脚本），启动 `scripts/webux11-preview.mjs`，真实 HTTP 登录 **200**、Goal 创建 **201**，由自动 Tick 得到 Goal `COMPLETED` 与 changeset `DELIVERED`（本地 bare）。进程已退出，克隆已清理。明确：这是 **stub+本地 bare**，不是模型能力或外部 GitHub 成功。
- 协调方只读核查 `deploy/preflight.ts` 的探针性质，再独立运行生产只读预检。首次命令会话缺 systemd user bus 导致服务 `NOT_RUN`；按仓库既有环境约束显式设置 `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` 后重新执行，18 项裁决 **NO-GO**，与本包已保存证据核心结果一致：迁移 0008/0009 缺失、`RELAY_EVIDENCE_CHECKS_JSON` 未配置、运行中 PID 3242781/3242782 是旧代码、egress network/proxy 缺席、部署工作树被跟踪文件 dirty。未修改任何生产内容或服务。

## 对 17 矩阵的独立判断

1. **工程主路径在隔离/stub 测试边界下 READY**：事实覆盖了绑定、执行、Gate、changeset、交付、结果真实性和独立用户验收投影；旧 R-1 已闭合。该结论仅限 A 层。
2. **用户体验未验收**：Mac LAN 八项与手机 VPN 六项尚需用户真机；模拟 390 视口、旧截图、Agent 自述不能代替。
3. **真实模型业务能力未判定**：历史 F1-R/F2-R 已授权尝试但遭上游 502、零 token；第二轮已武装但未发起；不能写“已通过”，不能改写成“从未执行”。
4. **真实项目自然语言→GitHub 交付未验证**：本轮一次性 stub/bare 不能代替此项。
5. **生产继续 NO-GO**：D3 未授权，严禁自动迁移、补 env、清理 dirty、重启、外部写入。
6. **24h Pilot 后移**：ADR-0010 仅将空闲长稳移出 MVP 硬门，原 R-3 PARTIAL 不得倒填 PASS；真模型与真机/真实项目硬门保留。

## 非阻断交接材料漂移（本收口已纠正）

`MAC-ACCEPTANCE-CARD.md` 仍部分沿用 13/14 包口径：描述“已提交 GitHub”但预览实际只交付本地 bare；声称设置 `RELAY_PROJECTS_FILE` 可在预览中带项目，但 **GitHub 已提交版脚本无条件覆盖该变量**（VM80 本地只有一份未提交的适配差异）；旧截图被称为可代替实机体验。此类误导会影响用户对交付真相的理解。

协调方因此只修**交接说明**，不引入新代码包，不修改或提交那份历史 dirty 脚本。Mac 卡已经重写为“当前 main / 隔离 stub / 本地 bare / 用户验收独立 / 真机反馈唯一权威”的准确口径。

## 下一阶段及权限

唯一下一阶段：**用户本人 Mac LAN + 手机 VPN UX 验收**。现有操作卡是执行入口，当前没有新的 ACTIVE 编码包。用户若反馈具体 UX 阻断，再以真实截图/复现启动一个最小修复包；真实模型复验需窗口/额度/明确授权，生产切换需单独 D3。Agent 不得代写 UX ACCEPTED 或为“保持开发不断”制造新需求。
