# P0-ACCEPT:缺口清单与有界 REWORK 工作包

- 裁决基线:`02c094f`;MVP 判定 **REWORK**(三个有界缺口;其余大面积 VERIFIED)
- 原则:按影响依赖拆包,不并入无限扩大包;每包独立合同/验收/复核

## §1 阻断与受限项(非 REWORK,前置条件)

| 项 | 状态 | 解除条件 |
| --- | --- | --- |
| 真实 GitHub 写入 + 漂移实验(US-08/G6) | **BLOCKED(出口网络故障)** | VM80 出口恢复(`curl https://api.github.com` 非 000)→ 跑 `github-real.test.ts` 补录(无需新授权;凭据形态已 PASS:93B github_pat_ 0600) |
| main 快进推送(本包 4bd4168..02c094f) | 待网络 | 恢复后核对远端 HEAD==f4c1248 无漂移 → 快进 |

## §2 有界 REWORK 工作包(建议顺序)

### REWORK-1:模型驱动 Discovery 与分析(P0;US-02 P0 最小 + US-01 模型面)

- **为什么 P0**:PRD Must 明列"最小 Discovery";现状 `goal.discovery.model`/`goal.recommendation.model` NOT_IMPLEMENTED,US-01/02 仅确定性规则面。
- **范围(有界)**:Goal 创建后一次真实模型分析调用(问题陈述/假设/风险/推荐行动/仍需人决事项),写入可回放的记录(复用 runs/budget_ledger/Evidence 面);Fail 时如实降级到确定性规则并显式标注;**不复制第二套状态机**(全部经 core);页面/API 显示分析来源徽章(模型/规则/未实现三态)。
- **验收标准**:US-01 验收(保留原话/可核查假设/一个推荐行动/可判定条件)+ US-02 P0 最小(对已注册项目本地代码与文档调查一次,记录可回放)+ 预算经账本 + 独立 Reviewer。
- **依赖**:magpie(或有效模型路由);无网络依赖(本地路由即可)。
- **规模预估**:最小垂直切片(1 个 core 分析入口 + worker 联动 + Goal 页展示 + 测试 6~10 例)。

### REWORK-2:最小 CLI 入口(P0;US-04/V03)

- **为什么 P0**:PRD Must 明列"最小 CLI/API/Web";CLI 完全缺失(package.json 无 bin、无 src/cli)。
- **范围(有界)**:`src/cli.ts` + package.json bin 映射;命令最小集:`relay goal create/list/show`、`relay decision list/resolve/defer`、`relay task resume`、`relay worker tick`、`relay pause`(置 PAUSED 入口;转移表已支持)、`relay doctor`。**三入口同调 Core 权威**(复用 core 函数;HTTP API 不经 CLI 代理,直连 core)。
- **验收标准**:无 ChatGPT/无浏览器环境完整走通"创建→查看→审批→恢复"案例(V03);写路径 operatorAllowed+expectedStateVersion 同 API 口径;测试 ≥8 例;能力登记表更新。
- **依赖**:无;可与 REWORK-1 并行。
- **规模预估**:单文件 + 测试,不新增运行时依赖。

### 部署包(既有登记结转;含 24h/72h 长稳)

- relay-worker 独立进程入口(external 编排)、周期 tick(systemd/Compose)、备份参数(RPO/RTO/Retention)、Artifact 目录级备份、24h/72h 长稳观测(阈值已冻结,见 `long-stability-budget.md`)。
- **依赖**:网络恢复(镜像/克隆);用户授权生产部署边界。

## §3 登记遗留(不阻塞 MVP 判定,按序消化)

1. R-2:XFF 限速键盲信(非回环面加固时与可信代理同做);
2. R-5:Origin:null 放行(三层兜底,维持登记);
3. T01 模型级 prompt injection 语料化测试(现有防线=结构层:工具白名单+OS 隔离+Policy 服务端执行);
4. candidate stage 仓库自动回收(ops 清单);
5. base 一致性纵深(execute 阶段不复校 commit 绑定,F-12);
6. toolEvents 对真实 pi 1.5.0 事件流的 tool 记录空——工具审计权威面=workspace tool-audit.jsonl(extension 真写)+ toolEvents 兜底;**建议**:docker 模式下把 /pihome/tool-audit.jsonl 宿主侧副本路径随 run 落 detail(小改,并入 REWORK-1 顺手项)。

## §4 下一唯一工作包建议

**REWORK-2(最小 CLI)先行**(零依赖、最小、直接闭合 US-04/V03 的 MVP Must 面)→ REWORK-1(Discovery)→ 网络恢复后 github-real 闭环 → 部署包+长稳。
