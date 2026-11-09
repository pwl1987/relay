// Pi 版本锁定单测:三方一致(锁定常量/包声明/二进制输出),不符即拒启。
import { describe, expect, it } from "vitest";
import { writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RELAY_PI_VERSION, resolveVendoredPi, verifyPiRuntime, type PiInstallation } from "../../src/runtime/pi-version.ts";

describe("Pi 版本锁定", () => {
  it("vendored 解析为精确锁定版本", () => {
    const pi = resolveVendoredPi();
    expect(pi.version).toBe(RELAY_PI_VERSION);
    expect(pi.cliPath.endsWith("dist/bundle/cli.js")).toBe(true);
    expect(pi.cliPath.includes("node_modules/@earendil-works/pi-coding-agent")).toBe(true);
  });

  it("运行时二探:实际执行 --version 与锁定版本一致", () => {
    const pi = resolveVendoredPi();
    const verified = verifyPiRuntime(pi);
    expect(verified.version).toBe(RELAY_PI_VERSION);
  });

  it("版本不符的安装被拒启(伪造二进制输出)", () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "relay-fake-pi-"));
    const fakeCli = join(fakeDir, "cli.js");
    writeFileSync(fakeCli, "console.log('9.9.9');\n");
    chmodSync(fakeCli, 0o755);
    const fake: PiInstallation = {
      cliPath: fakeCli,
      version: RELAY_PI_VERSION,
      packageDir: fakeDir,
      repoRoot: fakeDir,
    };
    expect(() => verifyPiRuntime(fake)).toThrow(/version mismatch/);
  });
});
