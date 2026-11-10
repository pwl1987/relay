// 脱敏不变量(P0-02C G-5):任何离开服务端的文本都不得含明文凭据。
import { describe, expect, it } from "vitest";
import { redactSecrets, redactText, safeErrorMessage } from "../../src/server/redact.ts";

describe("P0-02C:脱敏(G-5)", () => {
  it("GitHub 令牌形态被替换(经典 + 细粒度)", () => {
    const classic = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const fine = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890";
    expect(redactText(`token=${classic}`)).not.toContain(classic);
    expect(redactText(`token=${fine}`)).not.toContain(fine);
    expect(redactText(`token=${classic}`)).toContain("<redacted>");
  });

  it("Authorization 头与 x-access-token 被替换", () => {
    const out = redactText("Authorization: Bearer abcdef1234567890XYZ");
    expect(out).not.toContain("abcdef1234567890XYZ");
    const out2 = redactText("https://x-access-token:ghs_ABCDEFGHIJKLMNOPQRSTUV");
    expect(out2).not.toContain("ghs_ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("URL userinfo 凭据被替换(保留用户部分)", () => {
    const out = redactText("https://user:sup3rs3cret@github.com/pwl1987/relay.git");
    expect(out).not.toContain("sup3rs3cret");
    expect(out).toContain("github.com");
  });

  it("私钥块整体被替换", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";
    const out = redactText(pem);
    expect(out).not.toContain("MIIEow");
    expect(out).toContain("<redacted>");
  });

  it("敏感字段名整词命中;计量字段不被误伤", () => {
    const out = redactSecrets({ password: "hunter2", apiKey: "k", tokensIn: 100, tokensOut: 20, tokenBudget: 8, state: "ACCEPTED" });
    const o = out as Record<string, unknown>;
    expect(o["password"]).toBe("<redacted:field>");
    expect(o["apiKey"]).toBe("<redacted:field>");
    expect(o["tokensIn"]).toBe(100);
    expect(o["tokensOut"]).toBe(20);
    expect(o["tokenBudget"]).toBe(8);
    expect(o["state"]).toBe("ACCEPTED");
  });

  it("嵌套结构递归脱敏", () => {
    const out = redactSecrets({ a: [{ b: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }] }) as { a: Array<{ b: string }> };
    expect(out.a[0]!.b).not.toContain("ghp_");
  });

  it("错误文本脱敏且不回显堆栈", () => {
    const err = new Error("push failed for https://u:p@host/x with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    const msg = safeErrorMessage(err);
    expect(msg).not.toContain("ghp_");
    expect(msg).not.toContain("u:p@host");
    expect(msg).not.toContain("Error:");
  });
});
