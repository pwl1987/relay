// 候选功能检查沙箱执行器(RELAY-CONTROL-SAFETY-04 P0-A)。
// 复用 Run 沙箱同款边界(ADR-0003 双层边界;sandbox.ts 设施),候选代码/脚本/包脚本
// **绝不以 Worker 宿主权限执行**(反例实证:p0-mvp/control-safety-04/evidence/ ——
// 旧 runCheck 宿主 execFile 可读 Worker 哨兵 env/写宿主任意路径/cwdWorkspace=false 落宿主仓库根/
// 超时孙进程残留宿主)。
// 执行面保证(合同 A4):
//   - 非 root(UID 10001)且回落零特权;--cap-drop ALL + no-new-privileges;
//   - 只读根文件系统;一次性 tmpfs /tmp(128MB)为唯一系统可写面;
//   - 显式最小 env 白名单(PATH/HOME/TERM/NO_COLOR/LANG)—— 零宿主凭据、模型密钥、
//     服务环境变量透传(不继承 Worker 进程环境);
//   - 不挂载 docker.sock;仅挂载一次性 Run 工作区(cwdWorkspace=true 为 rw,false 为 :ro
//     + cwd=/tmp —— 任意 argv/脚本间接调用一律容器内执行,无宿主绕过面,合同 A5);
//   - 默认 --network none;allowEgressNetwork=true 须 egress 白名单已验证
//     (未验证 ⇒ FAIL-CLOSED,网络能力必须单独授权);
//   - CPU/内存/进程数上限 + timeoutMs 上限(worker-entry 校验 1s~600s);
//   - 超时或 abortSignal 翻转 ⇒ docker kill 整容器(全进程组,含孙进程;A4)。
// 沙箱不可用 ⇒ FAIL-CLOSED:检查按失败处理,**绝不退回宿主执行**(A6)。
// 证据绑定(A7):env 如实记录 mode/image/user/network/limits/container;rawOutput 含命令原文
// 与退出码(TIMEOUT/SANDBOX_UNAVAILABLE/EGRESS_UNAUTHORIZED 同为失败退出语义);A8 Gate 标准不变。
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DOCKER_BIN, SANDBOX_IMAGE, SANDBOX_UID, dockerAvailable } from "./sandbox.ts";
import { EGRESS_NETWORK, verifyEgressRules, type EgressStatus } from "./egress.ts";
import { workerEnv, type CheckRunner, type CheckSpec } from "../core/evidence.ts";

/** 检查容器资源上限(确定性常量;上限语义,A4)。 */
export const CHECK_MEMORY_LIMIT = "512m";
export const CHECK_CPUS_LIMIT = "1.0";
export const CHECK_PIDS_LIMIT = "128";
/** 一次性 /tmp(tmpfs;根文件系统只读时的唯一系统可写面)。 */
export const CHECK_TMPFS_SPEC = "/tmp:rw,size=134217728,mode=1777";
/** 检查容器内固定挂载点与 cwd。 */
export const CHECK_WORKSPACE_MOUNT = "/workspace";
export const CHECK_TMP_CWD = "/tmp";

