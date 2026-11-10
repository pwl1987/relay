// P0-02A C-8:出口代理 v2——密钥隔离 + 请求计数(docker+iptables 实测;缺一显式 skip)。
// 验证门(P0-01C REPORT §5 设计落地):真实 key 只在代理进程;Run 容器可见面
// (models.json/env/argv)只有占位值;代理改写 Authorization;计数端点精确计数;
// 外部 DROP 白名单语义不变;规则缺失 FAIL-CLOSED。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import {
  ensureEgress,
  verifyEgressEffective,
  verifyEgressRules,
  readEgressRequestCount,
  realKeyFileValid,
  teardownEgress,
  type EgressStatus,
} from "../../src/runtime/egress.ts";
import {
  prepareRunDirs,
  buildPiArgs,
  PROXY_PLACEHOLDER_APIKEY,
  dockerAvailable,
  SANDBOX_IMAGE,
} from "../../src/runtime/sandbox.ts";
import { probeProvider, type ProviderConfig } from "../helpers/provider.ts";

const REAL_KEY = "sk-real-key-must-not-leak-42";

function sudoIptablesAvailable(): boolean {
  try {
    execFileSync("sudo", ["-n", "iptables", "-L", "DOCKER-USER", "-n"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const MODEL: ProviderConfig | null = await probeProvider();
const dockerOk = dockerAvailable();
const iptOk = sudoIptablesAvailable();

describe.skipIf(!MODEL || !dockerOk || !iptOk)("出口代理 v2(密钥隔离 + 请求计数,容器实测)", () => {
  let t: TestDb;
  let egress: EgressStatus | null = null;
  // G-3:真实 key 只存宿主 0600 文件(经只读挂载进代理;env/inspect 零可见)
  let keyFile: string;
  beforeAll(async () => {
    t = await createTestDb("c8-egress-proxy");
    keyFile = join(mkdtempSync(join(tmpdir(), "relay-fwd-key-")), "real-key");
    writeFileSync(keyFile, REAL_KEY, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    expect(realKeyFileValid(keyFile)).toBe(true);
    const model = MODEL!;
    const s = await ensureEgress(model.baseUrl, { realKeyFile: keyFile });
    egress = await verifyEgressEffective(s);
    expect(egress.ok, `出口约束未生效: ${egress.reason}`).toBe(true);
    expect(egress.keyIsolation).toBe(true);
  }, 240_000);
  afterAll(async () => {
    teardownEgress();
    await t.cleanup();
  });

  it("Run 容器可见面零真实 key:models.json 占位 / argv 无 --api-key / 代理改写 Authorization", async () => {
    // 1) models.json:占位 key,真实 key 不存在
    const spec = prepareRunDirs("/tmp", "docker", {
      provider: MODEL!.provider,
      model: MODEL!.model,
      apiKey: REAL_KEY, // 即使误传真实 key,也必须被占位替换
      baseUrl: `http://${egress!.hostIp}:${egress!.modelPort}/v1`,
    });
    const mjPath = join(spec.homeDir, ".pi", "agent", "models.json");
    expect(existsSync(mjPath)).toBe(true);
    const mj = readFileSync(mjPath, "utf8");
    expect(mj).toContain(PROXY_PLACEHOLDER_APIKEY);
    expect(mj).not.toContain(REAL_KEY);
    // 2) pi argv:无 --api-key(宿主 ps 可见面收口,P0-01B F-7)
    const args = buildPiArgs({ provider: MODEL!.provider, model: MODEL!.model, apiKey: REAL_KEY, baseUrl: "" }, "/opt/relay/ext/x.ts");
    expect(args.join(" ")).not.toContain("--api-key");
    expect(args.join(" ")).not.toContain(REAL_KEY);
  });

  it("代理改写生效:占位 key 经代理被换成真实 key(magpie 接受);计数精确 +1/请求", async () => {
    const before = await readEgressRequestCount();
    expect(before, "计数端点应可达(agent:false 消除 keep-alive 竞态)").not.toBeNull();
    // 容器内以占位 key 发请求(与 Run 容器同路径:占位 key + 代理端口)。
    // magpie 高负载下偶发 15s 级慢响应(全套件实测),带 3 次重试(与 verifyEgressEffective 同纪律)。
    let out = "";
    for (let i = 0; i < 3; i++) {
      const script = `
        fetch('http://${egress!.hostIp}:${egress!.modelPort}/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ${PROXY_PLACEHOLDER_APIKEY}' },
          body: JSON.stringify({ model: '${MODEL!.model}', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(15000),
        }).then(async (r) => {
          const body = await r.text();
          console.log('STATUS:' + r.status);
          if (r.status === 401) console.log('LEAK:proxy did not rewrite auth');
        }).catch((e) => console.log('ERR:' + e.message));`;
      out = execFileSync("docker", ["run", "--rm", "--network", egress!.network, SANDBOX_IMAGE, "node", "-e", script], {
        encoding: "utf8", timeout: 60_000,
      });
      if (/STATUS:\d\d\d/.test(out)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(out).not.toContain("LEAK"); // 占位 key 未被拒 ⇒ 改写生效(真实 key 到达 magpie)
    expect(out).toMatch(/STATUS:(200|4\d\d)/); // 非网络层失败(HTTP 层有响应)
    const after = await readEgressRequestCount();
    // 重试会带额外计数;断言"每次请求恰好 +1"的精确性(非 <=)
    const extra = (out.match(/STATUS:/g) ?? []).length - 1;
    expect(after!.requests).toBe(before!.requests + 1 + Math.max(extra, 0)); // 1 请求 = 1 计数(精确)
  });

  it("计数端点仅宿主可达:容器子网访问被白名单 DROP;外网仍然阻断", { timeout: 120_000 }, async () => {
    // 容器 → hostIp:13426(计数端口)不在 INPUT 白名单 ⇒ 拒绝/超时
    const script = `
      fetch('http://${egress!.hostIp}:13426/', { signal: AbortSignal.timeout(4000) })
        .then((r) => console.log('REACHABLE:' + r.status))
        .catch(() => console.log('BLOCKED'));`;
    const out = execFileSync("docker", ["run", "--rm", "--network", egress!.network, SANDBOX_IMAGE, "node", "-e", script], {
      encoding: "utf8", timeout: 60_000,
    }).trim();
    expect(out).toBe("BLOCKED");
    // 外网仍阻断(白名单语义不变)
    const ext = execFileSync(
      "docker",
      ["run", "--rm", "--network", egress!.network, SANDBOX_IMAGE, "node", "-e",
        "fetch('https://registry.npmjs.org',{signal:AbortSignal.timeout(8000)}).then(()=>console.log('REACHABLE')).catch(()=>console.log('BLOCKED'))"],
      { encoding: "utf8", timeout: 60_000 },
    ).trim();
    expect(ext).toBe("BLOCKED");
  });

  it("FAIL-CLOSED:转发器不在 ⇒ verifyEgressRules 拒绝(Run 拒启)", async () => {
    execFileSync("docker", ["rm", "-f", "relay-egress-fwd"], { timeout: 30_000 });
    expect(verifyEgressRules(egress!.subnet!, egress!.hostIp!, egress!.modelPort!)).toBe(false);
    // 恢复(供 afterAll 语义完整;teardown 幂等)
    await ensureEgress(MODEL!.baseUrl, { realKeyFile: keyFile });
  });

  it("G-3:docker inspect 零真实 key(env 面 FWD_REAL_KEY 废除;仅 0600 文件只读挂载)", () => {
    const inspect = execFileSync("docker", ["inspect", "relay-egress-fwd"], { encoding: "utf8", timeout: 30_000 });
    expect(inspect).not.toContain("FWD_REAL_KEY"); // env 注入面已废除
    expect(inspect).not.toContain(REAL_KEY); // 任何 inspect 可见字段均无 key
    expect(inspect).toContain(":ro"); // 持钥文件以只读挂载进入
    const mounts = JSON.parse(inspect) as Array<{ Mounts?: Array<{ Destination?: string; Source?: string }> }>;
    const keyMount = mounts[0]?.Mounts?.find((m) => m.Destination === "/run/relay-fwd/real-key");
    expect(keyMount?.Source).toBe(keyFile);
  });

  it("数据库隔离哨兵(本文件 schema 独立)", async () => {
    const r = await t.db.execute(sql`SELECT current_schema() AS s`);
    expect(String(r.rows[0]!["s"])).toMatch(/^p01a_c8_egress_proxy_/);
  });
});
