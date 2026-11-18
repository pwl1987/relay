// RELAY-RESULT-TRUTH-16 定向反例(集成面):用户验收事实闭环 + 结果来源辨识。
// 合同 §三-2/§五-5~9:用户接受/拒绝结果是独立 append-only 审计事实(USER_RESULT_*),
// 绝不与内部 Gate 的 task ACCEPTED 混谈;拒绝绝不自动改 task/Gate 状态、绝不触发 Run;
// 重复操作 = 可解释的追加历史(不互相覆盖);stub/live 来源在结果视图显式(复用 runs.model_ref,
// 不新增第二套来源);零 migration/零 schema(载体 = 既有 audit_events append-only 触发器)。
// 隔离:一次性 PG schema(createTestDb)+ 本地 HTTP,零生产连接/零真实模型;用后即毁。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { changesetDetailView } from "../../src/server/views/changesets.ts";
import { goalDetailView, goalStatusView } from "../../src/server/views/goal.ts";

const PASSWORD = "result-truth-pw";

describe("RELAY-RESULT-TRUTH-16:用户验收 append-only 事实 + 结果来源辨识(API/视图)", () => {
  let t: TestDb;
  let server: ReturnType<typeof createRelayServer>["server"];
  let base = "";
  let cookie = "";
  let csrf = "";
  let g1 = ""; // 有 DELIVERED 变更集(stub 运行)
  let g2 = ""; // 有 FAILED 变更集(live 运行)
  let g3 = ""; // 无运行
  let c1 = "";
  let c2 = "";

  async function post(
    path: string,
    body: unknown,
    withAuth = true,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(withAuth ? { cookie, "x-relay-csrf": csrf, origin: base } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function auditCount(action: string): Promise<number> {
    const rows = await t.db.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = ${action}`);
    return Number(rows.rows[0]!["n"]);
  }

  beforeAll(async () => {
    t = await createTestDb("result-truth");
    const auth = new Auth({
      password: PASSWORD,
      sessionTtlMs: 3_600_000,
      operators: ["owner"],
      maxLoginFailures: 10,
      loginWindowMs: 60_000,
      lockoutMs: 60_000,
    });
    const handle = createRelayServer({
      db: t.db,
      auth,
      workerMode: "stub",
      host: "127.0.0.1",
      port: 0,
      staticDir: joinWeb(),
    });
    server = handle.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "";
    cookie = setCookie.split(";")[0] ?? "";
    csrf = ((await login.json()) as { csrfToken?: string }).csrfToken ?? "";
    expect(cookie).not.toBe("");
    expect(csrf).not.toBe("");

    // 三个 Goal(真实创建路径;无项目绑定)
    const ids: string[] = [];
    for (const raw of ["结果真实性-验收目标一", "结果真实性-验收目标二", "结果真实性-无运行目标"]) {
      const res = await fetch(base + "/api/goals", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf, origin: base },
        body: JSON.stringify({ rawInput: raw }),
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { goalId: string }).goalId);
    }
    g1 = ids[0]!;
    g2 = ids[1]!;
    g3 = ids[2]!;
    // 夹具:task + run + changeset(g1=stub/DELIVERED;g2=live/FAILED)
    c1 = await fixtureChain(g1, "ACCEPTED", "stub/stub/gm", "DELIVERED");
    c2 = await fixtureChain(g2, "FAILED", "pi-coder/glm-x", "FAILED");
  });

  afterAll(async () => {
    try {
      server?.close();
    } catch {
      /* 已关 */
    }
    await t.cleanup();
  });

  /** 直插 task + run + changeset 链(视图/绑定校验夹具;身份形状与生产写入一致)。 */
  async function fixtureChain(
    goalId: string,
    taskState: string,
    modelRef: string,
    deliveryState: string,
  ): Promise<string> {
    const taskId = `task-rt-${goalId.slice(5, 13)}`;
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands)
      VALUES (${taskId}, ${goalId}, ${taskState}, '["/workspace"]'::jsonb, '["echo"]'::jsonb)
    `);
    const runId = `run-rt-${goalId.slice(5, 13)}`;
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome, detail)
      VALUES (${runId}, ${taskId}, 1, 'pi-rpc', ${modelRef}, 'host-fallback', 'SUCCEEDED',
              '{"role":"coder"}'::jsonb)
    `);
    const csId = `cs-rt-${goalId.slice(5, 13)}`;
    await t.db.execute(sql`
      INSERT INTO candidate_changesets
        (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope,
         git_commit_sha, delivery_state)
      VALUES (${csId}, ${taskId}, ${runId}, 1, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"r".repeat(64)},
              '{"added":["x.txt"],"modified":[],"removed":[]}'::jsonb,
              '{"inScope":["/workspace/x.txt"],"violations":[]}'::jsonb,
              ${"d".repeat(40)}, ${deliveryState})
    `);
    return csId;
  }

  it("T8 无验收事实:goalStatusView.userResult 恒 null(不猜测、不冒充)", async () => {
    const st = await goalStatusView(t.db, g3);
    expect(st).toBeTruthy();
    expect(st!.userResult).toBeNull();
  });

  it("T9 来源辨识:changeset/goal 视图显式 stub/live/none(复用 runs.model_ref)", async () => {
    const d1 = await changesetDetailView(t.db, c1);
    expect(d1!.provenance.source).toBe("stub");
    expect(d1!.provenance.modelRef).toBe("stub/stub/gm");
    const d2 = await changesetDetailView(t.db, c2);
    expect(d2!.provenance.source).toBe("live");
    const dg3 = await goalDetailView(t.db, g3);
    expect(dg3!.provenance.source).toBe("none");
  });

  it("T1 未认证 POST ⇒ 401(验收写入是操作面,匿名零写入)", async () => {
    const res = await post(`/api/goals/${g1}/result-acceptance`, { decision: "accept" }, false);
    expect(res.status).toBe(401);
    expect(await auditCount("USER_RESULT_ACCEPTED")).toBe(0);
  });

  it("T2 接受结果 ⇒ 201 + append-only 审计事实(绑 Goal+changeset;重载仍可见;快照交付状态)", async () => {
    const res = await post(`/api/goals/${g1}/result-acceptance`, { decision: "accept", changesetId: c1 });
    expect(res.status).toBe(201);
    const rows = await t.db.execute(sql`
      SELECT seq, actor, authority, action, detail FROM audit_events
      WHERE action = 'USER_RESULT_ACCEPTED' ORDER BY seq
    `);
    expect(rows.rows.length).toBe(1);
    const ev = rows.rows[0]!;
    expect(String(ev["actor"])).toBe("owner");
    expect(String(ev["authority"])).toBe("OWNER");
    const detail = ev["detail"] as Record<string, unknown>;
    expect(detail["goalId"]).toBe(g1);
    expect(detail["changesetId"]).toBe(c1);
    expect(detail["deliveryState"]).toBe("DELIVERED"); // 接受时点事实快照
    // 重载(全新读取)仍可见 —— 独立持久事实,非客户端会话态
    const st = await goalStatusView(t.db, g1);
    expect(st!.userResult).toBeTruthy();
    expect(st!.userResult!.decision).toBe("accepted");
    expect(st!.userResult!.changesetId).toBe(c1);
    expect(st!.userResult!.reason).toBeNull();
  });

  it("T3 重复接受 ⇒ 追加历史(2 行同向,seq 单调;状态不互相覆盖)", async () => {
    const res = await post(`/api/goals/${g1}/result-acceptance`, { decision: "accept", changesetId: c1 });
    expect(res.status).toBe(201);
    expect(await auditCount("USER_RESULT_ACCEPTED")).toBe(2);
    const st = await goalStatusView(t.db, g1);
    expect(st!.userResult!.decision).toBe("accepted");
  });

  it("T4 非法 decision / 拒绝缺原因 ⇒ 400 零写入(拒绝必须留原因)", async () => {
    const bad = await post(`/api/goals/${g1}/result-acceptance`, { decision: "maybe" });
    expect(bad.status).toBe(400);
    const noReason = await post(`/api/goals/${g1}/result-acceptance`, { decision: "reject" });
    expect(noReason.status).toBe(400);
    const blank = await post(`/api/goals/${g1}/result-acceptance`, { decision: "reject", reason: "   " });
    expect(blank.status).toBe(400);
    expect(await auditCount("USER_RESULT_REJECTED")).toBe(0);
  });

  it("T5 拒绝结果 ⇒ 原因落审计;重载可见;绝不改 task/Gate 状态、绝不触发 Run", async () => {
    const beforeRuns = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs WHERE task_id LIKE 'task-rt-%'`);
    const res = await post(`/api/goals/${g2}/result-acceptance`, {
      decision: "reject",
      reason: "交付的脚本不符合预期,需要重做",
      changesetId: c2,
    });
    expect(res.status).toBe(201);
    const rows = await t.db.execute(sql`
      SELECT actor, authority, detail FROM audit_events WHERE action = 'USER_RESULT_REJECTED' ORDER BY seq
    `);
    expect(rows.rows.length).toBe(1);
    const detail = rows.rows[0]!["detail"] as Record<string, unknown>;
    expect(detail["goalId"]).toBe(g2);
    expect(detail["reason"]).toBe("交付的脚本不符合预期,需要重做");
    expect(detail["deliveryState"]).toBe("FAILED"); // 拒绝时点事实快照
    const st = await goalStatusView(t.db, g2);
    expect(st!.userResult!.decision).toBe("rejected");
    expect(st!.userResult!.reason).toBe("交付的脚本不符合预期,需要重做");
    // 拒绝不改内部 Gate 语义:夹具任务仍 FAILED(若原 ACCEPTED 也必须仍 ACCEPTED —— e2e 里另证)
    const task = await t.db.execute(sql`SELECT state FROM tasks WHERE goal_id = ${g2} AND id LIKE 'task-rt-%'`);
    expect(String(task.rows[0]!["state"])).toBe("FAILED");
    // 拒绝不触发新 Run
    const afterRuns = await t.db.execute(sql`SELECT count(*)::int AS n FROM runs WHERE task_id LIKE 'task-rt-%'`);
    expect(Number(afterRuns.rows[0]!["n"])).toBe(Number(beforeRuns.rows[0]!["n"]));
  });

  it("T6 changesetId 不属于该 Goal ⇒ 400 零写入(跨 Goal 绑定拒绝)", async () => {
    const res = await post(`/api/goals/${g1}/result-acceptance`, { decision: "accept", changesetId: c2 });
    expect(res.status).toBe(400);
    expect(await auditCount("USER_RESULT_ACCEPTED")).toBe(2); // 仍是 T2/T3 的两行
  });

  it("T7 未知 Goal ⇒ 404 零写入", async () => {
    const res = await post("/api/goals/goal-not-exist/result-acceptance", { decision: "accept" });
    expect(res.status).toBe(404);
    expect(await auditCount("USER_RESULT_ACCEPTED")).toBe(2);
  });

  it("T10 goalDetailView 同源:provenance + userResult 与 status 一致", async () => {
    const d = await goalDetailView(t.db, g1);
    expect(d!.provenance.source).toBe("stub");
    expect(d!.userResult!.decision).toBe("accepted");
    const d2 = await goalDetailView(t.db, g2);
    expect(d2!.provenance.source).toBe("live");
    expect(d2!.userResult!.decision).toBe("rejected");
  });
});

function joinWeb(): string {
  // 静态目录与其它集成测试同源(仓库 web/)
  return process.cwd() + "/web";
}