/** docker run argv(与执行器同源;导出仅供测试断言边界/挂载/env 面,如 P0-A 反例回归)。 */
export function buildCheckDockerArgs(
  spec: CheckSpec,
  workspaceDir: string,
  containerName: string,
  egressNetwork?: string,
): string[] {
  const cwdWorkspace = spec.cwdWorkspace !== false; // 缺省 true(worker-entry 校验同口径)
  const useEgress = spec.allowEgressNetwork === true && egressNetwork !== undefined;
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--user",
    `${SANDBOX_UID}:${SANDBOX_UID}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    CHECK_TMPFS_SPEC,
    "--memory",
    CHECK_MEMORY_LIMIT,
    "--cpus",
    CHECK_CPUS_LIMIT,
    "--pids-limit",
    CHECK_PIDS_LIMIT,
    "--network",
    useEgress ? egressNetwork! : "none",
    "-v",
    `${workspaceDir}:${CHECK_WORKSPACE_MOUNT}${cwdWorkspace ? "" : ":ro"}`,
    "-e",
    "HOME=/tmp",
    "-e",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "-e",
    "TERM=dumb",
    "-e",
    "NO_COLOR=1",
    "-e",
    "LANG=C.UTF-8",
    "-w",
    cwdWorkspace ? CHECK_WORKSPACE_MOUNT : CHECK_TMP_CWD,
    SANDBOX_IMAGE,
    ...spec.command,
  ];
}

/** docker kill(docker client 死掉不等于容器死掉;按容器名终止整进程组)。 */
function killContainer(containerName: string): void {
  try {
    execFileSync(DOCKER_BIN, ["kill", "--signal=SIGKILL", containerName], { timeout: 15_000 });
  } catch {
    /* 容器已退出/已删除 ⇒ 无需终止 */
  }
}

export interface DockerCheckRunnerOptions {
  /** egress 状态(allowEgressNetwork=true 时必需且须验证通过;P0-A A4) */
  egress?: EgressStatus;
  /** docker 探测注入口(测试模拟不可用;缺省 = 真实探测) */
  dockerAvailableFn?: () => boolean;
}

/** 生产候选功能检查执行器:docker 沙箱(边界见文件头;FAIL-CLOSED 不退回宿主)。 */
export function dockerCheckRunner(options: DockerCheckRunnerOptions = {}): CheckRunner {
  const dockerOk = options.dockerAvailableFn ?? dockerAvailable;
  return async (spec, workspaceDir, opts = {}) => {
    const containerName = `relay-check-${randomUUID().slice(0, 12)}`;
    const envBase = {
      command: spec.command.join(" "),
      image: SANDBOX_IMAGE,
      user: String(SANDBOX_UID),
      network: spec.allowEgressNetwork === true ? EGRESS_NETWORK : "none",
      cwd: spec.cwdWorkspace === false ? CHECK_TMP_CWD : CHECK_WORKSPACE_MOUNT,
      memory: CHECK_MEMORY_LIMIT,
      cpus: CHECK_CPUS_LIMIT,
      pidsLimit: CHECK_PIDS_LIMIT,
      container: containerName,
    };

    // A6:沙箱不可用 ⇒ FAIL-CLOSED(检查失败,不退回宿主执行)
    if (!dockerOk()) {
      return {
        passed: false,
        rawOutput: [
          `$ ${spec.command.join(" ")}`,
          "[exit=SANDBOX_UNAVAILABLE] docker 不可用:候选功能检查 FAIL-CLOSED,未执行任何宿主命令" +
            "(不退回宿主执行;RELAY-CONTROL-SAFETY-04 P0-A)",
        ].join("\n"),
        env: workerEnv("sandbox-fail-closed", envBase),
      };
    }

    // A4:网络能力单独授权 —— allowEgressNetwork=true 但 egress 白名单未验证 ⇒ FAIL-CLOSED
    if (spec.allowEgressNetwork === true) {
      const eg = options.egress;
      if (
        !eg?.ok ||
        !eg.subnet ||
        !eg.hostIp ||
        !eg.modelPort ||
        !verifyEgressRules(eg.subnet, eg.hostIp, eg.modelPort)
      ) {
        return {
          passed: false,
          rawOutput: [
            `$ ${spec.command.join(" ")}`,
            "[exit=EGRESS_UNAUTHORIZED] allowEgressNetwork=true 但 egress 白名单未建立/验证失败 ⇒ FAIL-CLOSED" +
              "(网络能力须单独授权;未执行任何命令)",
          ].join("\n"),
          env: workerEnv("sandbox-fail-closed", envBase),
        };
      }
    }

    const argv = buildCheckDockerArgs(spec, workspaceDir, containerName, options.egress ? EGRESS_NETWORK : undefined);
    const timeoutMs = spec.timeoutMs ?? 60_000;
    const abortSignal = opts.abortSignal;
    let abortTimer: ReturnType<typeof setInterval> | null = null;
    if (abortSignal) {
      // A4:abort 翻转 ⇒ 终止整个执行进程组(容器级;含孙进程)
      abortTimer = setInterval(() => {
        if (abortSignal.cancelled) killContainer(containerName);
      }, 500);
    }
    return await new Promise((resolve) => {
      execFile(
        DOCKER_BIN,
        argv,
        { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          if (abortTimer) clearInterval(abortTimer);
          const rawOutput = [`$ ${spec.command.join(" ")}`, stdout ?? "", stderr ?? ""].join("\n").trimEnd();
          if (err) {
            const killed = (err as { killed?: boolean }).killed === true;
            const enobufs = (err as { code?: unknown }).code === "ENOBUFS";
            if (killed) {
              // 超时/输出溢出:docker client 被杀 ≠ 容器被杀 ⇒ 按容器名终止整进程组(幂等)
              killContainer(containerName);
            }
            const marker = abortSignal?.cancelled
              ? "ABORTED"
              : enobufs
                ? "OUTPUT_OVERFLOW" // Reviewer Minor-5:输出超 maxBuffer ≠ 超时;结果安全(失败),标记如实
                : killed
                  ? "TIMEOUT"
                  : String((err as { code?: unknown }).code ?? "nonzero");
            resolve({
              passed: false,
              rawOutput: `${rawOutput}\n[exit=${marker}]`,
              env: workerEnv("docker", envBase),
            });
            return;
          }
          const containsOk = spec.expectOutputContains ? rawOutput.includes(spec.expectOutputContains) : true;
          resolve({
            passed: containsOk,
            rawOutput: `${rawOutput}\n[exit=0]`,
            env: workerEnv("docker", envBase),
          });
        },
      );
    });
  };
}
