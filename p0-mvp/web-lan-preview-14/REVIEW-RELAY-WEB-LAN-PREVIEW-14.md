# REVIEW · RELAY-WEB-LAN-PREVIEW-14（独立 Reviewer 终裁）

- Reviewer：全新上下文冷启动独立 Reviewer（与执行方无关，未复用执行方任何工作区/进程状态）
- 复核日期：2026-11-18
- 被审对象：实施提交 **e72c6ce**（=live main HEAD=origin main，`git ls-remote` 实测一致）；合同=feacc99（CURRENT.md 顶部 RELAY-WEB-LAN-PREVIEW-14 🔵 ACTIVE，其 CI 44193131384 test+e2e 双 success 由合同文本登记，本审另核 14 实施 CI）
- 审计克隆：`/tmp/p14-review-90977-relay`（`https://github.com/pwl1987/relay.git` 克隆后 `git checkout --detach e72c6ce`；node_modules 软链至宿主 `/home/ubuntu/dev/relay/node_modules`）
- **终裁：PASS（0 Major / 1 Minor 非阻断）**

---

## 一、逐项判定总表

| # | 复核项 | 结果 | 依据（本文后续节附实跑证据） |
|---|---|---|---|
| 1 | 冷启动克隆与 detached 基 | PASS | 克隆 SHA=e72c6ce；origin main 实测=e72c6ce |
| 2 | diff 面与合同声称一致 | PASS | `git diff feacc99..e72c6ce --stat`：8 文件，仅 scripts/webux11-preview.mjs(+38/-7 净)、test/e2e/webux13-preview-lifecycle.test.ts、MAC-ACCEPTANCE-CARD.md、p0-mvp/web-lan-preview-14/evidence/ 5 件；**零 src/、零 web/、零 Core、零迁移、零新依赖** |
| 3 | 红态独立复现 | PASS | 父版本脚本还原后 TAG=review-red：**恰 1 failed(T3, ECONNREFUSED 10.30.5.80)\|3 passed(T1/T2/T4)**，与登记逐字一致 |
| 4 | 绿态亲测 | PASS | 新脚本 TAG=review：**4/4 全绿**（T1/T2 13 既有语义零改动通过） |
| 5 | 真实 --lan 冒烟（真实子进程+真实探针） | PASS | 经 10.30.5.80 非回环 IPv4：未授权 302→/login.html、/api/health 401、口令登录 200、带 Cookie /workspace 与 /api/health 双 200；SIGTERM exit 0、端口释放、tmp 69→69、p01a_ 25→25（`-d relayp000` 正确口径） |
| 6 | 缺省不变性（无 --lan 与父版本等价） | PASS | 逐字段 diff 论证（见 §六）；缺省分支仅新增 1 行输出面提示，绑定/listen/清理路径逐字节不变；T1/T2 绿佐证 |
| 7 | CI 独立核验（含计数） | PASS | run 44194276677@e72c6ce test+e2e 双 success；e2e **Tests 65 passed\|2 skipped (67)**=基线 63+2；webux13-preview-lifecycle **4 tests 真跑**（T1–T4 具名绿，T3 991ms/T4 863ms）；test job quality:full **484p\|85s (569)** 不变、quality:quick **182 passed (182)** 不变 |
| 8 | 证据卫生（5 件） | PASS | 全目录 grep：**零 16+ 位 hex、零 csrfToken、零 set-cookie 值、零口令原文（stdoutTail 内口令=***REDACTED***）、零 bodyHead/pwHead 响应体片段**；`hasCookie` 为布尔值非凭据 |
| 9 | 边界核验（前后各一次） | PASS | 生产 PID 3242781/3242782 全程常在；执行方工作区 `status --porcelain` 非未跟踪项=0；config/、soak-r3b/ 在场未触碰；零 iptables/egress/防火墙操作；零真实模型调用；零外部 GitHub 写入；历史 p01a_* 25 个与 /tmp 69 目录基线全程未清算 |
| 10 | MAC 卡逐条对照 | PASS | 见 §九 |

---

## 二、克隆基与命令实录

