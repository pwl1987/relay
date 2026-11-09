// OS 沙箱强制测试(V14/ADR-0003 OS 层;p0-00 A4 的 Vitest 正式化)。
// 与 launchPi 完全相同的挂载布局,直接 shell 探测(无模型参与,确定性):
// 非 root / cap-drop / 命名空间无 sentinel / 无 docker.sock / 无 SSH agent /
// 无 GH 凭据 / /etc 不可写 / /workspace 可写 / vendored pi 只读可见且版本=锁定值。
// 缺 docker 或镜像 ⇒ 显式 skip(不假装)。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SANDBOX_IMAGE, SANDBOX_UID, dockerAvailable, prepareRunDirs, cleanupSandbox, ensureNodeModulesReadable } from "../../src/runtime/sandbox.ts";
import { resolveVendoredPi, RELAY_PI_VERSION } from "../../src/runtime/pi-version.ts";

function imagePresent(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", SANDBOX_IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

ensureNodeModulesReadable(resolveVendoredPi().repoRoot);
const dockerOk = dockerAvailable();
const hasImage = dockerOk && imagePresent();

describe.skipIf(!dockerOk || !hasImage)("OS 沙箱强制(容器层)", () => {
  it("容器内边界:uid/能力/文件系统/环境四方面全部收紧", () => {
    const pi = resolveVendoredPi();
    const sentinelPath = join(mkdtempSync(join(tmpdir(), "relay-sentinel-")), "sentinel.txt");
    writeFileSync(sentinelPath, "TOP-SECRET-SENTINEL");
    const spec = prepareRunDirs(tmpdir(), "docker", {
      provider: "x", model: "x/m", apiKey: "x", baseUrl: "http://127.0.0.1:1/v1",
    });
    try {
      const out = execFileSync(
        "docker",
        [
          "run", "--rm",
          "--name", `relay-sbx-probe-${Date.now()}`,
          "--user", `${SANDBOX_UID}:${SANDBOX_UID}`,
          "--cap-drop", "ALL",
          "--network", "host",
          "-v", `${spec.workspaceDir}:/workspace`,
          "-v", `${spec.homeDir}:/pihome`,
          "-v", `${spec.runDir}/ext:/opt/relay/ext:ro`,
          "-v", `${join(pi.repoRoot, "node_modules")}:/opt/relay/node_modules:ro`,
          "-e", "HOME=/pihome", "-e", "TERM=dumb", "-e", "NO_COLOR=1",
          "-e", "RELAY_ALLOWED_ROOT=/workspace",
          "-w", "/workspace",
          SANDBOX_IMAGE,
          "/bin/sh", "-c",
          `
          echo "uid: $(id -u)"
          echo "caps-chown: $(chown root:root /workspace 2>&1 | head -1)"
          echo "sentinel: $(cat ${sentinelPath} 2>&1)"
          echo "host-home: $(ls /home/ubuntu 2>&1 | head -1)"
          echo "docker-sock: $(ls /var/run/docker.sock 2>&1)"
          echo "ssh-agent: \${SSH_AUTH_SOCK:-<unset>}"
          echo "gh-env: \${GH_TOKEN:-<unset>}/\${GITHUB_TOKEN:-<unset>}"
          echo "etc-write: $(touch /etc/pwned-probe 2>&1 | head -1)"
          echo "ws-write: $(touch /workspace/allowed.txt 2>&1 && echo OK)"
          echo "node-modules-write: $(touch /opt/relay/node_modules/should-fail 2>&1 | head -1)"
          echo "vendored-pkg: $(head -c 0 /opt/relay/node_modules/@earendil-works/pi-coding-agent/package.json 2>&1 && echo READABLE)"
          echo "pi-version: $(node /opt/relay/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --version 2>&1)"
          `,
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      const get = (k: string) => out.split("\n").find((l) => l.startsWith(`${k}:`))?.slice(k.length + 2).trim() ?? "";
      expect(get("uid")).toBe(String(SANDBOX_UID));
      expect(get("caps-chown")).toMatch(/Operation not permitted|not permitted/); // cap-drop 生效
      expect(get("sentinel")).toMatch(/No such file/); // 哨兵不在命名空间
      expect(get("host-home")).toMatch(/No such file/);
      expect(get("docker-sock")).toMatch(/No such file/);
      expect(get("ssh-agent")).toBe("<unset>");
      expect(get("gh-env")).toBe("<unset>/<unset>");
      expect(get("etc-write")).toMatch(/Permission denied|Read-only/);
      expect(get("ws-write")).toBe("OK"); // 工作区可写(正向对照)
      expect(get("node-modules-write")).toMatch(/Read-only|Permission denied/);
      expect(get("vendored-pkg")).toBe("READABLE");
      expect(get("pi-version")).toBe(RELAY_PI_VERSION); // 容器内 pi = vendored 锁定版本
    } finally {
      cleanupSandbox(spec);
    }
  });
});
