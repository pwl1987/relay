// P0-00 实验 B:Worker CLI(实验代码)。
// 用法: node worker.mjs <command> <args...>
//   reset                          重建 schema 并播种测试任务
//   snapshot <label>               打印任务/租约/审计快照
//   claim <task> <owner> <ttlSec>  领取租约,输出 JSON 结果
//   advance <task> <owner> <fencing> <from> <to>
//   reconcile <owner>              将"租约已过期但仍处 LEASED/RUNNING"的任务回收为 READY
//   run-hold <task> <owner> <ttlSec>  claim -> advance RUNNING -> 长时间持有(供 SIGKILL 测试)
import { connect, claimTask, advanceTask, snapshot } from "./lease.mjs";

const [cmd, ...args] = process.argv.slice(2);
const client = await connect();

async function seedTask(id) {
  await client.query(
    `INSERT INTO tasks (id, state) VALUES ($1,'READY')
     ON CONFLICT (id) DO UPDATE SET state='READY', state_version=0, updated_at=now()`,
    [id],
  );
  await client.query("DELETE FROM leases WHERE task_id=$1", [id]);
}

switch (cmd) {
  case "reset": {
    const fs = await import("node:fs/promises");
    await client.query(await fs.readFile(new URL("./schema.sql", import.meta.url), "utf8"));
    await seedTask("t-b1");
    await seedTask("t-b2");
    await seedTask("t-b3");
    await snapshot(client, "reset");
    break;
  }
  case "seed": {
    await seedTask(args[0]);
    console.log(JSON.stringify({ ok: true, seeded: args[0] }));
    break;
  }
  case "snapshot": {
    await snapshot(client, args[0] ?? "cli");
    break;
  }
  case "claim": {
    const [task, owner, ttl] = args;
    const r = await claimTask(client, task, owner, Number(ttl));
    console.log(JSON.stringify({ op: "claim", task, owner, ...r }));
    break;
  }
  case "advance": {
    const [task, owner, fencing, from, to] = args;
    const r = await advanceTask(client, task, owner, Number(fencing), from, to);
    console.log(JSON.stringify({ op: "advance", task, owner, fencing: Number(fencing), ...r }));
    break;
  }
  case "reconcile": {
    const owner = args[0];
    await client.query("BEGIN");
    const rows = await client.query(
      `SELECT t.id, t.state FROM tasks t JOIN leases l ON l.task_id = t.id
       WHERE t.state IN ('LEASED','RUNNING','VERIFYING') AND l.lease_expires_at <= now() FOR UPDATE OF t`,
    );
    for (const row of rows.rows) {
      await client.query(`UPDATE tasks SET state='READY', state_version = state_version+1, updated_at=now() WHERE id=$1`, [row.id]);
      await client.query(
        `INSERT INTO audit_events (actor,action,task_id,before_state,after_state,detail)
         VALUES ($1,'RECONCILE_EXPIRED',$2,$3,'READY',$4)`,
        [owner, row.id, row.state, JSON.stringify({ reason: "lease_expired" })],
      );
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ op: "reconcile", owner, reclaimed: rows.rows.map((r) => r.id) }));
    break;
  }
  case "run-hold": {
    const [task, owner, ttl] = args;
    const c = await claimTask(client, task, owner, Number(ttl));
    console.log(JSON.stringify({ op: "claim", task, owner, ...c }));
    if (!c.ok) process.exit(1);
    const a = await advanceTask(client, task, owner, c.fencingToken, "LEASED", "RUNNING");
    console.log(JSON.stringify({ op: "advance", task, owner, ...a }));
    if (!a.ok) process.exit(1);
    console.log("HOLDING");
    await new Promise(() => {}); // 挂起直至被 SIGKILL
    break;
  }
  default:
    console.error("unknown command", cmd);
    process.exit(2);
}
await client.end();