```bash
cd /tmp && GIT_SSH_COMMAND="ssh -p 443 -o ProxyCommand=none" \
  git clone https://github.com/pwl1987/relay.git /tmp/p14-review-90977-relay
git -C /tmp/p14-review-90977-relay checkout --detach e72c6ce
ln -s /home/ubuntu/dev/relay/node_modules /tmp/p14-review-90977-relay/node_modules
# git log -2: e72c6ce(实施) ← feacc99(合同)   rev-parse HEAD = e72c6ced54e3fea38a1dba22e8133ac858408706
```

基线实测（复核前后各一次，数值一致）：
- `docker exec relay-p000-pg psql -U postgres -d relayp000 -Atc "SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 'p01a_%';"` → **25**（13 Major-1 教训口径：带 `-d relayp000`）
- `ls -d /tmp/webux11-preview-{reg,remote-base,stage,verify}-* | wc -l` → **69**（登记基线 23 套 69 目录+2 旧日志=71 条全名匹配）
- `ps -p 3242781,3242782 -o pid=` → 两行常在
- `ip -4 addr show ens33` → `inet 10.30.5.80/16 … scope global … ens33`（MAC 卡主网卡事实核真）

## 三、diff 亲读结论（合同 C 项最小实现）

`scripts/webux11-preview.mjs` 全文 diff 亲读，变更=①头注释补 `--lan` 用法与 LAN≠公网警示；②`networkInterfaces` 导入；③新增块：`argLan=process.argv.includes("--lan")`→`if (argLan) process.env["RELAY_WEB_ALLOW_NON_LOOPBACK"]="1"`、`bindHost=argLan?"0.0.0.0":"127.0.0.1"`、`lanIPv4List()`（family==="IPv4" && !internal 全列）；④`createRelayServer({host: bindHost,…})`；⑤`server.listen(argPort, bindHost)`；⑥banner 分支（--lan：逐 IP URL+⚠警示行；缺省：原 SSH 行保留+新增 1 行「局域网直接访问(可选)…」提示）。与合同声称的变更面逐条吻合，零隐藏改动。

`test/e2e/webux13-preview-lifecycle.test.ts` 全文 diff 亲读：T1/T2 断言体**逐字未动**（diff 仅触及头注释/OUT_DIR 常量/imports/Preview 接口新增 stdoutText 字段/startPreview 增加可选 extraArgs/文件尾新增 T3、T4 两个 it 块）。OUT_DIR 缺省迁至 `p0-mvp/web-lan-preview-14/evidence/`，`WEBUX13_OUT_DIR` 可覆盖，13 封存证据目录未在 diff 中出现（零改写）。T3=--lan 全旅程（LAN IP 探针 302/401→登录 200→授权 200/200+banner 断言布尔值[stdout 原文不进证据]+TERM exit 0+端口释放+tmp 零新增+schema 零残留）；T4=缺省绑定面防回归门（回环 401 在场复核防假绿+LAN IP 必须连接拒绝）。

server 层事实亲核（只读）：`src/server/app.ts:61` `ensureLoopbackBind`——非回环 host 且 `RELAY_WEB_ALLOW_NON_LOOPBACK!=="1"` 即抛 BindRejectedError，脚本设 env=1 恰为该机制的设计用途；`src/server/auth.ts:256` 会话 Cookie 无 Secure（明注本地 HTTP 场景）+HttpOnly+SameSite=Strict。**零 src/ 改动属实**。

## 四、红态独立复现（TAG=review-red）

```bash
cd /tmp/p14-review-90977-relay && git checkout feacc99 -- scripts/webux11-preview.mjs
RELAY_E2E=1 WEBUX13_TAG=review-red npx vitest run test/e2e/webux13-preview-lifecycle.test.ts
```

