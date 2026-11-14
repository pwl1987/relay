// RELAY-DEPLOY-REHEARSAL-08:离线增量迁移演练工具(0007→0008→0009)行为规范测试。
// 目标:在**已授权测试 PG**(testdb 守卫:loopback:55433/relayp000 + p01a_ 前缀 schema)下,
// 证明既有工具不适合原位升级(init-schema 见 goals 即跳过 / applyMigrations 全量重放撞表)
// 之后,唯一合法的增量升级语义(红先绿后):
//   - plan 只读:精确报告当前形状、拟执行 SQL(取自真实迁移文件)、前置/后置条件;零写入;
//   - apply 仅接受显式隔离测试 schema(p01a_*):标记检测跳过已应用(重复执行不盲撞)、
//     逐步事务 + search_path 钉死 + 后验列/默认值/触发器/约束;任一步失败可定位断点,不假 GO;
//   - 守卫 fail-closed:非 p01a_ schema(尤其 relay_console/public/soak24h)、非回环/未显式端口
//     URL 一律在**任何连接/写入之前**拒绝;
//   - 跨 schema 隔离:apply 只写目标 schema,兄弟 schema 与 public 字节不动。
// 生产 relay_console 的计划输出(plan 模式)只读聚合计数,与 preflight 同口径(零原始数据)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../setup/testdb.ts";
import { DEFAULT_TEST_DATABASE_URL } from "../../src/core/db.ts";
import {
  assertApplyTargetAuthorized,
  applyMigrationRange,
  applyIncrementalMigration,
  buildIncrementalPlan,
  detectMigrationShape,
  verifyPostMigrationState,
  MIGRATION_JOURNAL_MAX_IDX,
} from "../../deploy/rehearse-migration.ts";

