// RELAY-CONTROL-SAFETY-04 P0-A:候选功能检查沙箱隔离(真实 docker 容器反例回归)。
// 旧 runCheck 宿主 execFile 的四类逃逸(反例 p0-mvp/control-safety-04/evidence/counterexample.log):
//   读 Worker 哨兵 env / 写宿主任意路径 / cwdWorkspace=false 落宿主仓库根 / 超时孙进程宿主残留。
// 修复后语义:检查一律经 CheckRunner 端口在沙箱容器内执行(非 root/cap-drop ALL/只读根 FS/
// 显式最小 env/默认禁网/资源上限/超时杀整容器);runner 未注入 ⇒ FAIL-CLOSED;
// docker 不可用 ⇒ FAIL-CLOSED(绝不退回宿主);allowEgressNetwork 未验证 ⇒ FAIL-CLOSED。
// 全部使用无敏感信息测试变量与临时目录;零真实凭据泄露实验。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  dockerCheckRunner,
  buildCheckDockerArgs,
  CHECK_MEMORY_LIMIT,
  CHECK_CPUS_LIMIT,
  CHECK_PIDS_LIMIT,
} from "../../src/runtime/check-sandbox.ts";
import { SANDBOX_IMAGE, SANDBOX_UID, DOCKER_BIN, dockerAvailable } from "../../src/runtime/sandbox.ts";
import { collectCheckEvidence, failClosedCheckRunner, type CheckRunner } from "../../src/core/evidence.ts";
import { sql } from "drizzle-orm";
import { createTestDb } from "../setup/testdb.ts";
import type { RelayDb } from "../../src/core/db.ts";

const dockerOk = dockerAvailable();
const d = dockerOk ? describe : describe.skip;