真实输出摘录：
```
❯ test/e2e/webux13-preview-lifecycle.test.ts (4 tests | 1 failed) 4946ms
   ✓ T1 就绪后 SIGTERM:…零新增  1463ms
   ✓ T2 启动窗口 SIGTERM:…零 schema 残留  1175ms
   × T3 --lan:经本机非回环 IPv4 可达(302/401→200),banner 打印 LAN URL,退出零泄漏  1051ms
     → fetch failed
   ✓ T4 缺省绑定面防回归门:…  1254ms
 Tests  1 failed | 3 passed (4)     EXIT=1
FAIL …T3 … TypeError: fetch failed
Caused by: Error: connect ECONNREFUSED 10.30.5.80:34039
```
- 失败恰为 T3 且根因=`ECONNREFUSED 10.30.5.80`（父版本脚本忽略 --lan 仅绑回环）——与执行方登记「恰 1 failed=T3 经 10.30.5.80 ECONNREFUSED=缺陷逐字复现」**逐字一致**。
- T4 红轮即绿属设计内（缺省拒绝面本就正确），执行方已如实登记，本审确认该登记口径成立。
- 随后 `git checkout HEAD -- scripts/webux11-preview.mjs` 还原，`git status` 干净。

## 五、绿态亲测（TAG=review）

```bash
cd /tmp/p14-review-90977-relay && RELAY_E2E=1 WEBUX13_TAG=review npx vitest run test/e2e/webux13-preview-lifecycle.test.ts
```
```
✓ test/e2e/webux13-preview-lifecycle.test.ts (4 tests) 5356ms
  ✓ T1 1488ms  ✓ T2 1187ms  ✓ T3 1426ms  ✓ T4 1252ms
 Tests  4 passed (4)     EXIT=0
```
T3 证据 facts（review.json）：`{unauthWs:302, unauthHealth:401, login:200, authedWs:200, authedHealth:200}`、`{code:0, signal:null}`、`{newDirs:0, schemaBefore:0, schemaAfter:0}`；T4 facts：`{loopback:401}`、`{lanRejected, errKind:TypeError}`。**T1/T2 既有语义零改动通过。**

## 六、真实 --lan 冒烟（Reviewer 独立子进程）

命令形态（口令只经内核管道+shell 变量，未落任何文件；以下所有输出均脱敏）：
```bash
mkfifo $F; exec 5<> $F
node scripts/webux11-preview.mjs --lan --port 18945 >$F 2>&1 &   # $!=node 真实 PID
# 逐行读 banner→提取口令(变量)→curl 经 http://10.30.5.80:18945 探针→kill -TERM→wait→核计数
```
真实输出摘录（口令与 Cookie 值脱敏）：
```
BANNER:   本机访问   http://127.0.0.1:18945/workspace
BANNER:   局域网访问 http://10.30.5.80:18945/workspace   (Mac/手机等同网段浏览器直接打开)
BANNER:   局域网访问 http://172.17.0.1:18945/workspace   （+172.21/172.19/172.24.0.1，多网卡如实全列）
BANNER:   ⚠ 局域网模式(--lan):仅限可信局域网;严禁任何端口映射/反向隧道把本预览暴露到公网(LAN≠公网)。
BANNER: 本次登录口令(仅打印一次):***MASKED(len=12)***
unauth /workspace => 302 http://10.30.5.80:18945/login.html
unauth /api/health => 401
login /api/session => 200
authed /workspace => 200 ; authed /api/health => 200
SIGTERM node exit code => 0
PORT RELEASED
AFTER: tmpDirs=69 (delta=0) ; p01aSchemas=25 (delta=0)
prod PIDs: 3242781 3242782
```
全部合同 D 项冒烟判据达成。

**Reviewer 侧过程事故如实登记（非实施缺陷，反证健壮性）**：第一轮脚手架用 bash coproc 启动，中止时误将 TERM 发给复合命令的包装 subshell（node 为其子进程幸存），留下 +3 目录+1 schema 残留；对真实 node PID（孤儿场景：父进程已死、stdout 管道已关）直接补发 SIGTERM 后**仍走优雅清理**——进程退出、3 目录全删、schema 26→25、端口释放。该意外反而实证：即便在非正常父亡/管道断裂场景，脚本信号处理与清理路径依然完好；残留责任在 Reviewer 脚手架误杀，不在被审实现。第二轮（FIFO 正确脚手架）全绿且零残留。

## 七、缺省不变性论证（合同 E 项硬点）

