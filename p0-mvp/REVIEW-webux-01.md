# WEB-UX-01 独立复核记录

- 复核对象:实施链 62b4d54(§4.3 拆分)→ 9cf538c(§4.5 API 绑定)→ 2c934a3(§4.4~4.12 UI)→ cadfda6(evidence 再生,与实现分离);复核时 HEAD=cadfda6。
- 合同:CURRENT.md【WEB-UX-01】行(49f7dd0 登记)+ docs/PI_WEB_REFERENCE.md(pi-web 参考台账,MIT 已核验)。
- 复核人:独立 Reviewer(全新上下文 subagent;只读 + 亲测)。
- 复核时间:2026-11-12 12:0x~12:1x+0800。

## 裁决:**PASS-WITH-FINDINGS(零 Major;2 代码 Minor + 1 环境观察项,已全部消化)**

### 六项核验(6/6 PASS,Reviewer 亲测)

1. **合同范围覆盖 PASS**:4.3~4.12 十项逐项实证(拆分桶/项目绑定 API+UI/AppShell 侧栏+抽屉/七阶段 Timeline/采用推荐按钮/只读 Diff/Models 观察态/PWA manifest+自有图标/轮询 8s-30s/手机断言)。
2. **§4.5 安全核心 PASS**:body.path 零读取;projectId 仅匹配注册表(未命中 400);allowed_scope=注册表路径;audit 落 projectId/resolvedPath/scopeSource=registry;未绑定流向后兼容。
3. **安全清单 PASS**:web/ 零 Key 零凭据;写守卫(SameOrigin+CSRF+operator)未削弱;CSP `style-src 'self'` 保持、零内联样式、零 innerHTML(app.js 主动 throw 禁用);ensureLoopbackBind 原样;diff 端点 execFileSync 数组参数无注入面。
4. **禁止项 PASS**:pi-web 移植台账=空(全仓无移植痕迹);MODEL-POLICY-01 零实施(UNREGISTERED 观察态);`git diff 62b4d54^..HEAD -- src/core/` 为空(零 schema 零 Core);soak 零触碰+skip-worktree 两文件完好;新增测试零模型门泄漏。
5. **亲测 PASS**:typecheck 0 错;console-views 7/7 + console-api 8/8 = 15/15;**Playwright 真浏览器 e2e 7/7(J1-J7)亲测复现**。
6. **行为不变性 PASS**:抽查四个视图函数与拆分前逐字节一致(仅 export 关键字差异);repoRootFromModule 三级深度正确。

### 发现与消化(全部在修复提交中闭环)

- **Minor-1**(diff 端点双向前缀匹配可能误配前缀包含路径)→ 已改为**最长前缀优先**(`sort((a,b)=>b.path.length-a.path.length)[0]`);
- **Minor-2**(audit projectName 取浏览器值)→ 已改为**注册表权威值**(`projectName: boundProject.name`);
- **Minor-3**(观察项:`.zcode/` 未跟踪目录超出基线描述)→ 已加入 `.gitignore`;实施提交从未包含它;
- 修复后复验:typecheck 绿 + console 15/15 绿(e2e 7/7 在修复前已过;两处修复均为只读路径选择与审计信息性字段,不影响旅程断言)。

### Reviewer 结论(节选)

> 六项核验全 PASS,零 Major;2 个代码级 Minor(均只读/信息性影响,附可执行修复建议)+ 1 个环境观察项。实施者自报的 typecheck/15 定向/e2e 7×7 全部经本人亲测复现;P0 安全核心(浏览器零任意路径、注册表唯一权威、scope 绑定、audit 落实)与全部禁止项(零移植/零 MODEL-POLICY-01/零 schema/零 soak/零真模型)均以直接证据确认。