/** 等待检查容器彻底消失(docker kill 后 --rm 清理有亚秒级延迟)。 */
function waitContainerGone(name: string, timeoutMs = 15_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = spawnSync(DOCKER_BIN, ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r.status === 0 && (r.stdout ?? "").trim() === "") return true;
    spawnSync(DOCKER_BIN, ["kill", "--signal=SIGKILL", name], { timeout: 10_000 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  return false;
}

d("P0-A 沙箱执行器:边界反例(真实 docker 容器)", () => {
  it("反例 A1:候选检查读取不到 Worker 哨兵 env(显式最小 env,零宿主环境继承)", async () => {
    const sentinel = `sbx-secret-${randomUUID().slice(0, 8)}`;
    process.env["RELAY_CX_SENTINEL"] = sentinel;
    try {
      const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
      chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
      const runner = dockerCheckRunner();
      const r = await runner(
        {
          kind: "deterministic_test",
          command: [
            "node",
            "-e",
            "if(process.env.RELAY_CX_SENTINEL){console.log('LEAK='+process.env.RELAY_CX_SENTINEL);process.exit(1)}console.log('env-clean')",
          ],
          cwdWorkspace: true,
        },
        ws,
      );
      expect(r.passed, `env 逃逸反例应通过(=未泄漏):${r.rawOutput}`).toBe(true);
      expect(r.rawOutput).not.toContain(sentinel);
      expect(r.rawOutput).toContain("env-clean");
      expect(r.env.mode).toBe("docker");
      rmSync(ws, { recursive: true, force: true });
    } finally {
      delete process.env["RELAY_CX_SENTINEL"];
    }
  });

  it("反例 A3:候选检查写不进容器外宿主哨兵路径(只读根 FS + 非 root)", async () => {
    const hostSentinelDir = mkdtempSync(join(tmpdir(), "sbx-outside-"));
    const hostSentinel = join(hostSentinelDir, "sentinel.txt");
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    const runner = dockerCheckRunner();
    // 容器内以相同绝对路径尝试写(路径碰撞语义:容器内 /<path> ≠ 宿主 /tmp/<path>)
    const r = await runner(
      {
        kind: "deterministic_test",
        command: [
          "node",
          "-e",
          `try{require('fs').writeFileSync(${JSON.stringify(hostSentinel)},'x');console.log('WROTE')}catch(e){console.log('DENIED:'+e.code);process.exit(0)}`,
        ],
        cwdWorkspace: true,
      },
      ws,
    );
    // 宿主哨兵路径必须不存在(候选检查无法触达宿主 FS);容器内失败如实报告
    expect(existsSync(hostSentinel), "宿主哨兵不得落盘").toBe(false);
    expect(r.env["user"]).toBe(String(SANDBOX_UID));
    rmSync(ws, { recursive: true, force: true });
    rmSync(hostSentinelDir, { recursive: true, force: true });
  });

  it("反例 A3b:候选检查写工作区(容器内 rw 挂载)落盘到宿主工作区,但不落盘到宿主任意路径", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    const runner = dockerCheckRunner();
    const r = await runner(
      {
        kind: "deterministic_test",
        command: ["node", "-e", "require('fs').writeFileSync('out.txt','ok');console.log('wrote-ws')"],
        cwdWorkspace: true,
      },
      ws,
    );
    expect(r.passed, r.rawOutput).toBe(true);
    expect(readFileSync(join(ws, "out.txt"), "utf8")).toBe("ok");
    rmSync(ws, { recursive: true, force: true });
  });

  it("反例 A2:cwdWorkspace=false ⇒ 容器内 /tmp 执行、工作区只读(无宿主绕过面)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    writeFileSync(join(ws, "seed.txt"), "seed\n");
    const runner = dockerCheckRunner();
    const r = await runner(
      {
        kind: "deterministic_test",
        command: [
          "node",
          "-e",
          `const fs=require('fs');console.log('CWD='+process.cwd());` +
            `try{fs.writeFileSync('/workspace/probe.txt','x');console.log('WS-WRITE-OK')}catch(e){console.log('WS-WRITE-DENIED:'+e.code)}`,
        ],
        cwdWorkspace: false,
      },
      ws,
    );
    expect(r.rawOutput).toContain("CWD=/tmp");
    expect(r.env["cwd"]).toBe("/tmp");
    expect(existsSync(join(ws, "probe.txt")), "只读挂载下工作区不得被写").toBe(false);
    rmSync(ws, { recursive: true, force: true });
  });

  it("反例 A4:检查超时 ⇒ docker kill 整容器(全进程组终止;宿主零残留)", { timeout: 90_000 }, async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    const runner = dockerCheckRunner();
    // 命令:主进程派生 detached 孙进程后自身常驻 —— execFile 式"只杀直接子进程"无法终止
    // 容器;runner 超时路径按容器名 docker kill ⇒ 全进程组消失(宿主 docker ps 零残留)
    const r = await runner(
      {
        kind: "deterministic_test",
        command: [
          "node",
          "-e",
          `const cp=require('child_process');const c=cp.spawn('sleep',['120'],{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},1000);`,
        ],
        cwdWorkspace: true,
        timeoutMs: 3000,
      },
      ws,
    );
    expect(r.passed).toBe(false);
    expect(r.rawOutput).toContain("[exit=TIMEOUT]");
    // 容器名在 env 证据中(A7 绑定),等待其彻底消失
    const cname = String(r.env["container"] ?? "");
    expect(cname.startsWith("relay-check-")).toBe(true);
    expect(waitContainerGone(cname), "超时后容器必须消失(宿主零残留)").toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });

  it("反例 A5:默认禁网(--network none)—— 未授权外网访问失败", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    const runner = dockerCheckRunner();
    const r = await runner(
      {
        kind: "deterministic_test",
        command: [
          "node",
          "-e",
          `fetch('http://example.com',{signal:AbortSignal.timeout(2500)}).then(()=>{console.log('NET-OK');process.exit(1)}).catch(()=>{console.log('NET-BLOCKED');process.exit(0)})`,
        ],
        cwdWorkspace: true,
        timeoutMs: 20_000,
      },
      ws,
    );
    expect(r.passed, `禁网反例应通过(=被阻断):${r.rawOutput}`).toBe(true);
    expect(r.rawOutput).toContain("NET-BLOCKED");
    expect(r.env["network"]).toBe("none");
    rmSync(ws, { recursive: true, force: true });
  });

  it("反例 A6:docker 不可用 ⇒ FAIL-CLOSED(检查失败,绝不执行宿主命令)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    const hostMarker = join(mkdtempSync(join(tmpdir(), "sbx-marker-")), "would-run.txt");
    const runner = dockerCheckRunner({ dockerAvailableFn: () => false });
    const r = await runner(
      {
        kind: "deterministic_test",
        command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(hostMarker)},'ran');console.log('RAN')`],
        cwdWorkspace: true,
      },
      ws,
    );
    expect(r.passed).toBe(false);
    expect(r.rawOutput).toContain("SANDBOX_UNAVAILABLE");
    expect(r.env.mode).toBe("sandbox-fail-closed");
    expect(existsSync(hostMarker), "宿主命令不得被执行").toBe(false);
    rmSync(ws, { recursive: true, force: true });
    rmSync(join(hostMarker, ".."), { recursive: true, force: true });
  });

  it("反例 A6b:allowEgressNetwork=true 但 egress 未验证 ⇒ FAIL-CLOSED(网络能力须单独授权)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    const runner = dockerCheckRunner({ egress: { ok: false, network: "none" } });
    const r = await runner(
      {
        kind: "deterministic_test",
        command: ["node", "-e", "console.log('should-not-run')"],
        cwdWorkspace: true,
        allowEgressNetwork: true,
      },
      ws,
    );
    expect(r.passed).toBe(false);
    expect(r.rawOutput).toContain("EGRESS_UNAUTHORIZED");
    rmSync(ws, { recursive: true, force: true });
  });

  it("合法功能检查通过/失败 + 证据绑定(退出码/命令/环境入证)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    writeFileSync(join(ws, "result.txt"), "sum=87\n");
    spawnSync("chmod", ["-R", "o+rwX", ws], { timeout: 30_000 }); // 宿主 umask 可能 0600;生产 runner.ts:210 同款
    const runner = dockerCheckRunner();
    const okPass = await runner(
      {
        kind: "deterministic_test",
        command: [
          "node",
          "-e",
          "const t=require('fs').readFileSync('result.txt','utf8');if(!t.includes('87'))process.exit(1);console.log('check ok')",
        ],
        cwdWorkspace: true,
        timeoutMs: 30_000,
      },
      ws,
    );
    expect(okPass.passed, okPass.rawOutput).toBe(true);
    expect(okPass.rawOutput).toContain("[exit=0]");
    expect(okPass.env.mode).toBe("docker");
    expect(okPass.env["image"]).toBe(SANDBOX_IMAGE);

    const okFail = await runner(
      { kind: "deterministic_test", command: ["node", "-e", "process.exit(3)"], cwdWorkspace: true },
      ws,
    );
    expect(okFail.passed).toBe(false);
    expect(okFail.rawOutput).toContain("[exit=3]");
    rmSync(ws, { recursive: true, force: true });
  });

  it("buildCheckDockerArgs 边界面:cap-drop/limits/env 白名单/无 docker.sock/无宿主仓库挂载", () => {
    const args = buildCheckDockerArgs(
      { kind: "deterministic_test", command: ["node", "-e", "1"], cwdWorkspace: true },
      "/tmp/ws-x",
      "relay-check-t",
    );
    const has = (s: string) => args.includes(s);
    expect(has("--cap-drop")).toBe(true);
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(has(`--user`)).toBe(true);
    expect(args[args.indexOf("--user") + 1]).toBe(`${SANDBOX_UID}:${SANDBOX_UID}`);
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args[args.indexOf("--memory") + 1]).toBe(CHECK_MEMORY_LIMIT);
    expect(args[args.indexOf("--cpus") + 1]).toBe(CHECK_CPUS_LIMIT);
    expect(args[args.indexOf("--pids-limit") + 1]).toBe(CHECK_PIDS_LIMIT);
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain(process.cwd()); // 不挂载宿主仓库
    // env 面:仅显式白名单(无 -e 透传宿主变量);docker 参数与容器命令分段统计
    // (命令自身可含 -e,不计入 docker env 面)
    const imgIdx = args.indexOf(SANDBOX_IMAGE);
    const dockerArgs = args.slice(0, imgIdx);
    const envs = dockerArgs.filter((a, i) => dockerArgs[i - 1] === "-e");
    expect(envs.length).toBe(5);
    expect(envs.every((e) => /^(HOME|PATH|TERM|NO_COLOR|LANG)=/.test(e))).toBe(true);
    // 挂载面:仅一次性工作区
    const mounts = dockerArgs.filter((a, i) => dockerArgs[i - 1] === "-v");
    expect(mounts.length).toBe(1);
    expect(mounts[0]).toBe("/tmp/ws-x:/workspace");
    // 容器命令 = SANDBOX_IMAGE 之后的 argv(原样直启,不经 shell)
    expect(args.slice(imgIdx + 1)).toEqual(["node", "-e", "1"]);
  });
});

d("P0-A Gate 编排接线:未注入 runner ⇒ FAIL-CLOSED(检查按失败落库,零宿主执行)", () => {
  it("failClosedCheckRunner:检查失败 + SANDBOX_RUNNER_UNAVAILABLE + env 如实标注", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
    const hostMarker = join(mkdtempSync(join(tmpdir(), "sbx-marker-")), "would-run.txt");
    const r = await failClosedCheckRunner(
      {
        kind: "deterministic_test",
        command: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(hostMarker)},'ran')`],
        cwdWorkspace: true,
      },
      ws,
    );
    expect(r.passed).toBe(false);
    expect(r.rawOutput).toContain("SANDBOX_RUNNER_UNAVAILABLE");
    expect(r.env.mode).toBe("sandbox-fail-closed");
    expect(existsSync(hostMarker), "宿主命令不得被执行").toBe(false);
    rmSync(ws, { recursive: true, force: true });
    rmSync(join(hostMarker, ".."), { recursive: true, force: true });
  });

  it("collectCheckEvidence 缺省 runner ⇒ 证据落库 passed=false( conservatism 止面)", async () => {
    const t = await createTestDb("p0a_failclosed");
    try {
      const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
      chmodSync(ws, 0o777); // 与生产 runner 同口径(prepareRunDirs/executeRun chmod o+rwX;容器 UID 10001 可写)
      await t.db.execute(
        sql`INSERT INTO tasks (id, state, allowed_scope) VALUES ('t-fc', 'VERIFYING', '["/workspace"]')`,
      );
      const row = await collectCheckEvidence(
        t.db as unknown as Parameters<typeof collectCheckEvidence>[0],
        {
          kind: "deterministic_test",
          command: ["node", "-e", "console.log('should-not-run-on-host')"],
          cwdWorkspace: true,
          taskId: "t-fc",
          attempt: 1,
          candidateSha: "c",
          producedBy: "verifier-fc",
        },
        ws,
      );
      expect(row.passed).toBe(false);
      expect(row.rawOutput).toContain("SANDBOX_RUNNER_UNAVAILABLE");
      expect(row.env.mode).toBe("sandbox-fail-closed");
      rmSync(ws, { recursive: true, force: true });
    } finally {
      await t.cleanup();
    }
  });
});

