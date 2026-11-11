# 总执行包·阶段 F:MVP 最终覆盖矩阵(重生成)

- 审计对象:live main `a8adcab`(总包提交链:`382edf7 A 合同 → … → 7f6f6c7 D 收尾 → 05c1473 E 合同 → f149b06 E 实现 → a8adcab E 处置`)
- 基线:`p0-accept/prd-coverage-matrix.md`(审计对象 02c094f)——本矩阵只列**变化项**与新增项;基线中 VERIFIED 且未被后续触碰的面继续有效(阶段 A~E 复核均未见回归)
- 六态定义同基线;纪律:不以测试数量代替覆盖率;不以 Mock/Stub 冒充真实;Stub 只佐证机械面并显式标注

## §1 用户故事变化(US-01~US-13)

| 项 | 基线裁决 | **终裁决** | 增量证据 |
| --- | --- | --- | --- |
| US-01 模糊目标(P0) | PARTIAL | **VERIFIED** | 模型面补齐:真模型 Discovery(模糊 UX 需求 → 问题陈述/带置信度假设/一个推荐/可判定验收,报告准确识别全部四项页面缺陷)——`p0-mvp/f1/discovery.json` + `test/integration/discovery.test.ts`(真模型门控 3 例绿;sources 指向真实文件)+ 持久化可回放(discoveries 表+SHA);原话保留/采纳装配(US-03 面)同链 |
| US-02 质疑与调研(P0 最小) | NOT_IMPLEMENTED | **VERIFIED(P0 最小)/公网 P1 NOT_IMPLEMENTED** | 本地项目只读调查一次+记录可回放 ✓(阶段 B);不合理方案可核查反驳 ✓(真模型:eval/同步阻塞/安全面,`discovery.test.ts` 真模型例 2);不可用调研能力显式说明 ✓(能力表+视图徽章);**公网 Search/Crawler 仍 NOT_IMPLEMENTED(P1,如实)** |
| US-04 控制(P0) | PARTIAL | **VERIFIED** | CLI 全量补齐:`src/cli.ts`+bin(七组命令;13 例测试)+ `relay pause` 置入入口(READY 状态门)+ 确定性退出码 + doctor;**V03 全程真实 CLI 演练**(零浏览器零 ChatGPT,`p0-rework2/v03-cli-journey.log`);三入口同 Core(REVIEW 亲验零第二状态机) |
| US-08 GitHub 集成(P0) | BLOCKED(403) | **VERIFIED(R-1 闭环;2026-11-12)** | 用户补权后 `github-real.test.ts` 全套通过:真实 main 写入 DELIVERED+远端/树/内容三重核对+漂移拒绝(外部写者快进被拒/历史只增不减/非 force)+独立 API 复核(`p0-mvp/r1-closure.md`;日志 `github-real-closure.log`;代理净化环境教训如实登记) |
| US-09 持续运行与预算(P0) | VERIFIED | **VERIFIED(长稳观察项单独列)** | 预算纪律全程(阶段 B/D 每轮事前声明,账本 reserve/settle 精确核算——REVIEW 亲验 5 轮 6/6);长稳 24h 观察进行中(见 §5) |
| US-03/05/06/07/10 | VERIFIED | **VERIFIED(复验+增量)** | US-03:+F1 采纳装配(discovery 验收条件 → 有界任务文本);US-05:+E1 真实进程 SIGKILL/重启复验(3/3);US-07:+F1 机判 Gate 拒绝零编辑候选+Reviewer 正确 REWORK 实锤;US-10:+Goal 页 Discovery 区块来源徽章(E2E J1 口径更新) |

## §2 验证矩阵变化(V01~V20)

| 项 | 基线 | **终裁决** | 增量证据 |
| --- | --- | --- | --- |
| V01 | PARTIAL | **VERIFIED** | 同 US-01(模型面真模型绿) |
| V03 | PARTIAL | **VERIFIED** | 同 US-04(阶段 A) |
| V08 | VERIFIED | **VERIFIED(+业务级实锤)** | F1:真模型 coder 零编辑 ⇒ 机判拒+REWORK;stub 改进 ⇒ 机判收+DELIVERED——机判 Gate 双向实证(`p0-mvp/f1/`) |
| V14 | VERIFIED(结构层) | **VERIFIED(结构层+真模型语料化)** | **T01 遗留补齐**:`test/integration/f3-injection.test.ts`(evil 语料真模型:目录 SHA 零变化/审计如实/语料当数据;Reviewer 另测变体非过拟合) |
| V19 | VERIFIED(13 表) | **VERIFIED(+Artifact 级)** | E3:整库 dump+跨 schema artifact manifest → 干净隔离容器恢复 → 交付 1/1 一致+全 schema 审计行+校验和;非只比 13 表行数 |
| 其余 V02/04/05/06/07/09/10/11/12/13/15/20 | VERIFIED | **VERIFIED(未见回归)** | 阶段 A~E 全量回归持续绿(237=220+15skip+2fail,2fail=github-real 403 凭据面);E1/F 增量未触碰其代码面 |