逐字段对照父版本（feacc99）：
1. **env**：`RELAY_WEB_ALLOW_NON_LOOPBACK` 仅在 `argLan` 为真时设置；缺省进程 env 与父版本完全一致（grep 证实脚本内该串仅 3 处：2 注释+1 条件赋值）。
2. **绑定面**：`bindHost` 缺省="127.0.0.1" ⇒ `createRelayServer({host:"127.0.0.1"})` 与 `server.listen(argPort,"127.0.0.1")` 与父版本逐字等价。
3. **shutdown/清理路径**：对两版本脚本中含 SIGINT/SIGTERM/SIGHUP/shutdown/safeRm 的全部行做 diff → **IDENTICAL**；临时目录登记/哨兵/createTestDb 收尾逻辑零触碰。
4. **输出面**：缺省分支保留父版本两行原样（本机访问+Mac 经 SSH），**新增 1 行**「局域网直接访问(可选):重启并加 --lan 旗标(仅限可信局域网;禁公网暴露)。」。本审判定：**可接受**——纯提示性输出，不触绑定/生命周期/清理任何语义，提升缺省用户对 --lan 能力的可发现性，执行方已在实施说明中如实登记为输出面变更，且 T1/T2（生命周期断言）绿态通过构成行为不变的运行时证据。
5. 运行时佐证：T1/T2（13 既有断言逐字未动）绿轮通过；T4 把「缺省经 LAN IP 必须拒绝+回环正常」固化为防回归门并纳入 CI。

## 八、CI 独立核验（run 44194276677@e72c6ce）

`gh run view 44194276677` → `status=completed, conclusion=success, jobs: e2e=success, test=success`。亲读 `gh run view --log` 关键行（ANSI 剥离后）：
```
e2e   Test Files  8 passed | 2 skipped (10)
e2e        Tests  65 passed | 2 skipped (67)          ← =基线 63 + 新增 2（T3/T4），精确对账
e2e   ✓ test/e2e/webux13-preview-lifecycle.test.ts (4 tests) 3719ms   ← 4 tests 真跑
e2e   ✓ …lifecycle > T1 …1051ms / T2 …812ms / T3 --lan…991ms / T4 缺省绑定面…863ms  ← 具名全绿
test  quality:full   Test Files 76 passed | 17 skipped (93)
test  quality:full        Tests 484 passed | 85 skipped (569)   ← 基线不变
test  quality:quick       Tests 182 passed (182)                ← 基线不变
```
计数逐项与「65p|2s(67)=63+2、484p|85s[569]、182 不变」预期精确一致，无绿而不全。

## 九、证据卫生与 MAC 卡对照

**证据卫生（p0-mvp/web-lan-preview-14/evidence/ 5 件全查）**：
- 16+ 位 hex 全目录 grep：零命中；`csrf|set-cookie|bodyHead|pwHead` 零命中；口令原文零出现（三份 JSON 的 stdoutTail 内口令行=***REDACTED***）；`hasCookie` 均为布尔。13 Major-2 教训（响应体片段不进证据）已落实。PASS。
- preview-lan-smoke.log：facts-only（状态码/URL/计数），口令零落盘声明与实际相符。

**MAC-ACCEPTANCE-CARD.md「局域网直接访问」节逐条对照**：
| 卡面表述 | 事实核 |
|---|---|
| 主网卡 `http://10.30.5.80:8790/workspace`（多网卡以 banner 为准、如实全列） | `ip -4 addr show ens33`=10.30.5.80/16 实核；冒烟 banner 逐 IP 全列 5 个非内部 IPv4 ✓ |
| 缺省（不加 --lan）仍仅绑 127.0.0.1 | diff 逐字段论证+T4 CI 门 ✓ |
| 仅限可信局域网；严禁端口映射/反向隧道到公网（LAN≠公网） | banner ⚠ 行与卡面同口径 ✓ |
| SSH 隧道路径保留 | 缺省 banner 原 SSH 行逐字保留（verify.json stdoutTail 可见）✓ |
| 一次性随机口令、当次打印当次用、退出清理一致 | 冒烟实测：口令当次生成仅打一次；SIGTERM 清理与 13 口径一致 ✓ |
| 手机节：同网段可经 --lan 直访；真机 VPN/刘海/软键盘仍 NOT_TESTED | 诚实限制表述未越权宣布 ✓ |

