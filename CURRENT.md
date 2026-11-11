# Relay 当前执行契约

- 状态:**总授权执行包 · 阶段 A(REWORK-2)CLOSED / 阶段 B(REWORK-1 Discovery)NOT_ACTIVE(合同起草中)**。完成:2026-11-11。终态以远端 `main` 为准(`70b94c5`;CI run `42965135078` test+e2e 双绿)。
- 写者:阶段 A 已释放;**阶段 B 由本窗口继续担任唯一 Writer**(合同先行)。
- 提交链:`3069aa1 → 382edf7(A 合同)→ f748441(A 实现)→ 9b87e69(复核处置)→ 70b94c5(CI 处置)`。

## 阶段 A 终账(REWORK-2;证据见 `p0-rework2/`)

- **交付**:Core `pauseTask`(READY 状态门 + actor/version/审计同口径)+ `src/cli.ts` + `bin/relay.mjs`(零新依赖;goal create/list/show、decision list/resolve/defer、task resume、pause、worker tick(--stub 命名空间 env/--seed)、status、doctor 逐项容错)+ API `POST /api/tasks/:id/pause` + 能力登记 `cli.entry`/`task.pause` + 确定性退出码 0/1/2/3/4/5。
- **验收**:V03 全程真实 CLI 演练(`v03-journey.sh`/`v03-cli-journey.log`,零浏览器零 ChatGPT;stub 如实标注);PAUSED 阻断领取实证;CLI/API 同 Core 对等;控制面零模型 Run。
- **独立复核**:`p0-rework2/REVIEW.md` PASS-WITH-FIXES;**Major-1**(RUNNING 可被 pause 打断租约)→ READY 状态门;**Major-2**(CLI defer 无 operator 门)→ 授权下沉 Core deferDecision;Minor×4 修复/登记。
- **测试**:cli.test.ts **13 例全绿**;全量终账(本机)216=207+7skip+2fail(2fail=github-real 403 凭据面;magpie 间歇与 CI 无关);tsc 0;CI test+e2e 双绿。
- **US-04/V03 裁决:VERIFIED**(PRD 覆盖矩阵待阶段 F 统一重生成)。

## 阶段 B 范围(下一步:REWORK-1 模型驱动 Discovery,US-02 P0 最小 + US-01 模型面)

1. 先起草 ACTIVE 合同独立提交,再实施。
2. Goal 创建后一次真实模型分析(magpie 本地路由):问题陈述/关键假设及置信度/风险/方案比较/推荐行动/可判定验收/仍需人决事项;调研来源引用路径;可回放记录(复用 runs/budget_ledger/Evidence,零第二状态机)。
3. 失败如实降级规则面并标注来源(模型/规则/未实现三态);不伪造 Discovery 成功;预算经账本,超额即停;禁无限重复调用。
4. 项目文档内恶意指令不得改变工具权限(结构层防线不变)。
5. 真实验收:模糊需求调查/不合理方案反驳/不完整需求形成可判定验收/注入抵抗/预算耗尽停止/断线恢复不伪造隐状态/独立 Reviewer。
6. 能力登记表 `goal.discovery.model`/`goal.recommendation.model` 从 NOT_IMPLEMENTED 改为有证据状态;Goal 页展示分析来源徽章。
7. 安全边界(总包继承):不生产部署/不 RSI/不扩权/不加预算/D3 永不自动批准/每轮真实模型试验先声明预算。

## 遗留(结转)

1. github-real 403(PAT 缺沙箱仓 Contents RW;用户侧单点,补权后 `npx vitest run test/integration/github-real.test.ts` 闭环)。
2. 本机代理栈上游断(宿主运维;git push 暂走 ssh.github.com:443 通道)。
3. 登记遗留维持:R-2(XFF)/R-5(Origin:null)/T01 模型级注入语料化/stage 仓回收/base 纵深(F-12)/toolEvents 宿主副本并入 REWORK-1。
