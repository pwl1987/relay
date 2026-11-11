# P0-ACCEPT:GitHub 交付验收记录(缺口 B)

- 验证 HEAD:`02c094f`;目标仓库:**仅** `pwl1987/relay-delivery-sandbox`(沙箱;治理禁止触碰其他仓库)
- 结论:**BLOCKED(出口网络故障)**——凭据面就绪,网络面不可用;不影响其他独立验收(已全部继续并完成)

## §1 PAT 预检(零密钥输出)

| 检查 | 结果 |
| --- | --- |
| 凭据文件存在性 | `~/.relay/credentials/github-sandbox-pat` 存在 |
| 权限 | `0600` ✓ |
| 大小/形态 | **93 字节;`github_pat_` 前缀**(细粒度 PAT 有效形态)——与 P0-02B 时点(11 字节非令牌)相比,**用户已补录有效形态凭据** |
| 内容输出 | **零**(本记录与全部日志无任何令牌明文;redact 面另有单测保障) |

## §2 网络连通性预检(区分 401/403/404/网络故障)

| 检查 | 命令(时点 UTC) | 结果 | 分类 |
| --- | --- | --- | --- |
| GitHub API HTTPS | `curl -m 20 https://api.github.com/repos/pwl1987/relay-delivery-sandbox`(Bearer 形态 PAT;02:0x) | **HTTP=000,EXIT=28(超时)** | **网络故障**(非 401/403/404——无 HTTP 响应可判) |
| git 协议 | `git ls-remote origin main` | 超时(EXIT 124/143) | 网络故障 |
| 代理端口 | 127.0.0.1:8118 / :1080 监听 | 端口开(privoxy 活着) | 本机代理进程正常 |
| socks 上游 | `curl -x socks5h://127.0.0.1:1080 generate_204 -m 5` | 超时 | **上游链路断**(宿主级/上游故障;本包无权重配宿主网络服务,仅诊断) |

## §3 既有真实远端证据(继承 P0-02B)

- 有效凭据缺失时代的**安全失败实测**:鉴权被拒 ⇒ FAILED(非 DELIVERED)、写入零调用、远端零变化(`p0-02b/github-api-verification.log`;API 核验四端点 401)。
- 漂移拒绝/非强推/Policy host 白名单/userinfo 拒:已由 P0-02B 补验实现级证明(V10 VERIFIED)。

## §4 网络恢复后的既定闭环(无需新授权)

1. `npx vitest run test/integration/github-real.test.ts`(真实写入 + 漂移实验;目标钉扎沙箱仓);
2. 补录证据到 `p0-02b/`(合同内既定实验);
3. 随后 G6/US-08 从 NOT_VERIFIED/BLOCKED 提议升 VERIFIED(需在报告补记,不改本包结论结构)。

## §5 诚实声明

- 本包**未**发生任何真实 GitHub 写入(网络不通,无从发生);
- 未使用宽权限 gh token;未触碰 relay-delivery-sandbox 以外任何远端;未强推;
- "安全失败"语义已在此前真实远端实测中建立:凭据/漂移问题不会造成静默错误写入。
