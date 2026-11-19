# RELAY-MVP-READINESS-REBASELINE-17 · 独立 Reviewer 复核(三轮:REWORK → REWORK → PASS)

Reviewer:全新上下文独立 Reviewer(与实施方零共享记忆;三轮全程仅读主仓+临时目录实验,零 commit/零 push/零生产写入)。
复核对象:暂存区 6 文件(3 md + 3 evidence;补丁 348 行 → 511 行 → 512 行,各轮均与暂存区逐字节一致),基线 HEAD=`9db5c56476143f2e6f9ef01ef19570b0ddd2edeb`(父提交=`6a2f51f`,产品面=6a2f51f,治理链仅文档)。

## 终裁决:**PASS(0 Major / 0 Minor;Round3,2026-11-19)**

## Round1:REWORK(2 Major / 2 Minor)

### 逐项核验事实(全部独立实测)

1. **补丁面**:diff --cached 恰 6 文件全在包目录,零 src//web//scripts 产品代码;`6a2f51f..9db5c56` 仅 4 个文档文件;evidence 无口令/csrf/连接串(env 仅 12 个键名,取值零输出)。
2. **权威资料亲读**:ADR/0010(24h→PILOT-24H、必需项清单、R-3 PARTIAL 定格条款)、ADR/0011、`final-coverage-matrix.md`(补丁零触碰,原文未动)、PRD §5/§8、REPORT-final §12、CURRENT.md 顶部;R-1 闭环 2026-11-12、R-2 双败细节、R-3 定格均与原文一致;24h 未被改写为 PASS、F1/F2 未被升 VERIFIED,LEDGER 与 CURRENT.md 登记指针逐项一致。
3. **层 A 证据在库**:六个 E2E 套件、discovery/github-real/f3-injection/evidence-gate-rehearsal 测试、`p0-mvp/f1/discovery.json`、`r1-closure.md`、MAC 卡 2026-11-18 版、`16R/COORDINATOR-REVIEW-20261119.md`(PASS 0 Major)、J4 三 SHA 断言(web-journey.test.ts:612-645)全部在库;**三个 exact-head CI run 经 gh API 只读独立核验全 success 且 SHA 匹配**(44340057681@6a2f51f / 44293665824@b50ba29 / 44311004493@df3ff59)。
4. **冒烟独立复跑**:mktemp 克隆 HEAD=9db5c56(未打补丁)软链 node_modules,RELAY_E2E=1 六套件:**40 passed/40,EXIT=0,28.89s**,套件清单与 git stderr 噪声位置与 evidence/mainpath-smoke.log 逐点一致;合同 §四-3 九项逐项落到具体测试(J1+webux12=需求创建、three-dirs+J7=冻结绑定、J3+three-dirs=执行链、J4=Gate·changeset、J4+three-dirs T4=本地 bare 交付、result-truth V1/V2/V5+16r T2=结果 truth·provenance、V3=用户接受、16r T1=新版本不污染旧验收、V4=拒绝不改内部 Gate);stub 边界标注诚实。
5. **生产只读刷新**:亲读 `deploy/preflight.ts`(605 行,psql 全 SELECT/information_schema,docker 仅 inspect/ps/images,systemctl 仅 show=零写入)后亲跑:裁决 NO-GO,18 探针与 evidence JSON **程序化逐字段比对 material diffs=0**(db_migrations FAIL 缺 0008/0009、evidence_checks UNKNOWN、process_vs_head UNKNOWN、egress UNKNOWN、git_head FAIL,PASS 面 13 项同)。
6. **裁决唯一性**:REPORT §四 恰一个裁决标题;其余三选项显式否决有据;B/C/D 用户决策归属如实。
7. **零代码**:quality:quick 于克隆 HEAD 实跑 PASS(lint/format/typecheck+unit 22 文件 191/191,与 CI 计数一致)。
8. **边界**:porcelain 开工/收工逐字节一致(82 行);PID 3242781/3242782 双活(lstart=2026-11-13 02:00:08+08);p01a_* 恰 25;临时目录自清;零生产写入。

### Round1 Findings

- **Major-1**:MATRIX C2/LEDGER ②/REPORT §四.3 与用户动作段断言"F1-R/F2-R 复验从未执行——待用户授权四参数",与在库证据矛盾:ADR/0011 原文即写"复验(2026-11-13 授权)";`r2-remediation/REPORT-r2-remediation.md` §3/§4 记载 F2-R(01:25:57)/F1-R(01:50:38)已执行、均 FAILED、归因上游出口代理 502 硬故障(网关账本 12 请求全 502 零 token)、尝试已消耗禁止自动重跑;§5=能力对照不可判定;§6+`R2-ROUND2-NOTE.md`=第二轮 F1-R2/F2-R2 已获 READINESS-01 §三D 授权武装(32768 冻结)因上游挂起 ≥42 分钟未发起未消耗、完整保留;生产 32768 采值切换待新授权;四参数 2026-11-12 07:50+0800 已确认。真实历史被抹为"从未执行"且下一步动作被误导。
- **Major-2**:REPORT §六 预断"独立 Reviewer:PASS"并引用全仓不存在的 REVIEW-17.md。
- **Minor-1**:"quality:quick 复跑留证"无证据文件(实质经我独立复跑证实)。
- **Minor-2**:evidence/prod-preflight-readonly.log 为 0 字节空文件却被引为证据。

## 执行方消化(Round1 → Round2 提审)

