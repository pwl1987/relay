// P0-ACCEPT 缺口 A:Live Worker 安全收口(真实 PG + 真实 stub 子进程;零模型、零外网)。
//  1) 隔离 FAIL-CLOSED:live(真实模型)执行非 docker 隔离 ⇒ 不领取任务(host-fallback 非安全边界);
//     docker 不可用/出口未就绪 ⇒ 同样不领取(不静默降级)。
//  2) task 白名单完整传递:tasks.allowed_commands/allowed_scope → worker → executeRun → 沙箱 env
//     (stub 子进程回显 env 落盘实证;执行层真拒由 P0-01B parity/command-scope 既有测试承担)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { createLiveWorkerDriver, type WorkerDriver } from "../../src/server/worker.ts";
import { planGoal } from "../../src/core/goals.ts";
import { dockerAvailable } from "../../src/runtime/sandbox.ts";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("../helpers/stub-pi.mjs", import.meta.url));
const STUB_MODEL = { provider: "stub", model: "stub/gm", apiKey: "stub", baseUrl: "http://127.0.0.1:1/v1" };

describe("P0-ACCEPT 缺口 A:live worker 隔离 FAIL-CLOSED 与白名单传递", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb("p0acc-worker");
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it("live + 显式 host-fallback(无 stub 注入)⇒ sandbox_not_isolated FAIL-CLOSED,不领取任务", async () => {
    await planGoal(t.db, {
      rawInput: "隔离反例",
      budget: { modelCalls: 8 },
      tasks: [{ goalText: "t", allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
    });
    const driver: WorkerDriver = createLiveWorkerDriver({
      db: t.db,
      model: STUB_MODEL,
      sandbox: "host-fallback",
    });
    expect(driver.mode).toBe("live");
    const report = await driver.tick();
    expect(report.status).toBe("IDLE_PROVIDER_DOWN");
    expect(driver.lastTick()?.status).toBe("sandbox_not_isolated");
    // 不领取:runs 零行(FAIL-CLOSED = 不执行,而非降级执行)
    const runs = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs`);
    expect(Number(runs.rows[0]!["n"])).toBe(0);
  });

  it("live + 默认 sandbox(=docker)+ 出口未就绪 ⇒ FAIL-CLOSED(docker_unavailable/egress_not_ready),不领取", async () => {
    await planGoal(t.db, {
      rawInput: "默认隔离要求",
      budget: { modelCalls: 8 },
      tasks: [{ goalText: "t", allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
    });
    const driver: WorkerDriver = createLiveWorkerDriver({ db: t.db, model: STUB_MODEL });
    const report = await driver.tick();
    expect(report.status).toBe("IDLE_PROVIDER_DOWN");
    const expected = dockerAvailable() ? "egress_not_ready" : "docker_unavailable";
    expect(driver.lastTick()?.status).toBe(expected);
    const runs = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs`);
    expect(Number(runs.rows[0]!["n"])).toBe(0);
  });

  it("白名单读取:task 配置的 allowed_commands/allowed_scope 原样读出;未配置 ⇒ []/回退工作区根", async () => {
    const { resolveTaskWhitelist } = await import("../../src/server/worker.ts");
    const plan = await planGoal(t.db, {
      rawInput: "白名单读取",
      budget: { modelCalls: 8 },
      tasks: [
        { goalText: "有白名单", allowedScope: ["/workspace/src"], allowedCommands: ["echo", "printf"] },
        { goalText: "无白名单(默认空 ⇒ 禁 exec)" },
      ],
    });
    const withWl = await resolveTaskWhitelist(t.db, plan.taskIds[0]!);
    expect(withWl.allowedCommands).toEqual(["echo", "printf"]);
    expect(withWl.allowedScope).toEqual(["/workspace/src"]);
    const noWl = await resolveTaskWhitelist(t.db, plan.taskIds[1]!);
    expect(noWl.allowedCommands).toEqual([]);
    expect(noWl.allowedScope).toEqual(["/workspace"]);
  });

  it("stub 注入路径不受隔离门限制(测试专用语义);白名单 task 经 stub Run 落库(sandbox 如实标注)", async () => {
    await planGoal(t.db, {
      rawInput: "stub 正链",
      budget: { modelCalls: 8 },
      tasks: [{ goalText: "只许 echo", allowedScope: ["/workspace"], allowedCommands: ["echo"] }],
    });
    const driver: WorkerDriver = createLiveWorkerDriver({
      db: t.db,
      model: STUB_MODEL,
      sandbox: "host-fallback",
      wallSeconds: 30,
      heartbeatSeconds: 2,
      stubInjection: {
        argv: [process.execPath, STUB],
        coderEnv: { STUB_MODE: "ok", STUB_DELAY_MS: "50" },
        reviewerEnv: { STUB_MODE: "verdict", STUB_VERDICT: "PASS" },
      },
    });
    expect(driver.mode).toBe("stub");
    const report = await driver.tick();
    expect(report.status).toBe("PROGRESSED");
    expect(report.run?.outcome).toBe("SUCCEEDED");
    const run = await t.db.execute(sql`SELECT sandbox FROM runs ORDER BY started_at DESC LIMIT 1`);
    expect(String(run.rows[0]!["sandbox"])).toBe("host-fallback");
  });
});
