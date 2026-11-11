// P0-02B G-4:Reviewer 对候选工作区的 FS 级只读挂载(docker 实测;缺 docker/镜像显式 skip)。
// 反例 7:Reviewer 尝试修改候选文件,必须在 OS 层被拒绝。
// 两层证明:
//  a) 接线:buildDockerRunArgs(workspaceReadOnly:true) ⇒ /workspace:ro + 工具审计移出候选面(/pihome);
//  b) OS 语义:与 Reviewer 容器同款约束(--user 10001 --cap-drop ALL :ro 挂载)下,
//     读候选成功、写/删/替换失败(EROFS);对照组(无 :ro)写成功 —— 证明拒绝来自只读挂载本身。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { markTemp, safeRm, RUN_SENTINEL } from "../../src/runtime/safe-rm.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SANDBOX_IMAGE,
  SANDBOX_UID,
  dockerAvailable,
  prepareRunDirs,
  buildDockerRunArgs,
  buildPiArgs,
} from "../../src/runtime/sandbox.ts";
import { resolveVendoredPi } from "../../src/runtime/pi-version.ts";

function imagePresent(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", SANDBOX_IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerOk = dockerAvailable();
const hasImage = dockerOk && imagePresent();

describe.skipIf(!dockerOk || !hasImage)("P0-02B G-4:Reviewer 候选面 FS 级只读挂载(容器实测)", () => {
  const pi = resolveVendoredPi();
  const MODEL = { provider: "x", model: "x/m", apiKey: "x", baseUrl: "http://127.0.0.1:1/v1" };

  it("接线:workspaceReadOnly ⇒ /workspace:ro 且工具审计移出候选面;默认路径保持 rw", () => {
    const spec = prepareRunDirs(tmpdir(), "docker", MODEL);
    try {
      const argsRo = buildDockerRunArgs(spec, pi, {
        piArgs: buildPiArgs(MODEL, "/opt/relay/ext/x.ts"),
        containerCli: "/opt/relay/node_modules/x/cli.js",
        allowedCommands: [],
        workspaceReadOnly: true,
      });
      expect(argsRo).toContain(`${spec.workspaceDir}:/workspace:ro`);
      expect(argsRo.join(" ")).toContain("RELAY_TOOL_AUDIT=/pihome/tool-audit.jsonl");
      expect(argsRo.join(" ")).not.toContain("RELAY_TOOL_AUDIT=/workspace/.relay");

      const argsRw = buildDockerRunArgs(spec, pi, {
        piArgs: buildPiArgs(MODEL, "/opt/relay/ext/x.ts"),
        containerCli: "/opt/relay/node_modules/x/cli.js",
        allowedCommands: ["echo"],
      });
      expect(argsRw).toContain(`${spec.workspaceDir}:/workspace`); // 无 :ro
      expect(argsRw.join(" ")).toContain("RELAY_TOOL_AUDIT=/workspace/.relay/tool-audit.jsonl");
    } finally {
      safeRm(spec.runDir, { roots: [spec.runDir], sentinel: RUN_SENTINEL });
    }
  });

  it("OS 层证据:Reviewer 同款约束下读候选成功;写/删/替换被内核拒绝(EROFS);对照组(rw)写成功", () => {
    // 候选面:模 Coder 产出(runner 同款权限面:chmod -R o+rwX;容器 UID 可写由 rw 对照组证明)
    const ws = markTemp(mkdtempSync(join(tmpdir(), "relay-ro-cand-")));
    writeFileSync(join(ws, "candidate.txt"), "candidate content\n", "utf8");
    execFileSync("chmod", ["-R", "a+rwX", ws], { timeout: 10_000 });
    const base = [
      "run", "--rm",
      "--user", `${SANDBOX_UID}:${SANDBOX_UID}`,
      "--cap-drop", "ALL",
      "-v", `${ws}:/workspace`,
      "-w", "/workspace",
      SANDBOX_IMAGE,
      "node", "-e",
    ];
    const tryIt = (mountRo: boolean, script: string): string => {
      const argv = [...base];
      if (mountRo) argv[argv.indexOf("-v") + 1] = `${ws}:/workspace:ro`;
      argv.push(script);
      return execFileSync("docker", argv, { encoding: "utf8", timeout: 60_000 }).trim();
    };
    try {
      // 只读挂载:读 OK;写/删/替换全部 EROFS(OS 层拒绝,非策略层)
      expect(tryIt(true, `console.log("READ:" + require("fs").readFileSync("/workspace/candidate.txt","utf8").trim())`)).toBe("READ:candidate content");
      const writeOut = (() => {
        try {
          return tryIt(true, `require("fs").writeFileSync("/workspace/attack.txt","x"); console.log("WRITE-OK")`);
        } catch (err) {
          return `WRITE-DENIED:${(err as { stderr?: Buffer }).stderr?.toString() ?? ""}+exit=${(err as { status?: number }).status}`;
        }
      })();
      expect(writeOut).toMatch(/WRITE-DENIED|EROFS|Read-only/);
      expect(writeOut).not.toContain("WRITE-OK");
      expect(existsInHost(ws, "attack.txt")).toBe(false); // 宿主侧确认零写入

      const rmOut = (() => {
        try {
          return tryIt(true, `require("fs").unlinkSync("/workspace/candidate.txt"); console.log("RM-OK")`);
        } catch (err) {
          return `RM-DENIED:${(err as { stderr?: Buffer }).stderr?.toString() ?? ""}`;
        }
      })();
      expect(rmOut).not.toContain("RM-OK");
      expect(readFileSync(join(ws, "candidate.txt"), "utf8")).toContain("candidate content"); // 候选原样

      // 对照组(同约束、无 :ro):写成功 ⇒ 上面的拒绝确由只读挂载产生
      expect(tryIt(false, `require("fs").writeFileSync("/workspace/attack.txt","x"); console.log("WRITE-OK")`)).toBe("WRITE-OK");
    } finally {
      safeRm(ws, { roots: [ws], sentinel: RUN_SENTINEL });
    }
  });
});

function existsInHost(dir: string, name: string): boolean {
  try {
    execFileSync("ls", [join(dir, name)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