- Major-1 主单元格重写:MATRIX C2 / LEDGER ② / REPORT §四.3 与用户动作段改为真实链条(对照 ADR-0011 授权原文、r2-remediation §3/§4/§5、R2-ROUND2-NOTE 三结论分开口径逐环核实)。
- Major-2:预断句删除,改为如实登记 Round1 REWORK 明细。
- Minor-1:`evidence/quality-quick.log` 入库(158 行,PASS 含 unit 191/191)。
- Minor-2:空 .log 自索引与工作树移除,引用收敛至 JSON。

## Round2:REWORK(1 Major 残留 / 无新增 Minor / 无回归)

- 补丁==暂存(511 行);**三个证据 blob 与 Round1 逐字节相同**(mainpath-smoke.log=9942037、preflight JSON=3a9c7e6)→ 全部独立实验结论沿用,零回归。
- **Major-2 消化合格**:预断句删除,改为如实登记 Round1 REWORK 明细(经与 Reviewer 实际动作逐条核对属实),REVIEW-17.md 留待 Reviewer 落盘不预断。
- **Minor-1 消化合格**:quality-quick.log 验真(输出结构逐段同形、unit 22 文件 191/191 与独立实跑及 CI 一致、时间戳自洽、零凭据)。
- **Minor-2 消化合格**:空 .log 移除,引用收敛至 JSON。
- **Major-1 主单元格消化合格**:C2/消账②/§四.3/用户动作重写为真实链条,逐环与在库证据吻合(含三结论分开口径逐字一致)。
- **Finding-1(残留,Major)**:grep 证伪"全仓零残留"——5 处汇总单元格残留「复验待用户授权/授权四参数待用户/复验待授权」旧口径(MATRIX:37 层 C 标题裁决行、:67、:68;LEDGER:18、:51),与同文档已改正单元格及在库证据自相矛盾;定性依据=审计矩阵按单元格消费,误导读者重复请求已存在并已消耗的授权;本仓库复核先例对报告事实性失实一贯按 Major 处理(13 包假 0 登记/11 包证据登记失实)。最小收口路径=5 行机械对齐后 Round3(grep+读 5 行,无需重跑实验)。

## 执行方消化(Round2 → Round3 提审)

5 行逐一机械对齐为真实链条(层 C 标题行/总裁决理由 3、4/LEDGER §二 R-2 行并新增"详见 §一②"内部互指/§五 R-2 行);REPORT §六 如实补登 Round2 结果与本轮消化;REVIEW-17.md 仍不预断。

## Round3 终裁(本轮,按 Round2 裁定最小范围):PASS

1. **补丁面**:patch(512 行)与暂存区逐字节一致;暂存恰 6 文件;**三证据 blob 不变**(9942037/3a9c7e6/ab25c50),零产品代码。
2. **残留 grep(暂存内容)**:`待用户授权|待授权|四参数|从未执行` 在 MATRIX.md 与 REWORK-LEDGER.md **零命中**;REPORT-17.md 唯二命中=§六 对 Round1/Round2 缺陷的如实登记引文(描述"曾经错在哪里",Round2 已裁定正当)。
3. **5 处修复行逐字通读**(暂存 blob):MATRIX:37 层 C 标题行、:67 总裁决理由 3、:68 理由 4;LEDGER:18(并新增"详见 §一②"内部互指,自洽)、:51——五处均已对齐真实链条:"复验已获授权并正式执行、双败于上游 502 不可判定;第二轮已武装保留,发起待上游窗口恢复+额度/新授权确认(用户决策);生产 32768 采值切换待新授权",与 C2/②/§四.3 及在库证据(ADR-0011/r2-remediation §3-§6/R2-ROUND2-NOTE)完全一致。
4. **改动面收口**:r2→r3 逐行 diff,MATRIX 恰 37/67/68 三行、LEDGER 恰 18/51 两行、REPORT 恰 §六(62 行改写+63 行新增 Round2 登记——与 Round2 终裁原文核对属实,"由 Reviewer 复审后落盘,不预断"维持)——无任何越范围改动。
5. **边界终核**:porcelain 开工/收工逐字节一致(82 行,暂存恰 6);PID 3242781/3242782 双活未变;p01a_* 恰 25;Reviewer 临时目录自清(余 0);零生产写入/零重启/零 commit/零 push。

## 四、终裁与 standing 结论

- **三轮 Findings 全部关闭**:Round1 2 Major/2 Minor → Round2 消化 3 项+暴露 1 残留 → Round3 残留逐行对齐零命中。三文档 R-2 授权/执行状态口径已全仓一致,消账表对历史结论的引用与原文一致(消账无变绿口径篡改:24h PARTIAL 定格维持、F1/F2 维持 NOT_VERIFIED/不可判定、US-08 已解除 2026-11-12)。
- **四层准入终评(独立证实)**:层 A=VERIFIED(40/40 独立冒烟+三 CI run+16R 协调方 PASS 0 Major;stub 显式);层 B=BLOCKED(用户本人专属,LAN_READY+MAC 卡 2026-11-18 就绪);层 C=BLOCKED(复验已授权已执行、上游 502 双败不可判定,第二轮保留待窗口+额度/新授权,非工程缺口);层 D=NO-GO 维持(18 探针独立复跑逐项一致)。
- **唯一下一阶段裁决评定:ENGINEERING_READY → USER_ACCEPTANCE 成立**——与 ADR-0010 阶段序(阶段 D 用户验收→阶段 E Pilot→最终裁决)一致,R-2 与 D3 如实定位为用户决策而非工程项,零"为推进而隐藏缺口";零工程 Major,合同 §五 4 号选项不触发。
- **边界记录**:三轮全程主仓只读,生产仅只读 preflight 采样与 SELECT 核数,PID/p01a_*/脏文件保护面零触碰;本 REVIEW 为独立结论,不构成 UX 验收、R-2 发起授权或生产 D3 授权。

**Review-verdict:PASS(0 Major/0 Minor)。**
