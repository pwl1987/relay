// RELAY-DEPLOY-REHEARSAL-08R:一次性 PG 容器回环绑定安全(纯模拟;零 docker 零 PG 零网络)。
// 合同 B:argv 捕获证明旧 -P 未限制 HostIp(红态);合同 C:显式 -p 127.0.0.1::5432 +
// docker inspect NetworkSettings.Ports 严格校验 —— 恰好一条 127.0.0.1:非空数字端口 映射
// 且无其他任何端口暴露;HostIp 缺失/空/非回环(0.0.0.0、::、::1、外部地址)、多条映射、
// 5432 未发布、inspect 失败/非 JSON 一律 fail-closed;拒绝时按本容器唯一 nonce 安全销毁,
// 绝不触碰其他容器。本文件不启动任何真实容器 —— 真实 Docker 回环验证由隔离 E2E 与
// LAN 探针证据承担(合同 D)。
import { describe, expect, it } from "vitest";
import {
  buildEphemeralPgRunArgs,
  parseLoopbackPortMapping,
  startEphemeralPg,
} from "../integration/d08-ephemeral-pg.ts";

const GOOD_INSPECT = `{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"34567"}]}`;

interface SimScript {
  runThrows?: Error;
  inspectThrows?: Error;
  inspectJson?: string;
}
function fakeDocker(script: SimScript) {
  const calls: string[][] = [];
  const runner = (args: string[]): string => {
    calls.push([...args]);
    const op = args[0];
    if (op === "run") {
      if (script.runThrows) throw script.runThrows;
      return "sim-container-id";
    }
    if (op === "inspect") {
      if (script.inspectThrows) throw script.inspectThrows;
      return script.inspectJson ?? "";
    }
    if (op === "rm") return args[args.length - 1] ?? "";
    throw new Error(`sim: unsupported docker op ${String(op)}`);
  };
  return { calls, runner };
}

