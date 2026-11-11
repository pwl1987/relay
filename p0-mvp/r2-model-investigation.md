# R-2 模型路由与编码能力复核·调查报告(第三包调查阶段;零模型消耗)

- 依据:总执行包第三包 §1~6(2026-11-12)——"本包先做不消耗模型预算的调查";**未获授权前零真实模型请求**。
- 调查时间:2026-11-12 06:55~07:10+0800;证据面:Magpie 路由日志(`~/.config/magpie/routing/2026-11-11.jsonl.gz`+`2026-11-12.jsonl`)、`/v1/models` 实测、`providers.json`/`quotas.json` 结构盘点(**全程未读取/未展示任何 API Key 明文**)、`r2-failure-analysis.md`、`test/helpers/provider.ts`。
- 消耗证明:本调查全部为只读(文件读取/DB 查询/`GET /v1/models`);**未发起任何 chat/completion 推理调用,零预算消耗**(budget_ledger 全库扫描无 11-12 变动;F1/F2 时段 schema 已随测试清理,历史消耗以 `r2-failure-analysis.md` §2 与 JSON 快照为准)。

## 1. 决定性新事实:`group/gm` 的真实上游已实证(不再"不透明")

Magpie 路由日志逐请求记录路由组→上游尝试(try 级)。`group/gm`(GMD)组成员:

```
members = [zcode/GLM-5.3-Flash, minimax-code/MiniMax-M3.1-Flash, edgecloudapp/deepseek-v4.1-flash-1017]
```

**try 级成败分布(实证)**:

| 日期 | 上游 try | 次数 | 说明 |
| --- | --- | --- | --- |
| 11-11(F1/F2 当天) | `zcode/GLM-5.3-Flash` 200 | **486** | 实际承接推理的主力 |
| 11-11 | `zcode/GLM-5.3-Flash` 499 | 33 | 499=客户端中止(=Relay wall 预算止损) |
| 11-11 | `zcode/GLM-5.3-Flash` 502 | 6 | 上游网关偶发 |
| 11-11 | `minimax-code/MiniMax-M3.1-Flash` 502 | 40 | **全部失败**:`MiniMax Code token refresh: proxyconnect tcp: dial tcp 127.0.0.1:8118: i/o timeout`(本机代理栈故障,**非模型能力问题**) |
| 11-11 | `edgecloudapp/deepseek-v4.1-flash-1017` 200/499/502 | 4/4/6 | 仅零星成功 |
| 11-12(今日) | `zcode/GLM-5.3-Flash` 200/499 | 39/2 | 其余成员全天未成功承接 |

顶层(11-11 共 528 请求):490×200 + 37×499 + 1×502。F1/F2 运行窗口(15:24~16:28+08)72 行路由记录全部落在上述分布内。

**归因精确化(修正 `r2-failure-analysis.md` §1 的"上游不透明"边界)**:F1/F2 失败时,约 95% 的成功 try 由 **Flash 级 `zcode/GLM-5.3-Flash`** 承接;两个回退成员当日因**本机代理故障**(`127.0.0.1:8118` 超时)基本不可用。因此失败归因可从"路由组行为"精确为:**"Flash 级单模型 × 回合预算 12"的组合**——既不能归因"Magpie",也不能推断"任何本地/经网关模型都不足";Discovery 高质量产出(VERIFIED)恰出自同一 Flash 模型,证明其短链推理可用、有界预算内多步代码编辑收敛困难。

## 2. 六分法归因(更新版)

| 维度 | 裁决 | 证据 |
| --- | --- | --- |
| 模型能力 | **疑似主因但可检验**:Flash 级(轻量档)在 12 回合内未收敛 4 点修复;满血同家族未测试 | 路由日志成员表+`r2-failure-analysis.md` §2 |
| 模型超时 | 次因:1 次 wall 超时(499 客户端中止;`run-abe16b7d` TIMEOUT) | `r2-failure-analysis.md` §5 |
| 工具限制 | **排除**:tool_execution 正常、无 denied | 同上 §2 排除项 |
| 上下文不足 | **排除**:1M 上下文,任务远小于限 | `/v1/models` group/gm context_length=1000000 |
| 提示词问题 | 首轮主因,**已修**(goalTextFor 采纳装配);修后仍 BUDGET_EXHAUSTED | 同上 §2 |
| 回合预算不足 | 与能力耦合:12 回合是止损不是缺陷;"能力不足 vs 需更多回合"须对照实验区分 | 同上 §2.4 |

