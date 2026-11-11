# P0-ACCEPT:安全故障注入报告

- 验证 HEAD:`02c094f`(提交链 `4bd4168 → c407cb0 → c9c53bd → 511c2b6 → 042b4c5 → 02c094f`)
- 方法:真实注入(真实进程/真实容器/真实 PG/真实信号),非 Mock 断言;每项注明注入方式、观察、裁决

## §1 注入矩阵

| # | 注入 | 方式 | 观察 | 裁决 |
| --- | --- | --- | --- | --- |
| 1 | **live worker 无 OS 隔离** | `createLiveWorkerDriver({sandbox:"host-fallback"})`(无 stub 注入)→ tick | `IDLE_PROVIDER_DOWN`,`lastTick=sandbox_not_isolated`,runs 零行(不领取、不降级执行) | ✅ FAIL-CLOSED(本包收口,c407cb0;收口前默认值即静默 host-fallback——缺口实证并修复) |
| 2 | **docker 不可用** | live + 默认(docker)+ egress 未建 → tick | `IDLE_PROVIDER_DOWN`,`lastTick=docker_unavailable/egress_not_ready`(按 dockerAvailable 分支),不领取 | ✅ FAIL-CLOSED(worker-safety.test.ts 4 例) |
| 3 | **白名单外命令** | 真实容器+真实模型 relay_exec /etc/passwd(P0-01B pi-e2e)+ 命令 scope 对抗 8 样本(command-scope) | denied=true / outside_allowed_root / exec_not_authorized;`;&|` 反引号 `$(` 全禁 | ✅ 拒绝(传递链+执行层双证) |
| 4 | **白名单内命令** | A-4 联验:真实模型 relay_exec `echo sum=87 > result.txt`(task.allowed_commands=["echo"]) | SUCCEEDED;确定性检查 passed;DELIVERED;远端内容核验一致 | ✅ 允许面真实放行 |
| 5 | **Worker SIGKILL** | `kill -9` 真实 server 进程(E5)+ P0-01A V04/P0-01B crash-recovery(真实子进程) | 进程死;重启后 DB 事实源完整;旧会话失效 401;库级:fencing 回收→重领→旧 token 拒 | ✅ 恢复语义正确 |
| 6 | **PG 断连** | `docker stop relay-p000-pg`(E6) | **首跑实锤:server 进程崩**(BoundPool error 无监听→unhandled)→ 收口(pool.on(error))后:health 非 200 降级可见、tick 失败不推进、PG 恢复后自愈、零状态推进 | ✅ 收口后 PASS(02c094f;收口前为缺陷,如实登记) |
| 7 | **Provider 离线** | 重启 server 以不可达 BASE_URL(E4)+ providerProbe 早退 | tick ⇒ IDLE_PROVIDER_DOWN;零模型调用;零副作用 | ✅ 不烧 token 不领取 |
| 8 | **交付装配失败** | 代码核查发现兜底缺失后以**处置测试直接注入**(propose 抛错;REVIEW R-1 更正:c9c53bd 提交信息声称"由 A-4 首跑实锤触发"不可证——A-4 首跑实际走 TIMEOUT/DELIVERED 路径) | 收口(goal-loop propose try/catch)后:落 D3 决策行 + DELIVERY_PROPOSE_FAILED 审计,tick 不冒泡、不回滚 ACCEPTED——`test/integration/delivery-propose-fallback.test.ts` 6 项断言全过 | ✅ 与 P0-02B 交付层失败语义一致(c9c53bd + 处置提交) |
| 9 | **超预算/回合硬顶** | budget_turns_cap(P0-01C)+ reserve/limit 门 | Run 机械不可能突破预留;BUDGET_EXHAUSTED ⇒ BLOCKED | ✅(既有+A-4 账本 6/8 佐证) |
| 10 | **重复失败循环** | 相同失败签名连续 ≥3 熔断 + 退避 + attempt 预算(V11) | 有界停止,token/attempt 受限 | ✅ goal-loop.test.ts |
| 11 | **远端漂移** | intent-drift + 外部写者快进(V10) | CONFLICT/REJECT_NO_FORCE_PUSH;历史未丢;无强推 | ✅ |
| 12 | **丢响应重试** | EXECUTING 窗口 SIGKILL(V05) | 先核对;不双重不可逆写;幂等 already_completed | ✅ |
| 13 | **越权写 API 面** | web-api 反例 1/2/3/4(未认证/CSRF/非 operator/版本失配) | 401/403/403/409 且 DB 零变更 | ✅ P0-02C 面复核未动 |
| 14 | **监听面** | 非回环绑定无放行(G-1/R-1) | BindRejectedError + audit_events WEB_BIND_REJECTED + 退出 | ✅ web-app 4 例 |
| 15 | **凭据隔离** | 密钥隔离代理(A-4/gate-e2e):真实 key 仅宿主 0600 → 代理;容器见占位 | keyIsolation=true;scrubExecEnv 剥离凭据 env;argv 零 key | ✅ |

## §2 备份/恢复注入(缺口 F)

见 `backup-restore-acceptance.md`:真实 pg_dump → 隔离一次性 PG 容器恢复 → 13 表全实体摘要一致 → 外部 Git 不变。

## §3 长稳观测

见 `long-stability-budget.md`:300s 零模型 tick 循环;RSS 峰值 333MB<400MB;tick 60/60 IDLE。24h/72h 未跑满(如实)。

## §4 结论

15 项注入全部真实执行;**2 个真实缺陷在验收中被抓出并最小收口**(live worker 静默降级 host-fallback;PG 断连进程崩溃),另有 1 个健壮性缺口(交付装配失败冒泡)顺带收口。未发现伪造证据面;全部 FAIL-CLOSED 语义就位。