describe("RELAY-DEPLOY-REHEARSAL-08R:一次性 PG 回环绑定安全(argv 捕获+inspect 校验,纯模拟)", () => {
  describe("启动实参(argv 捕获 seam;红态=旧 -P 实参)", () => {
    it("实参显式回环发布 -p 127.0.0.1::5432;绝无 -P/--publish-all/host 网络", () => {
      const args = buildEphemeralPgRunArgs("relay-test-d08-abc", "pw-d08");
      const i = args.indexOf("-p");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(args[i + 1]).toBe("127.0.0.1::5432");
      expect(args).not.toContain("-P");
      expect(args).not.toContain("--publish-all");
      expect(args).not.toContain("--network-host");
      expect(args.join(" ")).not.toMatch(/--network[= ]host|--net[= ]host/);
    });

    it("宿主端口位为空 ⇒ Docker 分配随机宿主端口;口令仅经 -e 传递,不经发布参数泄露", () => {
      const args = buildEphemeralPgRunArgs("relay-test-d08-abc", "pw-d08-secret");
      const i = args.indexOf("-p");
      const spec = args[i + 1]!;
      const [hostIp, hostPort, containerPort] = spec.split(":");
      expect(hostIp).toBe("127.0.0.1");
      expect(hostPort).toBe(""); // 空 ⇒ 随机宿主端口(不写死)
      expect(containerPort).toBe("5432");
      const ei = args.indexOf("-e");
      expect(args[ei + 1]).toBe("POSTGRES_PASSWORD=pw-d08-secret");
      expect(spec).not.toContain("pw-d08-secret");
    });

    it("容器名与镜像在实参中(一次性 relay-test-d08-* nonce sentinel 保持)", () => {
      const args = buildEphemeralPgRunArgs("relay-test-d08-abc", "pw");
      expect(args).toContain("relay-test-d08-abc");
      expect(args[args.length - 1]).toBe("postgres:17-alpine");
    });
  });

  describe("NetworkSettings.Ports 严格校验(fail-closed 矩阵)", () => {
    it("合法:恰好一条 127.0.0.1+非空数字端口 ⇒ 通过并返回映射", () => {
      expect(parseLoopbackPortMapping(GOOD_INSPECT)).toEqual({ hostIp: "127.0.0.1", hostPort: "34567" });
    });

    it("HostIp 缺失/空 ⇒ 拒绝(不明确 HostIp 不可放行)", () => {
      expect(() => parseLoopbackPortMapping(`{"5432/tcp":[{"HostPort":"34567"}]}`)).toThrow(/HostIp/);
      expect(() => parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"","HostPort":"34567"}]}`)).toThrow(/HostIp/);
    });

    it("非回环 HostIp(0.0.0.0 / :: / ::1 / 外部地址)⇒ 一律拒绝", () => {
      for (const ip of ["0.0.0.0", "::", "::1", "10.30.5.80", "192.0.2.1"]) {
        expect(() => parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"${ip}","HostPort":"34567"}]}`)).toThrow(
          new RegExp(ip.replaceAll(".", "\\.")),
        );
      }
    });

    it("多条映射 ⇒ 拒绝(恰好一条)", () => {
      expect(() =>
        parseLoopbackPortMapping(
          `{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"34567"},{"HostIp":"127.0.0.1","HostPort":"34568"}]}`,
        ),
      ).toThrow(/映射数/);
    });

    it("其他端口有绑定(任意 HostIp)⇒ 拒绝;其他端口为 null/空(未发布)⇒ 通过", () => {
      expect(() =>
        parseLoopbackPortMapping(
          `{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"34567"}],"9999/tcp":[{"HostIp":"127.0.0.1","HostPort":"1111"}]}`,
        ),
      ).toThrow(/其他发布端口/);
      expect(() =>
        parseLoopbackPortMapping(
          `{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"34567"}],"9999/tcp":[{"HostIp":"0.0.0.0","HostPort":"1111"}]}`,
        ),
      ).toThrow(/其他发布端口/);
      expect(
        parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"34567"}],"9999/tcp":null}`),
      ).toEqual({ hostIp: "127.0.0.1", hostPort: "34567" });
      expect(
        parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"34567"}],"9999/tcp":[]}`),
      ).toEqual({ hostIp: "127.0.0.1", hostPort: "34567" });
    });

    it("5432 未发布 ⇒ 拒绝", () => {
      expect(() => parseLoopbackPortMapping(`{"9999/tcp":null}`)).toThrow(/5432/);
      expect(() => parseLoopbackPortMapping(`{}`)).toThrow(/5432/);
      expect(() => parseLoopbackPortMapping(`{"5432/tcp":[]}`)).toThrow(/5432/);
    });

    it("HostPort 空/非数字/越界 ⇒ 拒绝", () => {
      expect(() => parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]}`)).toThrow(/HostPort/);
      expect(() => parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"abc"}]}`)).toThrow(
        /HostPort/,
      );
      expect(() => parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"127.0.0.1"}]}`)).toThrow(/HostPort/);
      expect(() => parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"0"}]}`)).toThrow(
        /HostPort/,
      );
      expect(() => parseLoopbackPortMapping(`{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"70000"}]}`)).toThrow(
        /HostPort/,
      );
    });

    it("inspect 失败/非 JSON/非对象 ⇒ 拒绝", () => {
      expect(() => parseLoopbackPortMapping("not-json")).toThrow(/inspect|JSON/);
      expect(() => parseLoopbackPortMapping("")).toThrow(/inspect|JSON/);
      expect(() => parseLoopbackPortMapping(`["5432/tcp"]`)).toThrow(/inspect|JSON/);
      expect(() => parseLoopbackPortMapping(`"5432/tcp"`)).toThrow(/inspect|JSON/);
      expect(() => parseLoopbackPortMapping(`null`)).toThrow(/inspect|JSON/);
    });
  });

  describe("startEphemeralPg 编排(fake runner;拒绝即销毁本容器)", () => {
    it("启动→inspect 校验→返回映射;调用序 run→inspect,无销毁", () => {
      const sim = fakeDocker({ inspectJson: GOOD_INSPECT });
      const m = startEphemeralPg({ container: "relay-test-d08-ok", password: "pw", runDocker: sim.runner });
      expect(m).toEqual({ hostIp: "127.0.0.1", hostPort: "34567" });
      expect(sim.calls.length).toBe(2);
      expect(sim.calls[0]![0]).toBe("run");
      expect(sim.calls[0]).toContain("relay-test-d08-ok");
      expect(sim.calls[0]).not.toContain("-P");
      expect(sim.calls[1]![0]).toBe("inspect");
      expect(sim.calls[1]).toContain("relay-test-d08-ok");
      expect(sim.calls.some((c) => c[0] === "rm")).toBe(false);
    });

    it("校验拒绝(0.0.0.0)⇒ rm -f 本容器后抛错;销毁仅针对本容器唯一 nonce", () => {
      const sim = fakeDocker({ inspectJson: `{"5432/tcp":[{"HostIp":"0.0.0.0","HostPort":"34567"}]}` });
      expect(() =>
        startEphemeralPg({ container: "relay-test-d08-bad", password: "pw", runDocker: sim.runner }),
      ).toThrow(/已销毁本容器|拒绝/);
      const rmCalls = sim.calls.filter((c) => c[0] === "rm");
      expect(rmCalls.length).toBe(1);
      expect(rmCalls[0]).toEqual(["rm", "-f", "relay-test-d08-bad"]);
    });

    it("inspect 失败 ⇒ fail-closed:销毁本容器并抛错", () => {
      const sim = fakeDocker({ inspectThrows: new Error("Error response from daemon: No such container") });
      expect(() => startEphemeralPg({ container: "relay-test-d08-x", password: "pw", runDocker: sim.runner })).toThrow(
        /已销毁本容器|inspect/,
      );
      expect(sim.calls.some((c) => c[0] === "rm" && c.includes("relay-test-d08-x"))).toBe(true);
    });

    it("run 本身失败 ⇒ 如实抛出;无映射可校验,不误删任何容器", () => {
      const sim = fakeDocker({ runThrows: new Error("docker: Error response from daemon: pull failed") });
      expect(() => startEphemeralPg({ container: "relay-test-d08-y", password: "pw", runDocker: sim.runner })).toThrow(
        /启动失败/,
      );
      expect(sim.calls.some((c) => c[0] === "rm")).toBe(false);
      expect(sim.calls.every((c) => !c.includes("relay-test-d08-z"))).toBe(true);
    });
  });
});