顶部口径行已补 14 包说明；USER_DECISION=用户本人实机反馈、Agent 不代宣布，未变。

## 十、发现的问题分级

**Major：无。**

**Minor（非阻断，1 项）**：
- **Minor-1（元数据陈旧）**：harness `test/e2e/webux13-preview-lifecycle.test.ts:214` 将证据 JSON 的 `"contract"` 字段硬编码为 `"RELAY-MAC-UX-HANDOFF-13"`，故 14 轮次产出的 preview-lifecycle-*.json（含入库的 audit-red/verify/replay 与本审 review-red/review 轮）内嵌元数据仍标 13 合同名。文件目录（web-lan-preview-14/evidence/）、tag 与 capturedAt 可消歧，不涉卫生性/凭据/计数，不阻断；建议后续（如 15 或下次触碰该 harness 时）把该字段改为「RELAY-MAC-UX-HANDOFF-13→14 沿用」或注入当前包名，避免未来按 contract 字段检索时的误归类。修复面=该 1 行字符串，无行为影响。

**观察项（非问题，如实登记）**：①T4 红轮即绿属设计内（缺省拒绝面本就正确），执行方登记口径成立；②缺省 banner 新增 1 行提示属输出面、已如实登记，判定可接受（§六.4）；③执行方 audit-red-replay.log 显示其红态重放运行于 /home/ubuntu/dev/relay（执行方为合法 Writer 的自有工作区），非审计克隆口径——合同对本审（Reviewer）要求冷启动克隆亲测，已满足；执行方自身过程证据产生地不构成问题。

## 十一、终裁

**PASS。** 合同 RELAY-WEB-LAN-PREVIEW-14 的 A–F 各项与硬禁令经独立冷启动亲测全部成立：红态缺陷逐字复现、绿态 4/4、真实 LAN 直访全链路（302/401→200→200/200）与 SIGTERM 零泄漏、缺省行为逐字段不变、CI 计数精确对账、证据卫生达标、生产与保护物零触碰。工程阶段结论=**LAN_READY**（生产预检 NO-GO 维持不变；UX ACCEPTED 仍唯一归属用户本人实机反馈）。

*Reviewer 亲测证据留痕：/tmp/p14-review-90977-red-run.log、/tmp/p14-review-90977-green-run.log、/tmp/p14-review-90977-ci.log、克隆内 evidence/preview-lifecycle-review-red.json 与 preview-lifecycle-review.json（TAG=review-red/review，均为 Reviewer 自建，不覆盖任何封存轮次）。*

---

## 十二、执行方消化（收口提交附记;以上 §一~§十一 为独立 Reviewer 原文逐字入库,零改写）

- **终裁 PASS(0 Major / 1 Minor 非阻断)全部接受**;工程终态=LAN_READY。
- **Minor-1(证据 JSON `contract` 字段硬编码 "RELAY-MAC-UX-HANDOFF-13")=登记未实施,列入后续 harness 加固候选**(与 13 Minor-m3 同册):Reviewer 建议后续触碰该 harness 时改为注入当前包名(修复面=1 行字符串)。执行方注:该字段属元数据陈旧,14 轮次证据以目录(p0-mvp/web-lan-preview-14/)+TAG(review-red/review/verify/audit-red)+捕获时间三重可消歧,不涉卫生/计数/安全;收口提交不触碰代码面,使收口 CI 纯文档提交与被审实施 e72c6ce 的测试行为完全同口径。
- 观察项①②接受(已在 REPORT §2/§3 如实登记);观察项③(执行方红态重放产生于自有工作区而非克隆)接受登记——执行方红态重放属实施过程证据(合同 B 项),Reviewer 独立红态复现(克隆内 review-red)为本审证据,两者并存互证。
- 收口提交内容=REPORT(§0/§7 终裁回填)+REVIEW(本文件)+CURRENT/CONTINUATION 收口段+CI 计数摘录入库;收口自身 CI 推送后核验(纯文档提交,预期计数与 e72c6ce 完全一致)。
