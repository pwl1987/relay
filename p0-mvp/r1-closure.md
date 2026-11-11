# R-1 闭环:GitHub 真实写入验收通过(2026-11-12)

- 前提:用户完成 PAT 补权(Repository access 勾选 `pwl1987/relay-delivery-sandbox` + Contents: Read and write;未扩大其他权限;明文未读取/复制/展示)
- 预核验(只读 API):仓库端点 200 + `permissions.push: true` + 所属 pwl1987 ✓
- 验收运行:`npx vitest run test/integration/github-real.test.ts`(代理变量净化后;首跑失败根因=测试进程 git 走坏代理——该测试 P0-ACCEPT 时因凭据缺失从未联网,本闭环首次暴露)

## 验收结果(4 passed / 1 skipped;1 skipped=经典 token 拒用例诚实 skip)

| 收口指令要求 | 结果 |
| --- | --- |
| 真实 main 写入成功 | ✅ 基于真实远端 HEAD 建候选 → DELIVERED(105s) |
| 远端漂移拒绝 | ✅ 外部写者快进推进 main ⇒ Relay 拒绝覆盖(CONFLICT/非 force);远端保持外来头 |
| Commit/Tree/内容三重核验 | ✅ 远端 HEAD==candidate commit + 树逐文件 + API 内容核对(测试内三重) |
| 历史不丢失 | ✅ `base → relay: task t-gh-real attempt 1 → foreign` 只增不减;外来头在顶 |
| 不强推 | ✅ 夹具自证无强推标志(始终执行用例)+ 漂移实验 REJECT_NO_FORCE_PUSH 语义 |

## 独立 API 复核(Reviewer 线外;交付后即时)

- `GET /commits`:base(`a49f4317`)→ relay 交付(`175eb071`,attempt 1)→ foreign(`0dbf08a9`,漂移实验)——顺序与语义吻合
- `GET /git/trees/<HEAD>`:README.md, delivered.txt, foreign.txt, src.txt(交付产物与外来内容共存)
- 日志:`p0-mvp/github-real-closure.log`

## 裁决变更

- **US-08/G6:BLOCKED → VERIFIED**(真实 GitHub 写入/漂移/历史保全全链实证;P0-02B 机制面 + 本闭环运行时面合一)
- 首跑网络失败的运维教训:github-real 类测试须在**代理变量净化环境**运行(与"Node/vitest 不读代理 env"不矛盾——execFileSync git 子进程继承 vitest 进程 env,该文件 git 调用显式带凭据但继承代理变量;宿主代理上游断 ⇒ 首跑 120s 超时)
