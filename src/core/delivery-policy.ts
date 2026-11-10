// 交付 Policy(P0-02B D-5;确定性函数,默认拒绝,不依赖模型)。
// 决策面:capability / 目标仓库白名单 / 分支 / 授权基础(Gate PASS)/ 凭据存在性。
// 语义与 policy.ts(checkPathScope)同源:任何一项不满足即 DENIED,且 reason 具体可审计。
export interface DeliveryPolicyConfig {
  /** 允许写入的仓库白名单(owner/repo 小写规范形;默认空 = 全部拒绝) */
  allowedRepos: readonly string[];
  /** 允许的分支(固定 refs/heads/main;显式声明以便审计,不做通配) */
  allowedBranches: readonly string[];
  /** 唯一允许的远端写能力 */
  allowedCapability: string;
  /** 允许的远端 host(P0-02B 补验 F-3 收敛:默认仅 github.com) */
  allowedHosts: readonly string[];
}

/** 生产默认:空白名单(全拒)+ 仅 main + 仅 github.push + 仅 github.com。 */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicyConfig = {
  allowedRepos: [],
  allowedBranches: ["main"],
  allowedCapability: "github.push",
  allowedHosts: ["github.com"],
};

/** 规范化仓库标识:接受 owner/repo 或任意 git URL,提取小写 owner/repo;无法解析返回 null。 */
export function normalizeRepoSlug(input: string): string | null {
  const s = input.trim().toLowerCase();
  // owner/repo 形
  const direct = s.match(/^([a-z0-9][a-z0-9-_.]*)\/([a-z0-9][a-z0-9-_.]+?)(?:\.git)?$/);
  if (direct) return `${direct[1]}/${direct[2]}`;
  // https://host/owner/repo(.git) 形
  const https = s.match(/^https?:\/\/[^/]+\/([a-z0-9][a-z0-9-_.]*)\/([a-z0-9][a-z0-9-_.]+?)(?:\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  // git@host:owner/repo(.git) 形
  const ssh = s.match(/^git@[^:]+:([a-z0-9][a-z0-9-_.]*)\/([a-z0-9][a-z0-9-_.]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

/** 远端 host(小写);https/git/ssh 三形态;本地路径返回 null。 */
export function normalizeRepoHost(input: string): string | null {
  const s = input.trim().toLowerCase();
  const https = s.match(/^https?:\/\/([^/]+)\//);
  if (https) return hostOfAuthority(https[1]!);
  const ssh = s.match(/^[^@/]+@([^:]+):/);
  if (ssh) return ssh[1]!.toLowerCase();
  const gitScheme = s.match(/^git:\/\/([^/]+)\//);
  if (gitScheme) return hostOfAuthority(gitScheme[1]!);
  return null;
}

/**
 * 目标 URL 的显式端口(非标准端口返回该端口;无端口返回 null)。
 * 标准端口(https=443 / http=80)视为无端口;其余端口不得被 host 归一吞掉(F-6 收敛)。
 */
export function targetPort(input: string): string | null {
  const s = input.trim().toLowerCase();
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)\//);
  if (!m) return null;
  const authority = m[1]!;
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return null;
  const port = authority.slice(colon + 1);
  if (!/^\d+$/.test(port)) return null;
  const scheme = s.slice(0, s.indexOf(":"));
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) return null;
  return port;
}

/** 去掉 authority 中的 userinfo(user:pass@)——只留 host[:port]。 */
function stripUserinfo(authority: string): string {
  const at = authority.lastIndexOf("@");
  return at >= 0 ? authority.slice(at + 1) : authority;
}

/** authority → host(去 userinfo 与端口)。 */
function hostOfAuthority(authority: string): string | null {
  const bare = stripUserinfo(authority);
  const colon = bare.lastIndexOf(":");
  const host = colon >= 0 ? bare.slice(0, colon) : bare;
  return host.length > 0 ? host.toLowerCase() : null;
}

/** target 是否含 userinfo(https://user:token@host/...)——凭据入 URL 一律拒绝(argv 泄露面)。 */
export function targetHasUserinfo(target: string): boolean {
  const s = target.trim();
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)\//i);
  if (!m) return false;
  return m[1]!.includes("@");
}

const SHA_RE = /^[0-9a-f]{40}$/;

export interface DeliveryPolicyInput {
  capability: string;
  target: string;
  branch: string;
  commitSha: string;
  expectedRemoteSha: string;
  /** 已消费的 Gate PASS 裁决 id(授权基础);空/缺 = 未授权 */
  gateVerdictId?: string | null;
  /** 执行器凭据是否就位(0600 文件存在且非空);GitHub 写必须为 true */
  credentialPresent: boolean;
}

export interface PolicyVerdict {
  allowed: boolean;
  reason: string;
  /** 规范化后的仓库 slug(白名单比对基准;解析失败为 null) */
  repoSlug: string | null;
}

export function checkDeliveryPolicy(
  config: DeliveryPolicyConfig,
  input: DeliveryPolicyInput,
): PolicyVerdict {
  // GitHub 目标规范化为 owner/repo;本地/实验室目标(file:// 或绝对路径,测试/bare 演练用)
  // 以原样字符串参与白名单精确匹配 —— 白名单不含该路径即拒绝,生产配置不会允许本地路径。
  const isLocalTarget = /^(\/|file:\/\/|\.\/)/.test(input.target);
  const repoSlug = normalizeRepoSlug(input.target) ?? (isLocalTarget ? input.target.toLowerCase() : null);
  if (input.capability !== config.allowedCapability) {
    return { allowed: false, reason: "capability_not_allowed", repoSlug };
  }
  // userinfo URL 一律拒绝(凭据不得出现在 URL/argv 面;P0-02B 补验 F-4 收敛)
  if (targetHasUserinfo(input.target)) {
    return { allowed: false, reason: "target_userinfo_forbidden", repoSlug };
  }
  if (repoSlug === null) {
    return { allowed: false, reason: "unparseable_target", repoSlug: null };
  }
  // 白名单默认空 = 全拒(D-5/G-2);仅精确匹配(GitHub 为 owner/repo,本地为路径)。
  if (!config.allowedRepos.map((r) => r.toLowerCase()).includes(repoSlug)) {
    return { allowed: false, reason: "repo_not_allowed", repoSlug };
  }
  // host 收敛(P0-02B 补验 F-3):远程目标 host 必须显式在白名单(默认仅 github.com);
  // 本地路径目标无 host ⇒ 不受此闸约束(其准入门是上面的路径精确白名单)。
  if (!isLocalTarget) {
    const host = normalizeRepoHost(input.target);
    if (host === null) {
      return { allowed: false, reason: "unparseable_target_host", repoSlug };
    }
    if (!config.allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
      return { allowed: false, reason: "host_not_allowed", repoSlug };
    }
    // 端口维度(F-6 收敛):只允许标准端口;非标端口视为未授权目标面。
    const port = targetPort(input.target);
    if (port !== null) {
      return { allowed: false, reason: "host_port_not_allowed", repoSlug };
    }
  }
  if (!config.allowedBranches.includes(input.branch)) {
    return { allowed: false, reason: "branch_not_allowed", repoSlug };
  }
  if (!SHA_RE.test(input.commitSha)) {
    return { allowed: false, reason: "invalid_commit_sha", repoSlug };
  }
  // expected_remote_sha:40 位十六进制,或空串(目标分支尚不存在 ⇒ 本次为"创建分支"交付)。
  // 空串语义严格:远端若已存在该分支,前置核对(actual != "")⇒ CONFLICT(不会覆盖)。
  if (input.expectedRemoteSha !== "" && !SHA_RE.test(input.expectedRemoteSha)) {
    return { allowed: false, reason: "invalid_expected_remote_sha", repoSlug };
  }
  if (!input.gateVerdictId) {
    return { allowed: false, reason: "missing_gate_authorization", repoSlug };
  }
  if (!input.credentialPresent) {
    return { allowed: false, reason: "credential_missing", repoSlug };
  }
  return { allowed: true, reason: "in_scope", repoSlug };
}
