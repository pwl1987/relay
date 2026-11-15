// RELAY-DEPLOY-REHEARSAL-08R:一次性 PG 容器回环绑定安全启动/校验(deploy-rehearsal E2E 专用 seam)。
// 背景(合同 Major-S1,COORDINATOR-REVIEW-08-20261115.md):旧实现 `docker run -P` 将
// postgres:17-alpine 的 5432 发布到宿主随机端口;VM80 bridge host_binding_ipv4=0.0.0.0
// ⇒ 潜在非本机接口暴露(测试客户端连 127.0.0.1 不改变容器绑定面)。
// 修复语义(合同 C):
//   - 启动实参显式发布 `-p 127.0.0.1::5432`(宿主 IP 钉死回环、宿主端口位留空 ⇒ Docker
//     分配随机宿主端口),绝无 -P/--publish-all/host 网络;
//   - `docker inspect` NetworkSettings.Ports 严格校验:恰好一条 127.0.0.1:非空数字端口 映射,
//     且无任何其他端口暴露(其余端口键绑定必须为 null/空=未发布);
//   - 任一不满足 ⇒ fail-closed:按本容器唯一 nonce 名销毁后抛错,绝不触碰其他容器/网络;
//   - 纯模拟红绿证据见 test/unit/d08-ephemeral-pg.test.ts(红态日志 red-phase-08r-*.log);
//     真实 Docker 回环验证=隔离 E2E(合同 D)。
import { execFileSync } from "node:child_process";

export const LOOPBACK = "127.0.0.1";
const PG_IMAGE = "postgres:17-alpine";

export type DockerRunner = (args: string[], opts?: { timeout?: number }) => string;

const realDocker: DockerRunner = (args, opts) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: opts?.timeout ?? 120_000 });

/** 一次性 PG 启动实参:与旧形(395091f)唯一差异 = `-P` → 显式 `-p 127.0.0.1::5432`。 */
export function buildEphemeralPgRunArgs(container: string, password: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=relayd08",
    // 显式回环发布:宿主 IP 钉死 127.0.0.1、宿主端口位留空 ⇒ Docker 分配随机宿主端口;
    // 不使用 -P/--publish-all(默认 wildcard 0.0.0.0)与 host 网络(修复 Major-S1)。
    "-p",
    `${LOOPBACK}::5432`,
    PG_IMAGE,
  ];
}

export interface LoopbackMapping {
  hostIp: string;
  hostPort: string;
}

function refuse(reason: string): never {
  throw new Error(`端口映射校验拒绝:${reason}(fail-closed;仅接受恰好一条 127.0.0.1:非空数字端口 映射且无其他暴露)`);
}

/** 严格校验 docker inspect 的 NetworkSettings.Ports JSON:恰好一条 127.0.0.1:非空数字端口 的
 *  5432 映射,且无任何其他端口暴露(其余端口键绑定必须为 null/空=未发布)。任一不满足即抛错。 */
export function parseLoopbackPortMapping(raw: string): LoopbackMapping {
  let ports: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not-an-object");
    ports = parsed as Record<string, unknown>;
  } catch {
    return refuse(`inspect 输出非 JSON 对象(实际=${raw.slice(0, 120)})`);
  }
  const fiveRaw = ports["5432/tcp"];
  if (!Array.isArray(fiveRaw) || fiveRaw.length === 0) refuse("5432/tcp 未发布(无宿主映射)");
  if (fiveRaw.length !== 1) refuse(`5432/tcp 映射数=${fiveRaw.length}(要求恰好一条)`);
  const b = fiveRaw[0] as { HostIp?: unknown; HostPort?: unknown } | null | undefined;
  if (!b || typeof b !== "object") refuse("5432/tcp 绑定缺失");
  const hostIp = b.HostIp;
  const hostPort = b.HostPort;
  if (typeof hostIp !== "string" || hostIp.trim() === "") refuse(`HostIp 缺失或为空(实际=${String(hostIp)})`);
  if (hostIp !== LOOPBACK) refuse(`HostIp 非回环(实际="${hostIp}";仅接受 ${LOOPBACK})`);
  if (typeof hostPort !== "string" || !/^\d+$/.test(hostPort) || Number(hostPort) < 1 || Number(hostPort) > 65535)
    refuse(`HostPort 非法(实际="${String(hostPort)}")`);
  for (const [key, val] of Object.entries(ports)) {
    if (key === "5432/tcp") continue;
    if (Array.isArray(val) && val.length > 0) refuse(`存在其他发布端口:${key}(无其他暴露才允许)`);
  }
  return { hostIp, hostPort };
}

/** 真实 docker inspect 提取 + 严格校验;inspect 失败同样 fail-closed。 */
export function resolveLoopbackPortMapping(container: string, runDocker: DockerRunner): LoopbackMapping {
  let raw: string;
  try {
    raw = runDocker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container], { timeout: 30_000 });
  } catch (err) {
    return refuse(`docker inspect 失败:${err instanceof Error ? err.message : String(err)}`);
  }
  return parseLoopbackPortMapping(raw);
}

/** 销毁一次性容器(尽力而为;原错误优先,容器可能已退出)。 */
export function destroyEphemeralPg(container: string, runDocker: DockerRunner): void {
  try {
    runDocker(["rm", "-f", container], { timeout: 60_000 });
  } catch {
    /* 容器可能已退出/不存在;销毁尽力而为,不掩盖原错误 */
  }
}

/** 启动一次性 PG 并验证回环绑定;校验不通过 ⇒ 销毁本容器(唯一 nonce 名)后抛错。 */
export function startEphemeralPg(opts: {
  container: string;
  password: string;
  runDocker?: DockerRunner;
}): LoopbackMapping {
  const { container, password } = opts;
  const runDocker = opts.runDocker ?? realDocker;
  try {
    runDocker(buildEphemeralPgRunArgs(container, password));
  } catch (err) {
    throw new Error(`一次性 PG 容器启动失败(未创建映射,不做销毁):${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return resolveLoopbackPortMapping(container, runDocker);
  } catch (err) {
    destroyEphemeralPg(container, runDocker);
    throw new Error(
      `一次性 PG 容器 ${container} 回环绑定校验未通过,已销毁本容器:${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
