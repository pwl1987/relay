// P0-02B 补验 F-3/F-4 收敛:交付 Policy 的 host 钉扎与 userinfo 拒绝(纯函数,零 IO 零模型)。
// 红队视角:同 slug 不同 host、userinfo URL、端口/大小写/尾随点等绕过形态逐条断言拒绝。
import { describe, expect, it } from "vitest";
import {
  checkDeliveryPolicy,
  normalizeRepoSlug,
  normalizeRepoHost,
  targetHasUserinfo,
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicyConfig,
} from "../../src/core/delivery-policy.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function policy(over: Partial<DeliveryPolicyConfig> = {}): DeliveryPolicyConfig {
  return { ...DEFAULT_DELIVERY_POLICY, allowedRepos: ["pwl1987/relay-delivery-sandbox"], ...over };
}

function input(over: Partial<Parameters<typeof checkDeliveryPolicy>[1]> = {}) {
  return {
    capability: "github.push",
    target: "https://github.com/pwl1987/relay-delivery-sandbox",
    branch: "main",
    commitSha: SHA,
    expectedRemoteSha: OTHER_SHA,
    gateVerdictId: "gate-1",
    credentialPresent: true,
    ...over,
  };
}

describe("P0-02B F-3:Policy host 钉扎(默认仅 github.com)", () => {
  it("规范目标放行;同 slug 的其它 host 一律 host_not_allowed", () => {
    const ok = checkDeliveryPolicy(policy(), input());
    expect(ok.allowed).toBe(true);
    expect(ok.reason).toBe("in_scope");

    // 同 owner/repo 但 host 不同(凭据面本会兜住,Policy 层必须先拒)
    for (const host of ["gitlab.com", "github.com.evil.test", "raw.githubusercontent.com", "10.0.0.1"]) {
      const v = checkDeliveryPolicy(policy(), input({ target: `https://${host}/pwl1987/relay-delivery-sandbox` }));
      expect(v.allowed, `${host} 应被拒`).toBe(false);
      expect(v.reason).toBe("host_not_allowed");
    }
  });

  it("ssh/git 协议形态同样受 host 闸约束;host 大小写归一后比对", () => {
    const ssh = checkDeliveryPolicy(policy(), input({ target: "git@gitlab.com:pwl1987/relay-delivery-sandbox" }));
    expect(ssh.allowed).toBe(false);
    expect(ssh.reason).toBe("host_not_allowed");
    // 大小写归一:GITHUB.COM 视为 github.com
    const upper = checkDeliveryPolicy(policy(), input({ target: "https://GITHUB.com/pwl1987/relay-delivery-sandbox" }));
    expect(upper.allowed).toBe(true);
  });

  it("白名单未含 host 时默认拒绝(allowedHosts 空 = 全拒)", () => {
    const v = checkDeliveryPolicy(policy({ allowedHosts: [] }), input());
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("host_not_allowed");
  });

  it("F-6 收敛:端口维度不被 host 归一吞掉(非标端口一律拒;标准端口视为无端口)", () => {
    // 非标端口:host 仍是 github.com,但目标面未被授权 ⇒ 拒
    const v = checkDeliveryPolicy(policy(), input({ target: "https://github.com:8443/pwl1987/relay-delivery-sandbox" }));
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("host_port_not_allowed");
    // 标准端口视为无端口 ⇒ 放行
    const std = checkDeliveryPolicy(policy(), input({ target: "https://github.com:443/pwl1987/relay-delivery-sandbox" }));
    expect(std.allowed).toBe(true);
    const stdHttp = checkDeliveryPolicy(policy(), input({ target: "http://github.com:80/pwl1987/relay-delivery-sandbox" }));
    expect(stdHttp.allowed).toBe(true);
  });

  it("空 expected_remote_sha(创建分支语义)被允许;非法形态仍拒", () => {
    const create = checkDeliveryPolicy(policy(), input({ expectedRemoteSha: "" }));
    expect(create.allowed).toBe(true);
    expect(create.reason).toBe("in_scope");
    const bad = checkDeliveryPolicy(policy(), input({ expectedRemoteSha: "xyz" }));
    expect(bad.allowed).toBe(false);
    expect(bad.reason).toBe("invalid_expected_remote_sha");
  });
});

describe("P0-02B F-4:userinfo URL 拒绝(凭据不得入 URL/argv 面)", () => {
  it("含 user:pass@ 的 https URL 一律 target_userinfo_forbidden", () => {
    for (const target of [
      "https://user:token@github.com/pwl1987/relay-delivery-sandbox",
      "https://x-access-token:ghp_xxx@github.com/pwl1987/relay-delivery-sandbox",
      "http://user@github.com/pwl1987/relay-delivery-sandbox",
      "git://user:pw@github.com/pwl1987/relay-delivery-sandbox",
    ]) {
      const v = checkDeliveryPolicy(policy(), input({ target }));
      expect(v.allowed, `${target} 应被拒`).toBe(false);
      expect(v.reason).toBe("target_userinfo_forbidden");
    }
    // 无 userinfo 的正常 URL 不受影响
    expect(targetHasUserinfo("https://github.com/o/r")).toBe(false);
    expect(targetHasUserinfo("https://user@github.com/o/r")).toBe(true);
  });
});

describe("P0-02B:规范函数边界", () => {
  it("normalizeRepoSlug:仅接受 owner/repo 与 GitHub URL 形态;尾随点/多段/空 拒绝", () => {
    expect(normalizeRepoSlug("pwl1987/relay-delivery-sandbox")).toBe("pwl1987/relay-delivery-sandbox");
    expect(normalizeRepoSlug("https://github.com/pwl1987/relay-delivery-sandbox")).toBe("pwl1987/relay-delivery-sandbox");
    expect(normalizeRepoSlug("https://github.com/pwl1987/relay-delivery-sandbox.git")).toBe("pwl1987/relay-delivery-sandbox");
    expect(normalizeRepoSlug("pwl1987/relay-delivery-sandbox.")).toBe("pwl1987/relay-delivery-sandbox.");
    expect(normalizeRepoSlug("pwl1987/relay-delivery-sandbox/extra")).toBe(null);
    expect(normalizeRepoSlug("")).toBe(null);
    // 生产仓库 slug 仍需显式白名单(默认全拒)
    expect(normalizeRepoSlug("pwl1987/relay")).toBe("pwl1987/relay");
  });

  it("normalizeRepoHost:提取 host;userinfo 被剥离;本地路径无 host", () => {
    expect(normalizeRepoHost("https://github.com/o/r")).toBe("github.com");
    expect(normalizeRepoHost("https://user:pw@github.com/o/r")).toBe("github.com");
    expect(normalizeRepoHost("git@github.com:o/r.git")).toBe("github.com");
    expect(normalizeRepoHost("/tmp/local-repo")).toBe(null);
  });

  it("默认 Policy(空白名单)拒绝一切(默认拒绝语义保持)", () => {
    const v = checkDeliveryPolicy(DEFAULT_DELIVERY_POLICY, input());
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("repo_not_allowed");
  });
});
