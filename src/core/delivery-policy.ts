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
}

/** 生产默认:空白名单(全拒)+ 仅 main + 仅 github.push。 */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicyConfig = {
  allowedRepos: [],
  allowedBranches: ["main"],
  allowedCapability: "github.push",
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
  if (repoSlug === null) {
    return { allowed: false, reason: "unparseable_target", repoSlug: null };
  }
  // 白名单默认空 = 全拒(D-5/G-2);仅精确匹配(GitHub 为 owner/repo,本地为路径)。
  if (!config.allowedRepos.map((r) => r.toLowerCase()).includes(repoSlug)) {
    return { allowed: false, reason: "repo_not_allowed", repoSlug };
  }
  if (!config.allowedBranches.includes(input.branch)) {
    return { allowed: false, reason: "branch_not_allowed", repoSlug };
  }
  if (!SHA_RE.test(input.commitSha)) {
    return { allowed: false, reason: "invalid_commit_sha", repoSlug };
  }
  if (!SHA_RE.test(input.expectedRemoteSha)) {
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
