# REVIEW — RELAY-DEPLOY-REHEARSAL-08R(完整包复核,合同 E 项终裁)

- Reviewer:独立复核窗口(隔离上下文、冷启动),与前轮门核同一 Reviewer 身份延续
- 复核基线:`main` HEAD=395091fe42946804753ebbff7871da29243c7b64(=合同登记提交,亲验 `git rev-parse`)
- 时序声明:**本轮完整包复核先于实施提交进行**。被复核对象为工作区未提交改动;实施者后续提交将原样包含本 REVIEW 所复核的工作区状态(d08-ephemeral-pg.ts mtime=09:54:46 为门核轮恢复原样时刻,门核后零改动;M1 增补于 test/unit 文件 mtime=09:56:58;证据日志 09:49–10:00 mtime 可稽)。
- 复核方法:全部证据亲验/亲跑(纯模拟复跑、真实 Docker E2E 四套件复跑、真实回环差分探针复跑、只读 docker 命令、ps 只读);零真实 `-P` 启动、零生产触碰、未修改 config/、p0-mvp/soak-r3b/、两个未跟踪 CI 回执、CURRENT/CONTINUATION/REPORT。

---

## 一、门核轮(前置门,前次复核,结论 GATE-PASS)

| 项 | 结果 | 证据 |
|---|---|---|
| 1a argv 逐字段对照 | 通过 | 旧(395091f)`run -d --name <c> -e POSTGRES_PASSWORD -e POSTGRES_DB=relayd08 -P postgres:17-alpine`;新 `buildEphemeralPgRunArgs` 唯一差异 `-P` → `["-p","127.0.0.1::5432"]`,其余逐字保留 |
| 1b E2E diff 最小化 | 通过 | `git diff 395091f` 仅 import + 内联 docker run/docker port 块替换为 `startEphemeralPg` 调用;备份/迁移/恢复/回退断言、SELECT 1 就绪门、afterAll 清理零改动 |
| 1c 无 wildcard 残留 | 通过 | 三文件 grep 全命中为注释/反向断言,无实际参数 |
| 2 红绿证据 | 通过 | 红态① 14F/1P、红态② 3F/12P(均 exit=1)、绿态 15/15(exit=0)逐字段一致 |
| 3 红态真实性抽验 | 通过 | 临时改回旧 `-P` 形复跑:恰 3 失败(argv×2+编排内嵌 no-`-P`)/12 过/exit=1,失败集合与红态②逐条一致;已逐字恢复(grep 无临时标记,复跑 15/15) |
| 4 fail-closed 矩阵 | 通过 | 合同负向清单逐项有测试且断言拒绝;拒绝路径 `rmCalls.length===1` 且 argv 精确 `["rm","-f",<唯一 nonce>]` |
| 5 边界 | 通过 | `git diff --stat` 仅 E2E 一文件;config/、soak-r3b/、CI 回执 mtime 早于 08R 窗口 |

门核轮 Minor:M1(`"5432/tcp":[]` 分支无独立断言)→ **本轮已消化**(见二.1)。

## 二、完整包轮(本轮独立核验)

**1. M1 消化 —— 通过。**
test/unit/d08-ephemeral-pg.test.ts:122 增补 `expect(() => parseLoopbackPortMapping(\`{"5432/tcp":[]}\`)).toThrow(/5432/)`;测试总数仍 15(本轮亲跑 15/15)。

**2. 真实 Docker E2E + 四套件 —— 通过(亲跑复现)。**
Reviewer 亲跑 `npx vitest run test/unit/d08-ephemeral-pg.test.ts test/integration/deploy-rehearsal.test.ts test/integration/deploy-rehearsal-e2e.test.ts test/integration/evidence-gate-rehearsal.test.ts`(2026-11-15 10:01:46):**28/28 全绿,exit=0**(08R 单测 15/15 + 迁移演练 9/9 + 真实 Docker E2E 1/1 + Gate 3/3),与 evidence/targeted-08r-final.log(09:58,exit=0)逐字段一致。E2E beforeAll 经 `startEphemeralPg`(显式回环发布 + inspect 强校验)实证运行。

**3. 真实回环差分探针 —— 通过(亲跑复现)。**
- 源码真实性:证据日志内嵌源码与磁盘 /tmp/probe-08r/probe.ts `diff` 逐字一致(PROBE-SOURCE-IDENTICAL)。
- Reviewer 亲跑(以 `.mts` ESM 方式运行原脚本逐字副本,ts-顶层 await 需 ESM;原脚本未修改):`startEphemeralPg ⇒ hostIp=127.0.0.1 hostPort=32794`(独立随机端口,异于实施者运行的 32791 ⇒ 随机端口+回环钉死均可复现);真实 `docker inspect` = `{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"32794"}]}`;PG SELECT 1 成功;127.0.0.1 控制面可连;宿主全部 10 个非回环 IPv4(10.30.5.80 + 9 个 docker bridge 网关)单端口 TCP 探针 **全部 ECONNREFUSED**(若为 wildcard 则会连上 —— 差分即绑定面证明);`relay-test-d08-*` 残留=0(内建核验 + Reviewer 独立 `docker ps -a` 二次复核);probe-exit=0。与 evidence/probe-08r-loopback-lan.log 结论一致。
- 首版探针 SELECT 1 无重试撞 initdb 窗口的工具缺陷:日志头部与源码注释均如实登记(08 CI 教训 §6⑥ 同款),修复为 90s 重试后重跑 —— 登记方式诚实,非隐瞒。