## §3 门矩阵变化(G0~G7)与 Fixtures

| 项 | 基线 | **终裁决** | 增量证据 |
| --- | --- | --- | --- |
| G0 Requirement | PARTIAL | **VERIFIED** | 模型 Discovery 提供可判定验收(真模型) |
| G6 Release | BLOCKED | **VERIFIED(R-1 闭环)** | 真实 GitHub 发布面全链:授权→候选→Gate→Intent→Executor→Observation→DELIVERED(独立 API 复核;漂移拒绝+历史保全) |
| G7 Runtime | PARTIAL | **PARTIAL(24h 观察进行中)** | E1 worker 入口/编排 VERIFIED;24h 空闲采集进行中(真实计时,未满不判);工作模式长稳受模型能力面约束(如实) |
| F1 模糊 UX | PARTIAL | **PARTIAL(机制 VERIFIED/真模型交付 PARTIAL)** | 机制全链(stub 显式标注):机判 4/4→DELIVERED→独立复核 ✓;真模型:Discovery 高质量 ✓、coder 方差(零编辑/烧回合/不完整修复)未过机判——诚实 PARTIAL,全部失败落账 |
| F2 明确 Bug | VERIFIED(等价面) | **PARTIAL(机制 VERIFIED/真模型交付 PARTIAL)** | 同 F1 模式:stub 机制链一次过(独立 HTTP 复核 4/4);真模型 coder 一轮 SUCCEEDED 修复不完整/一轮 BUDGET_EXHAUSTED |
| F3 故障注入越权 | VERIFIED | **VERIFIED(+T01 语料化)** | `p0-mvp/f3-matrix.md` 八项映射 + 真模型注入语料化 |
| **新增:清理安全(D4)** | — | **VERIFIED** | `src/runtime/safe-rm.ts` 中央守卫(纯逻辑;sentinel 必填):/、/tmp、HOME、仓库根及子树、roots 外、无哨兵、symlink 逃逸全拒;运行时 3+测试 ~17 处接入;回归 7/7;Reviewer 亲验 21 调用点 |

## §4 横切专项

| 专项 | **终裁决** | 证据 |
| --- | --- | --- |
| 真实模型能力 | **Discovery VERIFIED / 业务修改交付 PARTIAL** | magpie 本地模型面:Discovery 报告质量高且可回放;coder 在有界预算内未能产出通过业务级机判的修改(方差实锤)——**部署包依赖更强模型路由,如实登记** |
| CLI/API/Web 对等 | **VERIFIED** | 阶段 A(REVIEW 亲验三入口同 Core/零第二状态机)+ 阶段 B API discovery 对等 |
| 运行编排 | **VERIFIED** | E1:relay-worker 独立入口=唯一调度权威;Web 零第二调度;systemd 样例;claim 组合缺陷修正 |
| 数据/Artifact 恢复 | **VERIFIED** | E3(见 V19) |
| 清理安全 | **VERIFIED** | D4(见 §3) |
| 预算纪律 | **VERIFIED** | 全程先声明后执行;账本精确;零超预算;零成本(magpie 本地) |
| 长稳 24h | **PARTIAL(观察进行中)** | `p0-mvp/soak-24h/`(真实计时;启动时点 RSS 稳态 ~109MB≪400MB;采样器自动判定;未满不写 PASS) |
| 真实 GitHub 交付 | **VERIFIED(R-1 闭环)** | `p0-mvp/r1-closure.md`(三重核对+漂移拒绝+历史保全) |

## §5 终判

**MVP 判定:REWORK 维持**(不得 ACCEPTED)。理由(按"全部 P0 必需门通过才 ACCEPTED"标准):

1. ~~US-08/G6 真实 GitHub 写入 BLOCKED~~ **已解除(R-1 闭环,2026-11-12;VERIFIED)**。
2. **F1/F2 真模型业务交付 PARTIAL**——机制面全部 VERIFIED(机判 Gate/交付/独立复核/恢复),但本地 magpie 模型能力不足以稳定产出通过业务级机判的修改;需更强模型路由(部署包),不属于"降低验收"可豁免项。
3. **24h 长稳观察未满**——真实计时进行中,未满不判 PASS(合同明令)。

REWORK 剩余清单(全部有界、路径明确):
- R-1(用户):PAT 补沙箱仓 Repository access+Contents RW → `npx vitest run test/integration/github-real.test.ts` 闭环(无需新授权)。
- R-2(模型路由):业务交付需非 magpie 模型(用户授权模型后,F1/F2 真模型链路已就绪,重跑门控测试即闭环)。
- R-3(时间):24h 观察期满 → soak-final.json 判定 → REVIEW 确认。
- 全部证据绑 HEAD `a8adcab`;基线证据绑各包 REPORT 所记 HEAD。
