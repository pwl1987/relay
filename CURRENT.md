# Relay 当前执行契约

- 状态:**总授权执行包 · 阶段 A(REWORK-2 最小 CLI)ACTIVE**。授权来源:用户 2026-11-11"MVP 收敛与最终验收总执行包"(六阶段 A~F 连续执行授权;每子包仍须独立合同/实现/复核/CI/推送)。上一包 P0-ACCEPT 已闭环(`3069aa1`,CI success)。
- 写者:**本窗口唯一 Writer**(main-only;禁强推/禁其他分支)。
- 冷启动基线(2026-11-11 复核):本地 HEAD == origin/main == `3069aa101df8b1ecbe505fa846a761870acbaa5e`;工作区 clean;CI run `42952099140` success;PG 容器健康;Node v24.21.0。

## 本包范围(阶段 A:REWORK-2,US-04/V03 闭合)——已实现,待复核/CI

1. **Core 最小增量**:`src/core/ops.ts` 新增 `pauseTask`(READY→PAUSED 置入;actor+expectedStateVersion+合法转移+审计同 resumeTask 口径;租约链不打断)✅
2. **CLI**:`src/cli.ts` + `bin/relay.mjs` + package.json bin;命令集 goal create/list/show、decision list/resolve/defer、task resume、pause、worker tick(--stub/--seed)、status、doctor ✅(三入口同调 Core;零新依赖)
3. **API 对等**:`POST /api/tasks/:id/pause`(同一 pauseTask)+ 能力登记表 `cli.entry`/`task.pause` 两行 ✅
4. **doctor**:只读(13 表迁移面+守卫/provider 可见性/Pi/docker/凭据存在性零明文/阻断面);逐项容错 ✅
5. **退出码**:0/1/2/3/4/5 确定性 ✅
6. **测试 ≥8 例**:`test/integration/cli.test.ts` **10 例全绿**(含 PAUSED 阻断 claimNextReady 实证、API 对等 401/200/409、bin 真实进程 exit 0/5、stub tick 单拍 ACCEPTED、控制面零模型 Run)✅
7. **V03 演练**:`p0-rework2/v03-journey.sh` + `v03-cli-journey.log` 真实进程全程(doctor→create→pause→重复 pause exit3→resume→stub tick ACCEPTED→show/decision/status)✅
8. **报告**:`p0-rework2/REPORT.md` ✅;待独立 Reviewer + CI 绿 + 快进推送。

全量回归(本机无并发窗口,处置后终账):**216 例 = 207 passed + 7 skipped + 2 failed(50 文件)**;2 failed = github-real PAT 403 凭据面(用户侧单点);egress-proxy/live-worker-e2e 前轮间歇失败(magpie 环境型,隔离复跑绿);tsc 0。独立复核:`p0-rework2/REVIEW.md` **PASS-WITH-FIXES**;两处 Major(RUNNING 可被 pause 打断租约 / CLI defer 无 operator 门)已修复并补 3 例回归(cli.test.ts 13 例全绿)。

## 验收标准(不可降低)

- V03:不连 ChatGPT、不开浏览器,控制操作全部经 CLI 独立完成且状态与 API/DB 一致。
- 未授权 actor、旧 state_version、非法转移、重复操作正确拒绝且有审计行。
- 全部命令确定性退出码;控制面命令不触发任何模型请求。
- PAUSED 实证阻断领取;SIGKILL 后状态不丢(既有 V04 语义不被 CLI 破坏)。

## 安全边界(总包继承)

不生产部署;不 RSI;不扩大 Token/模型预算/文件权限/仓库写入范围;D3 永不自动批准;不触碰其他业务仓库;禁宽权限 gh token;遇到 D3/生产风险/权限扩大/预算扩大/数据破坏风险即阻断并说明。
