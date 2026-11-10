# Relay 当前执行契约

- 状态:**P0-02C ACTIVE**(最小 Web 控制台与真实用户旅程验证)。激活:2026-11-10。
- 写者:**本会话唯一 Writer**(Claude/ZCode 会话);无并发写者。
- 起点:`origin/main == HEAD == 78e4d5e`(冷启动核对:工作区 clean、单分支 main、单 worktree、CI run `42792296065` @ `78e4d5e` success)。
- 本包交付:**最小 API Server + Web 控制台**,以现有 PostgreSQL / Goal Loop / Decision / Gate / Delivery 为**唯一业务事实源**;前后端只调 `src/core/*`,**不得复制第二套状态机**。

## 一、建设目标(四个页面 + 一个登录页)

| 页面 | 路由 | 必须显示(来自真实 DB 事实) |
| --- | --- | --- |
| Dashboard | `/` | Goal 状态、运行健康(DB/Worker/Provider)、预算消耗、阻塞项、异常、最新进展;空状态如实(不显示虚构"努力中") |
| Goal | `/goal.html?id=<goalId>` | 一句自然语言创建目标;系统理解、**可验证建议**、任务进度、执行证据 |
| Decision Inbox | `/decisions.html` | D0–D4 决策展示与授权操作(批准/拒绝/推迟);**D3 无任何"超时自动批准"入口** |
| ChangeSet / Evidence | `/changeset.html?id=<csId>` | Diff 摘要、**三 SHA**(candidate/tree/commit)、独立 Review、真实测试、Gate 结果、交付状态 |
| 登录 | `/login.html` | 口令登录(认证是必要安全面,非业务页面) |

- **能力登记表**:`GET /api/capabilities` 显式登记每项能力的 `IMPLEMENTED | NOT_IMPLEMENTED | STUB`。
- **不伪造 AI 分析**:Goal 页"系统理解/可验证建议"必须标注**来源 = 确定性规则推导(非模型)**;模型驱动的发现/推荐能力在登记表与 UI 上标记 `NOT_IMPLEMENTED`,**禁止**出现编造的模型结论。

## 二、安全门禁(G-1..G-8)

- **G-1 监听面**:默认仅 `127.0.0.1`;非回环地址需显式 `RELAY_WEB_ALLOW_NON_LOOPBACK=1` 否则**启动即拒**并落审计;启动横幅常驻显示绑定地址(不开放公网)。
- **G-2 身份认证**:单操作者模型。口令来自 `RELAY_WEB_PASSWORD` 或 0600 文件 `~/.relay/credentials/web-password`;口令以 scrypt 派生摘要比对(`timingSafeEqual`);会话 ID 32B 随机、服务端存储、有效期有限;Cookie `HttpOnly` + `SameSite=Strict` + `Path=/`;登录失败限速 + 锁定窗口(防口令爆破);登录/登出/失败均落审计。
- **G-3 CSRF**:会话内 CSRF token(32B 随机);**所有写方法必须带 `x-relay-csrf` 头**且与会话值 `timingSafeEqual` 相等;并校验 `Origin`/`Sec-Fetch-Site`(同源);缺失或失配 ⇒ 403 且**状态零变更**。
- **G-4 写操作鉴权**:actor 取自会话角色,必须通过 core 的 `operatorAllowed`;写操作必须携带 `expectedStateVersion`,由 core 的状态版本校验裁决,失配 ⇒ 409 且状态零变更。审计 authority = `OPERATOR`。
- **G-5 敏感信息脱敏**:API 响应统一递归脱敏(`ghp_/gho_/ghs_/ghu_/ghr_/github_pat_` 形态、`Bearer <tok>`、`x-access-token:<tok>`、`user:secret@`、`-----BEGIN * PRIVATE KEY-----`、凭据文件内容);**日志与错误文本同样脱敏**;服务端错误不回显堆栈给客户端。
- **G-6 D3 永不自动批准**:服务端**不存在**任何 D3 超时自动批准路径(源码自证 + 单测);超时只由 core 标 `EXPIRED_STILL_BLOCKED`,任务停留 `NEEDS_DECISION`;Inbox 对 D3 不提供"自动/批量批准"入口,推迟仅改截止时间、**不改状态**。
- **G-7 只读事实源**:前端不持有业务状态,每次渲染从 `/api` 取;网络中断时显示"连接中断/无法核实"而**不是**陈旧数据伪装成实时;刷新与断线重连后渲染值必须等于 PostgreSQL 实际值。
- **G-8 凭据与预算不扩大**:本包**不新增任何凭据面**、不扩大 GitHub 权限、不引入新模型预算;GitHub 真实写入在有效 PAT 缺失期间保持 `NOT_VERIFIED`。

## 三、交付条款(D-1..D-12)