**4. quality:quick —— 通过。**
evidence/quality-quick-08r.log:lint(exit=0;违规均为全仓存量 warnings/infos,三个改动文件零违规)、format(三改动文件 exit=0)、`tsc --noEmit`(exit=0)、全仓 unit 140/140(含 d08 15/15),总裁决 PASS。本轮亲跑的四套件与 15/15 与其交叉印证。

**5. 边界与硬禁令 —— 通过(逐条亲验)。**
- 残留:`docker ps -a` 亲核 `relay-test-d08-*` = 0(四套件复跑前后、探针复跑后)。
- 生产 PID:`ps` 亲核 3242781(server)/3242782(worker)在,启动 Fri Nov 13 02:00:08 2026,与 boundary-08r-check.log 逐字一致,零重启。
- 改动面:`git status/diff --stat 395091f` = 仅 E2E 一文件修改 + 2 新文件;src/、deploy/、preflight、迁移文件零改动;config/、p0-mvp/soak-r3b/、ci-checkruns-27e9259.json、ci-checkruns-e28c386.json 未触碰(mtime 2026-11-12~11-14,早于 08R 窗口)。
- 环境因素亲证:`docker network inspect bridge` = `com.docker.network.bridge.host_binding_ipv4: "0.0.0.0"` —— 修复前 `-P` 在本机确为 wildcard 0.0.0.0 发布,修复必要性叙述真实;显式 `-p 127.0.0.1` 正确覆盖该 daemon 选项。
- 零生产连接:改动面内全部真实连接 = E2E/探针自建一次性容器(127.0.0.1 随机端口)+ 迁移单测 testdb;源码复核无生产 relay_console/public 连接路径。

**6. 源码复核(合同 E)—— 通过。**
- `startEphemeralPg` 编排:run 失败 ⇒ 如实抛出且不 rm(无容器可误删);inspect/校验失败 ⇒ `destroyEphemeralPg`(仅本容器唯一 nonce,`["rm","-f",<c>]` 精确断言)后抛出原错误信息;destroy 尽力而为不掩盖原错误。
- `parseLoopbackPortMapping`:仅接受精确 127.0.0.1 + 单条 + 非空数字 HostPort(1–65535)+ 无任何其他端口暴露;JSON 解析/类型/数组分支全 fail-closed。
- wildcard 残留 grep(本轮重做):仅 src/runtime/{sandbox,egress}.ts 既有注释(egress-fwd 代理设计,src/ 零改动),无实际参数。

**7. 修复前后 HostIp 面对照 —— 通过。**
旧:`docker run -P` + `docker port` 取端口 ⇒ 本机环境(bridge host_binding_ipv4=0.0.0.0,亲证)下 5432 发布于 0.0.0.0 wildcard。新:显式 `-p 127.0.0.1::5432` + inspect 强校验 + 真实差分探针(10 个非回环接口全 ECONNREFUSED)⇒ 绑定面收敛至回环,经真实运行实证。

**8. 红绿证据真实性 —— 通过。**
红态:门核轮已实验复现红态②(临时 -P ⇒ 3F/12P),红态①(14F/1P,工具缺失中间态)日志与测试源吻合;绿态:本轮三重亲跑(15/15、28/28、探针 PASS)全部复现。

## 三、问题清单

- **Major:无。**
- Minor/备注(均不阻塞):
  - N1:探针脚本实体在 /tmp(易失),但源码全文已内嵌于证据日志且与磁盘逐字一致;复现时需以 ESM 方式运行(如复制为 `.mts`,顶层 await;`npx tsx` 对 /tmp 下 .ts 默认按 CJS 解析会报错)。属复现方法备注,非缺陷。
  - N2(门核轮 M1):已在本轮消化(test:122 增补,仍 15 测试),关闭。

## 四、结论

完整包复核(源码、argv 对照、fail-closed 矩阵、异常清理路径、wildcard 残留、红绿证据、真实 Docker E2E、真实回环差分探针、quality、边界与硬禁令)全部通过;三项运行证据(四套件 28/28、探针差分 PASS、零残留)均为 Reviewer 亲自复跑所得,非采信实施者叙述。

终裁:PASS(0 Major)
