// P0-00 实验 B:最小 Lease/Fencing 实现(实验代码,非产品实现)。
// 所有状态推进必须在单个事务内:行锁 -> 校验(租约/fencing/期望状态) -> 变更 + 审计 -> 提交。
import pg from "pg";

export const DB = process.env.RELAY_P000_PG ?? "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000";

export async function connect() {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  return c;
}

// 领取租约:仅当无租约或租约已过期时授予;fencing_token 单调递增。
export async function claimTask(client, taskId, ownerId, ttlSeconds) {
  try {
    await client.query("BEGIN");
    const t = await client.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [taskId]);
    if (t.rowCount === 0) throw new Error(`task not found: ${taskId}`);
    const task = t.rows[0];
    const l0 = await client.query("SELECT * FROM leases WHERE task_id=$1 FOR UPDATE", [taskId]);
    const prevLease = l0.rows[0];
    const leaseLive = prevLease && new Date(prevLease.lease_expires_at) > new Date();
    const claimable =
      ["READY", "NEEDS_RECONCILE"].includes(task.state) ||
      (["LEASED", "RUNNING", "VERIFYING"].includes(task.state) && !leaseLive);
    if (!claimable) {
      await client.query("ROLLBACK");
      return { ok: false, reason: `state_not_claimable:${task.state}` };
    }
    const reclaimedExpired =
      ["LEASED", "RUNNING"].includes(task.state) && !leaseLive;
    const fencing = prevLease ? Number(prevLease.fencing_token) + 1 : 1;
    await client.query(
      `INSERT INTO leases (task_id, owner_id, fencing_token, lease_expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)
       ON CONFLICT (task_id) DO UPDATE SET owner_id=$2, fencing_token=$3,
         lease_expires_at = now() + ($4 || ' seconds')::interval, heartbeat_at = now()`,
      [taskId, ownerId, fencing, String(ttlSeconds)],
    );
    await client.query(
      `UPDATE tasks SET state='LEASED', state_version = state_version + 1, updated_at = now() WHERE id=$1`,
      [taskId],
    );
    await client.query(
      `INSERT INTO audit_events (actor, action, task_id, before_state, after_state, detail)
       VALUES ($1,'CLAIM',$2,$3,'LEASED',$4)`,
      [ownerId, taskId, task.state, JSON.stringify({ fencing, reclaimedExpired, prevOwner: prevLease?.owner_id })],
    );
    await client.query("COMMIT");
    return { ok: true, fencingToken: fencing };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// 推进状态:必须持有有效租约且 fencing 匹配;否则 FENCED 拒绝。
export async function advanceTask(client, taskId, ownerId, fencingToken, fromState, toState) {
  try {
    await client.query("BEGIN");
    const t = await client.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [taskId]);
    if (t.rowCount === 0) throw new Error(`task not found: ${taskId}`);
    const task = t.rows[0];
    const l = await client.query("SELECT * FROM leases WHERE task_id=$1 FOR UPDATE", [taskId]);
    const lease = l.rows[0];
    const fail = (reason) => {
      // 拒绝也留审计(不修改任务状态)
      return client
        .query(
          `INSERT INTO audit_events (actor, action, task_id, before_state, after_state, detail)
           VALUES ($1,'ADVANCE_REJECTED',$2,$3,$3,$4)`,
          [ownerId, taskId, task.state, JSON.stringify({ reason, fencingToken })],
        )
        .then(() => client.query("COMMIT"))
        .then(() => ({ ok: false, reason, state: task.state, version: task.state_version }));
    };
    if (!lease) return await fail("no_lease");
    if (lease.owner_id !== ownerId) return await fail(`lease_owner_mismatch:${lease.owner_id}`);
    if (Number(lease.fencing_token) !== Number(fencingToken)) return await fail(`fenced:token=${lease.fencing_token}`);
    if (new Date(lease.lease_expires_at) <= new Date()) return await fail("lease_expired");
    if (task.state !== fromState) return await fail(`state_mismatch:${task.state}`);
    await client.query(
      `UPDATE tasks SET state=$2, state_version = state_version + 1, updated_at = now() WHERE id=$1`,
      [taskId, toState],
    );
    await client.query(
      `INSERT INTO audit_events (actor, action, task_id, before_state, after_state, detail)
       VALUES ($1,'ADVANCE',$2,$3,$4,$5)`,
      [ownerId, taskId, fromState, toState, JSON.stringify({ fencing: fencingToken })],
    );
    await client.query("COMMIT");
    return { ok: true, state: toState };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

export async function snapshot(client, label) {
  const tasks = await client.query("SELECT id,state,state_version FROM tasks ORDER BY id");
  const leases = await client.query("SELECT * FROM leases ORDER BY task_id");
  const audit = await client.query("SELECT seq,actor,action,task_id,before_state,after_state,detail FROM audit_events ORDER BY seq");
  console.log(`---SNAPSHOT:${label}---`);
  console.log("TASKS", JSON.stringify(tasks.rows));
  console.log("LEASES", JSON.stringify(leases.rows));
  console.log("AUDIT", JSON.stringify(audit.rows));
}