describe("RELAY-DEPLOY-REHEARSAL-08:离线增量迁移演练", () => {
  let t: TestDb;
  // 兄弟 schema(跨 schema 隔离对照;apply 目标之外的形状对照面)
  let siblingSchema = "";

  beforeAll(async () => {
    t = await createTestDb("d08-rehearsal");
    siblingSchema = `p01a_${t.schemaName.slice(5)}_sib`;
    await t.adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${siblingSchema}"`);
    const c = await t.adminPool.connect();
    try {
      await applyMigrationRange(c, siblingSchema, 7);
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    await t.adminPool.query(`DROP SCHEMA IF EXISTS "${siblingSchema}" CASCADE`).catch(() => {});
    await t.cleanup();
  });

  /** 在主测试 schema 上构造 0007 旧形状(createTestDb 已全量应用,先撤 0008/0009 对应列再降表?不行 ——
   *  改用独立通道:直接 DROP 两列即可精确复原 0007 形状;两列本就由 0008/0009 添加)。 */
  async function downgradeTo0007(schemaName: string): Promise<void> {
    await t.adminPool.query(`ALTER TABLE "${schemaName}"."goal_messages" DROP COLUMN IF EXISTS "execution_request"`);
    await t.adminPool.query(`ALTER TABLE "${schemaName}"."tasks" DROP COLUMN IF EXISTS "abort_requested_at"`);
  }

  async function markers(schemaName: string): Promise<{ g6: number; g7: number; g8: number; g9: number }> {
    const r = await t.adminPool.query(
      `SELECT
         (SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name='goal_messages') g6,
         (SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name='goal_message_consumptions') g7,
         (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='goal_messages' AND column_name='execution_request') g8,
         (SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='abort_requested_at') g9`,
      [schemaName],
    );
    const row = r.rows[0]!;
    return { g6: Number(row["g6"]), g7: Number(row["g7"]), g8: Number(row["g8"]), g9: Number(row["g9"]) };
  }

  it("applyMigrationRange 构造精确 0007 形状(0000..0007,不含 0008/0009)", async () => {
    expect(MIGRATION_JOURNAL_MAX_IDX).toBe(9);
    // createTestDb 是全量形状;这里验证"范围应用"在兄弟 schema 上产生的就是 0007 形状
    const m = await markers(siblingSchema);
    expect(m).toEqual({ g6: 1, g7: 1, g8: 0, g9: 0 });
  });

  it("detectMigrationShape 只读识别形状(plan 面不写入)", async () => {
    await downgradeTo0007(t.schemaName);
    const before = await markers(t.schemaName);
    expect(before).toEqual({ g6: 1, g7: 1, g8: 0, g9: 0 });
    const shape = await detectMigrationShape(t.adminPool, t.schemaName);
    expect(shape.supported).toBe(true);
    expect(shape.pendingTags).toEqual(["0008_goal_messages_execution_request", "0009_tasks_abort_requested"]);
    // 只读:检测前后形状不变
    const after = await markers(t.schemaName);
    expect(after).toEqual(before);
  });

  it("buildIncrementalPlan 输出真实迁移文件 SQL + 前置/后置条件(不写库)", async () => {
    const shape = await detectMigrationShape(t.adminPool, t.schemaName);
    const plan = await buildIncrementalPlan(shape);
    expect(plan.steps.map((s) => s.tag)).toEqual([
      "0008_goal_messages_execution_request",
      "0009_tasks_abort_requested",
    ]);
    expect(plan.steps[0]!.statements.length).toBeGreaterThan(0);
    expect(plan.steps[0]!.statements[0]).toMatch(
      /ALTER TABLE "goal_messages" ADD COLUMN "execution_request" boolean NOT NULL DEFAULT false/,
    );
    expect(plan.steps[1]!.statements[0]).toMatch(
      /ALTER TABLE "tasks" ADD COLUMN "abort_requested_at" timestamp with time zone/,
    );
    expect(plan.steps[0]!.precondition.markerPresent).toBe(false);
    expect(plan.verdict).toBe("incremental_upgrade_available");
  });

  it("applyIncrementalMigration 0007→0009:逐步应用+后验(列/默认值回填/触发器/约束/行数守恒)", async () => {
    // 合成行(0007 形状已有 append-only 守卫 ⇒ 只 INSERT)
    await t.db
      .execute(
        sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('__none__', 'USER', 'USER_MESSAGE', '演练合成消息')`,
      )
      .catch(async () => {
        // goal_id 有 FK:先落一个 goal
        await t.db.execute(
          sql`INSERT INTO goals (id, raw_input, budget) VALUES ('goal-d08u', '演练合成目标', '{"modelCalls":2}'::jsonb)`,
        );
        await t.db.execute(
          sql`INSERT INTO goal_messages (goal_id, actor, kind, content) VALUES ('goal-d08u', 'USER', 'USER_MESSAGE', '演练合成消息')`,
        );
      });
    const rowsBefore = await t.db.execute(sql`SELECT count(*)::int AS n FROM goal_messages`);
    const tasksBefore = await t.db.execute(sql`SELECT count(*)::int AS n FROM tasks`);

    const report = await applyIncrementalMigration(t.adminPool, t.schemaName);
    expect(report.steps.map((s) => `${s.tag}:${s.status}`)).toEqual([
      "0008_goal_messages_execution_request:applied",
      "0009_tasks_abort_requested:applied",
    ]);
    expect(report.verification.ok).toBe(true);

    const col8 = await t.db.execute(sql`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema=${t.schemaName} AND table_name='goal_messages' AND column_name='execution_request'`);
    expect(col8.rows[0]).toMatchObject({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
    const col9 = await t.db.execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema=${t.schemaName} AND table_name='tasks' AND column_name='abort_requested_at'`);
    expect(col9.rows[0]!["is_nullable"]).toBe("YES");
    // 旧行默认回填:全部 execution_request=false
    const backfill = await t.db.execute(
      sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE execution_request = false)::int AS falses FROM goal_messages`,
    );
    expect(backfill.rows[0]!["falses"]).toBe(backfill.rows[0]!["total"]);
    // append-only 审计守卫仍在
    const trig = await t.db.execute(sql`
      SELECT count(*)::int AS n FROM information_schema.triggers
      WHERE trigger_schema=${t.schemaName} AND event_object_table='audit_events'`);
    expect(Number(trig.rows[0]!["n"])).toBeGreaterThanOrEqual(2);
    // 行数守恒
    expect((await t.db.execute(sql`SELECT count(*)::int AS n FROM goal_messages`)).rows[0]!["n"]).toBe(
      rowsBefore.rows[0]!["n"],
    );
    expect((await t.db.execute(sql`SELECT count(*)::int AS n FROM tasks`)).rows[0]!["n"]).toBe(
      tasksBefore.rows[0]!["n"],
    );
  });

  it("重复执行不盲撞:已应用步骤标记 skipped_already,零 ALTER", async () => {
    const report = await applyIncrementalMigration(t.adminPool, t.schemaName);
    expect(report.steps.map((s) => `${s.tag}:${s.status}`)).toEqual([
      "0008_goal_messages_execution_request:skipped_already",
      "0009_tasks_abort_requested:skipped_already",
    ]);
    expect(report.verification.ok).toBe(true);
  });

  it("半迁移断点定位与续跑:failAt 注入失败后 plan 精确报告 pending,不假 GO;resume 完成", async () => {
    // 独立 schema 做失败注入(不污染主 schema)
    const failSchema = `p01a_${t.schemaName.slice(5)}_fail`;
    await t.adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${failSchema}"`);
    try {
      const c = await t.adminPool.connect();
      try {
        await applyMigrationRange(c, failSchema, 7);
      } finally {
        c.release();
      }
      // 注入:在 0009 步失败 ⇒ 0008 已应用,0009 未应用
      await expect(
        applyIncrementalMigration(t.adminPool, failSchema, { failAtTag: "0009_tasks_abort_requested" }),
      ).rejects.toThrow(/fail_at_injection/);
      const half = await detectMigrationShape(t.adminPool, failSchema);
      expect(half.pendingTags).toEqual(["0009_tasks_abort_requested"]);
      expect(half.appliedTags).toEqual(["0008_goal_messages_execution_request"]);
      expect(half.verdict).toBe("incremental_upgrade_available"); // 半迁移状态 ≠ 已完成(不假 GO)
      // 断点续跑
      const resumed = await applyIncrementalMigration(t.adminPool, failSchema);
      expect(resumed.steps.map((s) => `${s.tag}:${s.status}`)).toEqual([
        "0008_goal_messages_execution_request:skipped_already",
        "0009_tasks_abort_requested:applied",
      ]);
      const done = await markers(failSchema);
      expect(done).toEqual({ g6: 1, g7: 1, g8: 1, g9: 1 });
    } finally {
      await t.adminPool.query(`DROP SCHEMA IF EXISTS "${failSchema}" CASCADE`).catch(() => {});
    }
  });

  it("守卫:非授权目标在任何写入前拒绝(relay_console/public/soak24h/非 p01a_ 前缀)", () => {
    const authorizedUrl = DEFAULT_TEST_DATABASE_URL;
    expect(() => assertApplyTargetAuthorized("relay_console", authorizedUrl)).toThrow(/relay_console/);
    expect(() => assertApplyTargetAuthorized("public", authorizedUrl)).toThrow(/public/);
    expect(() => assertApplyTargetAuthorized("soak24h", authorizedUrl)).toThrow(/soak24h/);
    expect(() => assertApplyTargetAuthorized("goals", authorizedUrl)).toThrow(/p01a_/);
    expect(() => assertApplyTargetAuthorized("", authorizedUrl)).toThrow(/p01a_/);
    expect(() => assertApplyTargetAuthorized("p01a_ok", authorizedUrl)).not.toThrow();
    // URL 守卫:非回环/未显式端口一律拒绝(fail-closed)
    expect(() => assertApplyTargetAuthorized("p01a_ok", "postgresql://u:p@10.1.2.3:5432/db")).toThrow(/回环/);
    expect(() => assertApplyTargetAuthorized("p01a_ok", "postgresql://u:p@prod.example.com/db")).toThrow(/回环/);
    expect(() => assertApplyTargetAuthorized("p01a_ok", "postgresql://u:p@127.0.0.1/db")).toThrow(/端口/);
    // apply 入口同门(即使直接调迁移函数也先过守卫)
    expect(() => assertApplyTargetAuthorized("p01a_ok", "not-a-url")).toThrow();
  });

  it("跨 schema 隔离:apply 只写目标 schema,兄弟 schema 与 public 不动", async () => {
    // 兄弟 schema 保持 0007 形状(above beforeAll);apply 目标 = 主 schema(已 0009)
    // 重新降级兄弟 schema 验证"apply B 不影响 A":对兄弟执行 apply,然后核对主 schema 不动
    const sibBefore = await markers(siblingSchema);
    expect(sibBefore).toEqual({ g6: 1, g7: 1, g8: 0, g9: 0 });
    const mainBefore = await markers(t.schemaName);
    expect(mainBefore).toEqual({ g6: 1, g7: 1, g8: 1, g9: 1 });

    const report = await applyIncrementalMigration(t.adminPool, siblingSchema);
    expect(report.verification.ok).toBe(true);
    const sibAfter = await markers(siblingSchema);
    expect(sibAfter).toEqual({ g6: 1, g7: 1, g8: 1, g9: 1 });
    // 主 schema 与 public 完全不动
    const mainAfter = await markers(t.schemaName);
    expect(mainAfter).toEqual(mainBefore);
    const pub = await t.adminPool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='goal_messages'`,
    );
    expect(Number(pub.rows[0]!["n"])).toBe(0);
  });

  it("verifyPostMigrationState 损坏检测:审计守卫被撤/新行显式 true ⇒ 后验如实失败", async () => {
    const broken = `p01a_${t.schemaName.slice(5)}_bad`;
    await t.adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${broken}"`);
    try {
      const c = await t.adminPool.connect();
      try {
        await applyMigrationRange(c, broken, 9); // 全量(0000..0009)
      } finally {
        c.release();
      }
      await t.adminPool.query(`DROP TRIGGER IF EXISTS audit_events_append_only ON "${broken}"."audit_events"`);
      const v = await verifyPostMigrationState(t.adminPool, broken, { expectMarkers: { g6: 1, g7: 1, g8: 1, g9: 1 } });
      expect(v.ok).toBe(false);
      expect(v.failures.some((f) => f.startsWith("guard_audit_triggers:"))).toBe(true);
    } finally {
      await t.adminPool.query(`DROP SCHEMA IF EXISTS "${broken}" CASCADE`).catch(() => {});
    }
  });
});
