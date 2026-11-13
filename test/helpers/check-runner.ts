// 仅测试检查执行器(RELAY-CONTROL-SAFETY-04 P0-A):宿主 execFile 已从生产 evidence 路径移除。
// 本 helper 供既有测试**显式注入**确定性 stub(与 reviewRun/argvOverride 注入同模式);
// 生产路径 = src/runtime/check-sandbox.ts dockerCheckRunner(沙箱边界由
// test/integration/check-sandbox-isolation.test.ts 以真实 docker 容器反例验证)。
// 行为=原 runCheck 宿主语义(测试夹具命令本身即测试系统的一部分,非候选代码)。
import { execFile } from "node:child_process";
import process from "node:process";
import type { CheckRunner } from "../../src/core/evidence.ts";

export const hostTestCheckRunner: CheckRunner = (spec, workspaceDir, opts = {}) => {
  const cwd = spec.cwdWorkspace === false ? process.cwd() : workspaceDir;
  const env = {
    mode: "host-test",
    node: process.version,
    host: "test-runner",
    command: spec.command.join(" "),
  };
  return new Promise((resolve) => {
    const child = execFile(
      spec.command[0]!,
      [...spec.command.slice(1)],
      { cwd, timeout: spec.timeoutMs ?? 60_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const rawOutput = [`$ ${spec.command.join(" ")}`, stdout ?? "", stderr ?? ""].join("\n").trimEnd();
        if (err) {
          const timedOut = (err as { killed?: boolean }).killed === true;
          resolve({
            passed: false,
            rawOutput: `${rawOutput}\n[exit=${timedOut || opts.abortSignal?.cancelled ? (opts.abortSignal?.cancelled ? "ABORTED" : "TIMEOUT") : String((err as { code?: unknown }).code ?? "nonzero")}]`,
            env,
          });
          return;
        }
        const containsOk = spec.expectOutputContains ? rawOutput.includes(spec.expectOutputContains) : true;
        resolve({ passed: containsOk, rawOutput, env });
      },
    );
    // abort 旗标(与生产 runner 同语义:翻转 ⇒ 终止;测试面尽力而为)
    if (opts.abortSignal) {
      const t = setInterval(() => {
        if (opts.abortSignal!.cancelled) child.kill("SIGKILL");
      }, 250);
      child.on("close", () => clearInterval(t));
    }
  });
};