- **D-1 零新运行时依赖**:API Server 只用 Node 内建 `node:http`(不引入 Web 框架);`playwright` 仅作 **devDependency** 用于真实浏览器验收。
- **D-2 零构建前端**:原生 HTML/CSS/JS,静态资源由同一 server 提供;不引入 React/Vite/打包链。
- **D-3 写路径只经 core**:创建 Goal ⇒ `planGoal`;决策批准/拒绝 ⇒ `ops.resolveDecision`;恢复 ⇒ `ops.resumeTask`;Goal 状态 ⇒ `goals.setGoalState`;推进 ⇒ `goal-loop.goalLoopTick`。**任何状态转移不得由 HTTP 层直接写 SQL**。
- **D-4 读模型为只读投影**:`src/server/queries.ts` 只含 SELECT(聚合视图),不产生任何状态、不写库。
- **D-5 能力登记表**:`/api/capabilities` 与 UI 同步标记未实现能力。
- **D-6 页面最小集**:仅上述四页 + 登录页;不建拖拽流程图、多 Agent 编排视图、移动端深度适配。
- **D-7 Worker 驱动可注入**:server 接受注入的 worker 驱动;生产用真实 runtime(`src/runtime/*`),测试用确定性桩;**桩模式在 UI 与 API 显式标注**(`workerMode`),不得冒充真实模型执行。
- **D-8 证据落盘**:`p0-02c/` 下留存 `e2e-journey.log`(逐步点击/HTTP 响应/DB 断言)、`screenshots/`(真实浏览器截图)、`http-responses.log`、`browser-errors.log`、`db-state.log`、`REVIEW.md`、`REPORT.md`;证据文件内嵌产出时 HEAD SHA。
- **D-9 独立复核**:独立上下文 Reviewer 复核(全新会话、只看 diff+证据),结论落 `p0-02c/REVIEW.md`;写者不代写复验结论。
- **D-10 CI**:新增独立 `e2e` job(Playwright Chromium + PG16 service),与既有 `test` job 并行;两者均须 success 才推送。
- **D-11 P0-02B 文档一致性**:修正 P0-02B 文档中"最新测试数字"不一致(REPORT §1/§8.4/§8.5 口径、CURRENT、CONTINUATION),并把"首次克隆瞬时未捕获测试异常"作为**未消除风险**记录(不得静默抹平)。
- **D-12 收尾**:更新 `CURRENT.md`、`docs/CONTINUATION.md`,交付 `p0-02c/REPORT.md`(含真实点击/HTTP/DB/截图/浏览器错误/commit SHA 与未验证项)。

## 四、验收反例(逐条须有断言证据)

1. **未认证**访问 `/api/*` ⇒ 401;访问业务页 ⇒ 跳转登录;**响应体不含任何业务数据**。
2. 已认证但 **CSRF 头缺失/错误** ⇒ 403,且数据库状态零变更。
3. **非 operator** 会话调用写接口 ⇒ 403,状态零变更。
4. **`expectedStateVersion` 失配** ⇒ 409,状态零变更。
5. **D3 超时** ⇒ 绝不自动批准(决策仍 `OPEN`/`EXPIRED_STILL_BLOCKED`,任务仍 `NEEDS_DECISION`);源码自证无自动批准路径。
6. 响应含**疑似令牌** ⇒ 脱敏后明文不出现。
7. **刷新 + 断线重连**后页面渲染 ⇒ 逐字段等于 PostgreSQL 实际值(重连前须显示"连接中断",不得显示陈旧值冒充实时)。
8. **Worker 崩溃/任务失败** ⇒ UI 显示失败原因、证据与恢复状态,**不得显示成功**。
9. **GitHub 真实写入**(无有效 PAT)⇒ 保持 `NOT_VERIFIED`;UI/报告不得声称完整交付验收通过。
10. **未实现能力** ⇒ 接口与 UI 显式 `NOT_IMPLEMENTED`;页面无伪造 AI 分析文本。

## 五、真实验收(Playwright,真实浏览器)

- J1 模糊需求创建 → 查看系统理解与可验证建议。
- J2 D3 长期未审批 → 其他安全任务正常推进(被 D3 卡住的任务不得越权推进)。
- J3 Worker 崩溃/任务失败 → UI 显示原因、证据、恢复状态。
- J4 查看候选变更 → 独立验证 → Gate → 正确显示交付状态(交付目标为**本地 bare 远端**,不得冒充 GitHub 真实写入)。
- J5 刷新页面、断线重连后,页面状态仍与 PostgreSQL 一致。

记录:实际点击、HTTP 响应、数据库状态、截图、浏览器错误、对应 Commit SHA。

## 六、模型预算与凭据边界

- **真实模型调用 = 0 次**(本包不扩大模型预算)。所有模型相关路径在验收中由确定性桩(`test/helpers/stub-pi.mjs`)承担,并在证据中标注为桩执行;真实模型链已于 P0-01B/02A/02B 验证。
- **GitHub 权限 = 不变**;`~/.relay/credentials/github-sandbox-pat` 仍为无效凭据 ⇒ GitHub 真实写入/漂移实验继续诚实 skip,**不得改用本机 gh 宽权限令牌**。
- 不生产部署、不启动 RSI、不触碰其他业务仓库、不创建其他分支、不强推。

## 七、继承的遗留检查单(P0-02B 结转)

1. **真实远端写入 + 漂移实验**(仍为 `NOT_VERIFIED`):宿主凭据文件存在(0600)但内容非有效 GitHub 令牌 ⇒ 两例诚实 skip;有效细粒度 PAT(仅 `pwl1987/relay-delivery-sandbox` 的 Contents RW)就位后运行 `npx vitest run test/integration/github-real.test.ts` 即闭环(合同内既定,无需新授权)。
2. base 一致性纵深(`executeDelivery` 不复校 commit 绑定)。
3. 候选 base 仅存 reflog 时的阻断边界。
4. 经典 `ghp_*` 令牌仅限开发者 infra,严禁进入任何 Relay Operator 路径。
5. 候选 stage 仓库 DELIVERED 后无自动回收(量级小,ops 清理)。

## 八、本包退出条件

- 全部 D-1..D-12 落地;反例 1..10 逐条有断言;J1..J5 真实浏览器留证。
- 独立 Reviewer 复核通过并落盘。
- `typecheck` 0 错误;全量 vitest 绿;新增 `e2e` CI job 绿。
- 快进推送 main,`origin/main == HEAD`,worktree clean;更新 `CURRENT.md` 与 `docs/CONTINUATION.md`;交付 `p0-02c/REPORT.md`。
