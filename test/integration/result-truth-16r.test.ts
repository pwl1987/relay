// RELAY-RESULT-TRUTH-16R 定向反例(集成面):用户验收必须绑定具体结果版本(changeset)。
// 协调方 REWORK Major-1:readGoalUserResult 只按 Goal 取最新 USER_RESULT_* ⇒ 旧 changeset A 的
// 验收被 Goal 级投影错误继承到新 changeset B(B 即使 FAILED 仍显示"用户已接受结果")。
// 冻结修复语义(合同 §二):
//   changeset 详情按自身 changesetId 投影;Goal/workspace 按"最新 changeset"的验收投影;
//   最新 changeset 无对应 USER_RESULT_* ⇒ 当前投影 null("用户尚未验收当前结果"),
//   即使旧 changeset 曾被接受/拒绝;历史审计全保留。
//   API:有 changeset 且未传 changesetId ⇒ 冻结到请求时最新 changeset 并把解析后的 id 写进审计;
//       Goal 完全无 changeset ⇒ 409 result_not_available(不产生漂浮验收);
//       deliveryState 快照必须来自被验收的那个 changeset(单一来源)。
// 隔离:一次性 PG schema(createTestDb)+ 本地 HTTP;零生产连接/零真实模型;用后即毁。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { Auth } from "../../src/server/auth.ts";
import { createRelayServer } from "../../src/server/app.ts";
import { changesetDetailView } from "../../src/server/views/changesets.ts";
import { goalDetailView, goalStatusView } from "../../src/server/views/goal.ts";

const PASSWORD = "result-truth-16r-pw";