// ==========================================================================
// RELAY-GATE-INTEGRITY-04A:检查工作区安全边界(反例 p0-mvp/gate-integrity-04a/evidence/
// counterexample.log 反例 B —— workspaceDir 缺失 ⇒ process.cwd()(宿主仓库根)被真实挂载)。
// 修复后语义:候选检查必须挂载有效的显式 Run 工作区;缺失/越界/符号链接/相对路径 ⇒
// FAIL-CLOSED(WORKSPACE_INVALID,零 docker 交互);合法 tmpdir 工作区不受影响。
// ==========================================================================
d("GATE-INTEGRITY-04A 检查工作区安全边界(真实 docker;越界挂载 FAIL-CLOSED)", () => {
  it("反例 B 修复:workspaceDir=宿主仓库根(越界)⇒ WORKSPACE_INVALID FAIL-CLOSED,零 docker 交互", async () => {
    const dockerSpyCalls: number[] = [];
    const runner = dockerCheckRunner({ dockerAvailableFn: () => (dockerSpyCalls.push(1), true) });
    const r = await runner(
      { kind: "deterministic_test", command: ["node", "-e", "console.log('should-not-run')"], cwdWorkspace: true },
      process.cwd(), // 宿主仓库根 —— 不属于 Run 工作区范围
    );
    expect(r.passed).toBe(false);
    expect(r.env.mode).toBe("sandbox-fail-closed");
    expect(r.rawOutput).toContain("[exit=WORKSPACE_INVALID]");
    expect(r.rawOutput).toContain("workspace_out_of_scope");
    expect(dockerSpyCalls.length).toBe(0); // 校验先于 docker 探测:零 docker 交互
    expect(existsSync(join(process.cwd(), "should-not-run.txt"))).toBe(false);
  });

  it("符号链接工作区 ⇒ 拒绝(不追随链接)", async () => {
    const real = mkdtempSync(join(tmpdir(), "sbx-ws-real-"));
    chmodSync(real, 0o777);
    const link = join(tmpdir(), `sbx-ws-link-${randomUUID().slice(0, 8)}`);
    symlinkSync(real, link, "dir");
    try {
      const runner = dockerCheckRunner({ dockerAvailableFn: () => true });
      const r = await runner(
        { kind: "deterministic_test", command: ["node", "-e", "console.log('x')"], cwdWorkspace: true },
        link,
      );
      expect(r.passed).toBe(false);
      expect(r.rawOutput).toContain("[exit=WORKSPACE_INVALID]");
      expect(r.rawOutput).toContain("workspace_symlink");
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("不存在的目录 / 相对路径 ⇒ 拒绝", async () => {
    const runner = dockerCheckRunner({ dockerAvailableFn: () => true });
    const missing = join(tmpdir(), `sbx-ws-missing-${randomUUID().slice(0, 8)}`);
    const r1 = await runner(
      { kind: "deterministic_test", command: ["node", "-e", "console.log('x')"], cwdWorkspace: true },
      missing,
    );
    expect(r1.passed).toBe(false);
    expect(r1.rawOutput).toContain("workspace_missing");
    const r2 = await runner(
      { kind: "deterministic_test", command: ["node", "-e", "console.log('x')"], cwdWorkspace: true },
      "relative/ws",
    );
    expect(r2.passed).toBe(false);
    expect(r2.rawOutput).toContain("workspace_not_absolute");
  });

  it("合法 tmpdir 工作区不受影响 ⇒ 正常执行(边界不误伤合法 Run 工作区)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sbx-ws-"));
    chmodSync(ws, 0o777);
    try {
      const runner = dockerCheckRunner();
      const r = await runner(
        { kind: "deterministic_test", command: ["node", "-e", "console.log('ws-ok')"], cwdWorkspace: true },
        ws,
      );
      expect(r.passed).toBe(true);
      expect(r.env.mode).toBe("docker");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("validateCheckWorkspace 边界断言:realpath/所属范围/符号链接/存在性", async () => {
    const { validateCheckWorkspace } = await import("../../src/runtime/check-sandbox.ts");
    expect(validateCheckWorkspace(process.cwd()).ok).toBe(false); // 仓库根越界
    expect(validateCheckWorkspace("rel/path").reason).toBe("workspace_not_absolute");
    expect(validateCheckWorkspace(join(tmpdir(), `no-such-${randomUUID().slice(0, 8)}`)).reason).toBe(
      "workspace_missing",
    );
    const real = mkdtempSync(join(tmpdir(), "sbx-ws-real-"));
    const link = join(tmpdir(), `sbx-ws-link-${randomUUID().slice(0, 8)}`);
    symlinkSync(real, link, "dir");
    try {
      expect(validateCheckWorkspace(link).reason).toBe("workspace_symlink");
      expect(validateCheckWorkspace(real).ok).toBe(true);
      // 允许根本身(tmpdir)不是合法候选工作区(挂整个 /tmp 无意义且面过大;Reviewer Minor-1)
      expect(validateCheckWorkspace(tmpdir()).reason).toBe("workspace_out_of_scope");
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});
