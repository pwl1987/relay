# 阶段 C:GitHub 真实交付补验——权限核查记录(2026-11-11)

- 依据:总执行包 §五 C1(不得仅凭 HTTP 200 判定写权限;逐项核查;不打印 token;不用宽权限 gh token;不自建 Token)
- 结论:**BLOCKED(用户侧单点)**——比 P0-ACCEPT 时的判定(缺 Contents RW)**更前置:沙箱仓库根本不在 PAT 授权范围**

## 逐项核查结果

| # | 核查项 | 方式 | 结果 |
| --- | --- | --- | --- |
| 1 | 凭据形态/权限位 | stat+前缀判定(不读内容到输出) | ✓ fine-grained(github_pat_ 形态),0600,93 字节 |
| 2 | Token 有效性/所属 | `GET /user`(Bearer) | ✓ 200,所属 pwl1987(token 有效、非待批准) |
| 3 | **沙箱仓库授权范围** | `GET /repos/pwl1987/relay-delivery-sandbox`(Bearer) | ✗ **404**(fine-grained 语义=仓库不在 token 范围) |
| 4 | token 可见仓库清单 | `GET /user/repos?per_page=100` | ✗ 72 个仓库中**无** relay-delivery-sandbox |
| 5 | 仓库公开存在性 | 匿名 `GET /repos/...` | 404(仓库私有;与 #3 互证:token 未被授予该仓库) |
| 6 | Contents RW | 前置被 #3/#4 阻断 | 无法授予判定 |
| 7 | 凭据隔离 | github-real.test.ts 夹具自证(既有) | ✓ 隔离凭据文件,不依赖 gh 宽权限 token |
| 8 | 代理/环境干扰 | env -u 直连 | ✓ API 直连可达,无干扰 |

## 与历史口径的差异说明

P0-ACCEPT 缺口 B 曾记录"API 认证 200 + git push 403"。本次逐项核查修正:200 是 `/user`(token 本体有效);**仓库资源端点为 404**——根因是 fine-grained PAT 的 Repository access 未包含沙箱仓库(而非"已选仓库但缺 Contents 权限")。历史 403 与本次 404 是同一缺权问题的两种表现(无仓库访问时 API 404、部分路径 403),不矛盾。

## 用户侧最小操作(解除 BLOCKED 的唯一动作)

1. GitHub → Settings → Developer settings → Fine-grained tokens → 编辑本 PAT;
2. **Repository access**:勾选 `pwl1987/relay-delivery-sandbox`(仅此仓库即可);
3. **Permissions → Contents: Read and write**(其余权限不加);
4. 完成后运行:`npx vitest run test/integration/github-real.test.ts`(VM80;零额外授权,合同内既定实验)→ 交付/漂移/历史只增不减三重核对自动执行并补录证据。

不得使用宽权限 gh token 替代;不得自行创建更高权限 Token(总包 §五 C1)。

## 对总计划的影响

- 阶段 C 判 BLOCKED(外部凭据单点),不阻塞:阶段 D(F1/F2/F3)→ 阶段 E(编排/长稳)照常推进;GitHub 交付留作最终 MVP 验收必过门(阶段 F)。

## 复查记录(收口包;2026-11-11 ~18:00 +08)

- 复查方式:同法(仓库端点+可见仓库列表;零 token 打印)。
- 结果:**仍未授权**——仓库端点 404(细粒度语义=不在 token 范围);72 个可见仓库无 relay-delivery-sandbox。
- 用户侧最小操作不变(Repository access 勾选沙箱仓 + Contents: Read and write);补权后 `npx vitest run test/integration/github-real.test.ts` 闭环。
- 状态:维持 **BLOCKED**。