describe("RELAY-RESULT-TRUTH-16R:验收绑定结果版本(旧验收不得污染新结果)", () => {
  let t: TestDb;
  let server: ReturnType<typeof createRelayServer>["server"];
  let base = "";
  let cookie = "";
  let csrf = "";
  // g1:两轮(A=DELIVERED,B=FAILED);g2:无任何 changeset;g3:单轮 A(冻结解析用);g4:两轮(显式旧 A 验收用)
  let g1 = "";
  let g2 = "";
  let g3 = "";
  let g4 = "";
  let g1a = "";
  let g1b = "";
  let g3a = "";
  let g4a = "";
  let g4b = "";

  async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-relay-csrf": csrf, origin: base },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function acceptEvents(goalId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await t.db.execute(sql`
      SELECT seq, actor, authority, action, detail FROM audit_events
      WHERE action IN ('USER_RESULT_ACCEPTED', 'USER_RESULT_REJECTED')
        AND detail->>'goalId' = ${goalId}
      ORDER BY seq ASC
    `);
    return rows.rows as Array<Record<string, unknown>>;
  }

  /** 直插 task + run + changeset 链;两次调用 created_at 递增 ⇒ 后插者即"最新 changeset"。 */
  async function fixtureChain(goalId: string, tag: string, deliveryState: string): Promise<{ csId: string }> {
    const taskId = `task-r16r-${goalId.slice(5, 13)}-${tag}`;
    await t.db.execute(sql`
      INSERT INTO tasks (id, goal_id, state, allowed_scope, allowed_commands)
      VALUES (${taskId}, ${goalId}, 'ACCEPTED', '["/workspace"]'::jsonb, '["echo"]'::jsonb)
    `);
    const runId = `run-r16r-${goalId.slice(5, 13)}-${tag}`;
    await t.db.execute(sql`
      INSERT INTO runs (id, task_id, attempt, runtime, model_ref, sandbox, outcome, detail)
      VALUES (${runId}, ${taskId}, 1, 'pi-rpc', 'stub/stub/gm', 'host-fallback', 'SUCCEEDED', '{"role":"coder"}'::jsonb)
    `);
    const csId = `cs-r16r-${goalId.slice(5, 13)}-${tag}`;
    await t.db.execute(sql`
      INSERT INTO candidate_changesets
        (id, task_id, run_id, attempt, base_sha, candidate_sha, requirement_sha, changed_files, impact_scope,
         git_commit_sha, delivery_state)
      VALUES (${csId}, ${taskId}, ${runId}, 1, ${"b".repeat(64)}, ${"c".repeat(64)}, ${"r".repeat(64)},
              '{"added":["x.txt"],"modified":[],"removed":[]}'::jsonb,
              '{"inScope":["/workspace/x.txt"],"violations":[]}'::jsonb,
              ${"d".repeat(40)}, ${deliveryState})
    `);
    return { csId };
  }

  beforeAll(async () => {
    t = await createTestDb("result-truth-16r");
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
      staticDir: process.cwd() + "/web",
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

    // 四个 Goal(真实创建路径;无项目绑定)
    const ids: string[] = [];
    for (const raw of ["16R-两轮目标一", "16R-零变更集目标", "16R-单轮冻结解析目标", "16R-两轮显式旧版目标"]) {
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
    g4 = ids[3]!;
    // g1/g4:两轮(A=DELIVERED 先,B=FAILED 后 ⇒ B 为"最新 changeset");g3:单轮 A
    g1a = (await fixtureChain(g1, "a", "DELIVERED")).csId;
    g1b = (await fixtureChain(g1, "b", "FAILED")).csId;
    g3a = (await fixtureChain(g3, "a", "DELIVERED")).csId;
    g4a = (await fixtureChain(g4, "a", "DELIVERED")).csId;
    g4b = (await fixtureChain(g4, "b", "FAILED")).csId;
    // g1:用户接受旧 A(显式 changesetId=A)
    const r = await post(`/api/goals/${g1}/result-acceptance`, { decision: "accept", changesetId: g1a });
    expect(r.status).toBe(201);
  });

  afterAll(async () => {
    try {
      server?.close();
    } catch {
      /* 已关 */
    }
    await t.cleanup();
  });

  it("R4(回归门,红轮即绿如实登记)回看 A:A 自身页面仍显示 accepted(changesetId=A)", async () => {
    const d = await changesetDetailView(t.db, g1a);
    expect(d!.userResult).toBeTruthy();
    expect(d!.userResult!.decision).toBe("accepted");
    expect(d!.userResult!.changesetId).toBe(g1a);
  });

  it("R1(Major 红复现)A accepted → 新 B FAILED:B 的 changeset 详情不得继承 A 的验收 ⇒ userResult null", async () => {
    const d = await changesetDetailView(t.db, g1b);
    expect(d!.changeset.deliveryState).toBe("FAILED");
    expect(d!.userResult).toBeNull(); // 修复前:此处错误返回 A 的 accepted
  });

  it("R2(Major 红复现)同场景 Goal status/detail 当前投影:null(不得把 A 的验收当当前验收)", async () => {
    const st = await goalStatusView(t.db, g1);
    expect(st!.userResult).toBeNull();
    const dv = await goalDetailView(t.db, g1);
    expect(dv!.userResult).toBeNull();
  });

  it("R5 A accepted → B accepted:当前投影只显示 B 的验收;A 历史页仍 accepted(A)", async () => {
    const r = await post(`/api/goals/${g1}/result-acceptance`, { decision: "accept", changesetId: g1b });
    expect(r.status).toBe(201);
    const b = await changesetDetailView(t.db, g1b);
    expect(b!.userResult!.decision).toBe("accepted");
    expect(b!.userResult!.changesetId).toBe(g1b);
    const a = await changesetDetailView(t.db, g1a);
    expect(a!.userResult!.decision).toBe("accepted");
    expect(a!.userResult!.changesetId).toBe(g1a); // A 页显示的是 A 自己的验收,不是 B 的
    const st = await goalStatusView(t.db, g1);
    expect(st!.userResult!.decision).toBe("accepted");
    expect(st!.userResult!.changesetId).toBe(g1b); // Goal 当前 = 最新 changeset B 的验收
  });

  it("R6 A accepted → B rejected:当前投影 = rejected + B 原因;A 历史保留 accepted", async () => {
    const r = await post(`/api/goals/${g1}/result-acceptance`, {
      decision: "reject",
      reason: "B 轮交付内容不符合预期",
      changesetId: g1b,
    });
    expect(r.status).toBe(201);
    const st = await goalStatusView(t.db, g1);
    expect(st!.userResult!.decision).toBe("rejected");
    expect(st!.userResult!.reason).toBe("B 轮交付内容不符合预期");
    expect(st!.userResult!.changesetId).toBe(g1b);
    const a = await changesetDetailView(t.db, g1a);
    expect(a!.userResult!.decision).toBe("accepted"); // A 历史验收不被 B 的拒绝覆盖
  });

  it("R7(红复现)有 changeset 且省略 changesetId ⇒ 冻结到请求时最新 changeset,审计写入解析后的 id", async () => {
    const r = await post(`/api/goals/${g3}/result-acceptance`, { decision: "accept" });
    expect(r.status).toBe(201);
    const evs = await acceptEvents(g3);
    expect(evs.length).toBe(1);
    const detail = evs[0]!["detail"] as Record<string, unknown>;
    expect(detail["changesetId"]).toBe(g3a); // 解析后的版本身份必须入审计(不得漂浮)
    expect(detail["changesetIdSource"]).toBe("resolved_latest");
    expect(detail["deliveryState"]).toBe("DELIVERED"); // 快照来自被验收的 changeset 本身
  });

  it("R8(红复现)Goal 完全无 changeset ⇒ 409 result_not_available,审计零新增(不产生漂浮验收)", async () => {
    const r = await post(`/api/goals/${g2}/result-acceptance`, { decision: "accept" });
    expect(r.status).toBe(409);
    expect(String((r.body as { error?: string })["error"] ?? "")).toBe("result_not_available");
    expect(await acceptEvents(g2).then((e) => e.length)).toBe(0);
  });

  it("R9+R10(红复现)显式指定旧 A:允许留历史验收事实,但不得改变当前 B 的投影;快照=A 自己的 deliveryState", async () => {
    const r = await post(`/api/goals/${g4}/result-acceptance`, { decision: "accept", changesetId: g4a });
    expect(r.status).toBe(201);
    const evs = await acceptEvents(g4);
    expect(evs.length).toBe(1);
    const detail = evs[0]!["detail"] as Record<string, unknown>;
    expect(detail["changesetId"]).toBe(g4a);
    expect(detail["changesetIdSource"]).toBe("request");
    // R10:快照必须来自被验收的 A(DELIVERED),不得混用"Goal 最新 B(FAILED)"两套来源
    expect(detail["deliveryState"]).toBe("DELIVERED");
    // R9:当前投影按最新 B ⇒ 仍为 null(A 的新增历史验收不得冒充当前事实)
    const st = await goalStatusView(t.db, g4);
    expect(st!.userResult).toBeNull();
    const b = await changesetDetailView(t.db, g4b);
    expect(b!.userResult).toBeNull();
    const a = await changesetDetailView(t.db, g4a);
    expect(a!.userResult!.decision).toBe("accepted");
  });
});