## 3. 可用编码模型盘点(全部经同一 Magpie 网关 `127.0.0.1:3425`;**relay 侧零新增凭据**)

`/v1/models` 实测:2 个路由组 + 80+ 具体模型(OpenRouter free 系/nvidia NIM/siliconflow/edgecloudapp/codex/minimax-code/deepseek/zcode 等)。**关键机制事实**(源码与测试证实):

- Relay 通过 `RELAY_PI_MODEL` 环境变量单变量切换模型(`test/helpers/provider.ts:15`,缺省 `group/gm`),helper 内建 `GET /models` 存在性校验;
- 凭据链不变:Run 容器内 models.json 仅占位 key,宿主 egress 代理改写真实 Authorization(`src/runtime/egress.ts`);**Magpie 持有全部上游凭据且 zcode 通道实证健康 ⇒ 走 Magpie 的替代模型无需任何新凭据、无 Key 明文暴露**;
- Magpie 是网关层:对照实验必须记录**具体模型 id**(非组名),路由日志可双向对账。

**候选表(编码向;工具+推理齐备;健康=近两日路由日志实证)**:

| 候选 | 提供方 | 上下文 | 健康实证 | 计价(输入/输出,每 token) | 备注 |
| --- | --- | --- | --- | --- | --- |
| **首选:`zcode/GLM-5.3`** | zcode(与 Flash 同提供方) | 1M | 提供方通道 11-11~12 持续 200 | $0.00000119/0.00000418 | **同家族满血版:与失败组单变量对照(仅"Flash→满血"一变),科学价值最高** |
| 备选:`siliconflow/moonshotai/Kimi-K2.7-Code` | siliconflow | 262k | 提供方在册;近两日无调用记录(未验证) | $0.00000086/0.0000038 | 编码专精模型 |
| 备选:`minimax-code/MiniMax-M3` | minimax-code | 1M | **⚠ 其 token refresh 走 127.0.0.1:8118 已故障**(11-11 40×502) | $0.0000003/0.0000012 | 需先修复本机代理栈才可调用 |
| 备选:`edgecloudapp/claude-sonnet-5-5` | edgecloudapp | 1M | 零星 200(11-11 deepseek-v4.1 4 次);未充分验证 | $0.000002/0.00001 | 强编码档,计价最高 |
| 备选:`deepseek/deepseek-flash` | DeepSeek 直连 | 1M | 未验证;**余额 ¥21.52(11-02 读取)** | $0.00000015/0.0000006 | 余额有限 |

## 4. 对照实验操作设计(待四项授权;本报告零执行)

- 切换:`RELAY_PI_MODEL=zcode/GLM-5.3`(或其他用户指定模型)+ `RELAY_F1_E2E=1` / `RELAY_F2_E2E=1`;**同一 F1 项目(`test/fixtures/f1-tasklist`)/F2 项目(`test/fixtures/f2-api`)/同一机判(check.mjs C1~C4、api-check.mjs A1~A4,基线负对照不变)/可比预算**。
- 记录:runs.model_ref、Magpie 路由日志对账、每轮 turns/耗时/token、原始日志落 `p0-mvp/r2-contrast/`(独立证据目录,不向已跟踪日志追加——呼应第四包②)。
- 判定:同 `r2-failure-analysis.md` §3(真实模型完成修改+机判通过+独立 Reviewer PASS+commit 绑定+交付成功 ⇒ VERIFIED;Stub 不替代)。

## 5. 待用户授权的四项参数(缺省建议,须确认)

| # | 参数 | 建议缺省 | 说明 |
| --- | --- | --- | --- |
| 1 | 替代模型 | `zcode/GLM-5.3`(同家族满血,单变量对照) | 或用户指定候选表任一 |
| 2 | 预算 | coder reserve 12 / reviewer 4 / goal 账本 30(与历史声明一致) | 对照双方账本一致才可比 |
| 3 | 超时 | wall 600s | 同 §4 设计 |
| 4 | 凭据 | **无需新增/变更**:Magpie 已持上游凭据;relay 占位 key 机制不变 | 不读取/不打印/不入仓任何 Key |

**授权到位后即可执行(链路已就绪);未授权则本报告即第三包调查阶段的最终交付物,R-2 维持 PARTIAL。**
