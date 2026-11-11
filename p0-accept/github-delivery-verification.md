# P0-ACCEPT:GitHub 交付验收记录(缺口 B)

- 验证 HEAD:`37d26b4`(记录更新时点:全量测试揭示网络实情后修正)
- 结论:**写面 BLOCKED(PAT 权限不足,403 实证);API 读面 VERIFIED(认证 200)**;不影响其他独立验收(已全部完成)

## §1 PAT 预检(零密钥输出)

| 检查 | 结果 |
| --- | --- |
| 凭据文件存在性 | `~/.relay/credentials/github-sandbox-pat` 存在 |
| 权限 | `0600` ✓ |
| 大小/形态 | **93 字节;`github_pat_` 前缀**(细粒度 PAT 有效形态)——与 P0-02B 时点(11 字节非令牌)相比,**用户已补录有效凭据** |
| API 认证 | **HTTP 200**(`github-real.test.ts` 门内探测:"凭据 wellformed;GitHub 认证 200")——PAT 有效且可读 |
| 内容输出 | **零**(本记录与全部日志无任何令牌明文) |

## §2 连通性预检(区分 401/403/404/网络故障)——终版结论

| 层 | 事实 | 分类 |
| --- | --- | --- |
| 本机代理栈(http_proxy=8118 / ALL_PROXY=1080) | 端口活但上游断(curl/git 走 env 代理 ⇒ 超时 HTTP=000) | **本机代理栈故障**(不影响 Node fetch/测试进程——Node 默认不读代理 env) |
| 直连出口(绕代理) | `env -u http_proxy … git ls-remote origin main` ⇒ **成功,远端 HEAD==f4c1248 无漂移** | **外网实际可达**(早期"网络故障"结论修正为"代理栈故障;直连正常") |
| GitHub API(测试进程内) | 认证 **200**(read 面) | PAT 有效 |
| **git push(写面)** | **HTTP 403:"Write access to repository not granted"**(`p0-accept/github-real-run.log`) | **PAT 缺沙箱仓 Contents 写权限** |

## §3 写入与漂移实验结果(github-real.test.ts,5 例)

| 用例 | 结果 |
| --- | --- |
| 夹具自证(零强推/目标钉扎/env 重定向拒) | ✅ PASS |
| 凭据门事实记录(缺失/经典令牌/探测不回退) | ✅ PASS |
| 凭据被拒 ⇒ 安全失败场景 | ↓ skip(场景前提不成立:当前凭据 API 200 非 401;安全失败语义已由 P0-02B 真实远端实测建立) |
| **一次真实 main 写入(DELIVERED+三重核对)** | ✗ FAIL ⇒ **403 权限不足**(executor_error 写入零调用;远端零变化;FAILED 非 DELIVERED——**安全失败语义再次实证**) |
| **远端漂移实验(拒绝覆盖)** | ✗ FAIL(同因:推送前置即 403) |

## §4 解除条件(用户侧动作;本包无权替代)

为 fine-grained PAT 增补 **`pwl1987/relay-delivery-sandbox` 的 Contents: Read and write** 权限(GitHub → Settings → Fine-grained tokens)后重跑 `npx vitest run test/integration/github-real.test.ts` 即闭环(合同内既定实验,无需新授权)。**不采用**宽权限 gh token(治理禁令);403 期间写入动作保持零调用、远端零变化。

## §5 诚实声明

- 本包**未发生**任何真实 GitHub 写入(403 前置拒绝;远端零变化);
- 全程只用沙箱仓;未强推;未触碰其他仓库;
- "安全失败"语义两度实证(P0-02B 401 路径 + 本包 403 路径):凭据问题均以 FAILED 收场,不静默、不假成功。

