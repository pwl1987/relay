// P0-00 实验 C:外部副作用两阶段动作 + Reconcile(实验代码,非产品实现)。
// 外部动作 = git push 到本地 bare 仓库(mock remote);真实故障注入 = SIGKILL。
import pg from "pg";
import { execFileSync } from "node:child_process";

export const DB = process.env.RELAY_P000_PG ?? "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000";

export async function connect() {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  return c;
}

export function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function remoteHead(remoteUrl, branch) {
  const out = execFileSync("git", ["ls-remote", remoteUrl, `refs/heads/${branch}`], { encoding: "utf8" }).trim();
  return out.split(/\s+/)[0] ?? "";
}

export async function audit(client, actor, action, detail) {
  await client.query(
    `INSERT INTO audit_events (actor, action, task_id, before_state, after_state, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor, action, detail.task_id ?? null, detail.before ?? null, detail.after ?? null,
     JSON.stringify({ ...detail, task_id: undefined, before: undefined, after: undefined })],
  );
}

// 阶段 1:预留意图(executor 之前)。返回 intent id。
export async function reserveIntent(client, { id, taskId, key, remoteUrl, branch, expectedSha, payloadSha }) {
  await client.query(
    `INSERT INTO action_intents (id, task_id, idempotency_key, action, remote_url, branch,
       expected_remote_sha, payload_sha, state)
     VALUES ($1,$2,$3,'git_push',$4,$5,$6,$7,'RESERVED')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [id, taskId, key, remoteUrl, branch, expectedSha, payloadSha],
  );
  await audit(client, "worker", "INTENT_RESERVED", { task_id: taskId, intent: id, expectedSha, payloadSha });
}

// 阶段 2:执行。执行前先核对远端真实状态(C3 的远端漂移在此被拒)。
// push 成功后进程将在此停留(sleep),由父进程注入"回执丢失"故障。
export async function executeIntent(client, intentId, sleepMsAfterPush) {
  const r = await client.query("SELECT * FROM action_intents WHERE id=$1", [intentId]);
  const intent = r.rows[0];
  if (!intent) throw new Error(`intent not found: ${intentId}`);
  const actual = remoteHead(intent.remote_url, intent.branch);
  if (actual !== intent.expected_remote_sha) {
    await client.query("UPDATE action_intents SET state='CONFLICT', updated_at=now() WHERE id=$1", [intentId]);
    await audit(client, "executor", "EXECUTE_CONFLICT", {
      task_id: intent.task_id, intent: intentId,
      expected: intent.expected_remote_sha, actual,
      decision: "REJECT_NO_FORCE_PUSH",
    });
    return { ok: false, reason: "remote_drift", actual };
  }
  await client.query("UPDATE action_intents SET state='EXECUTING', updated_at=now() WHERE id=$1", [intentId]);
  await audit(client, "executor", "EXECUTE_START", { task_id: intent.task_id, intent: intentId });
  // 受控故障注入点:push 前停顿(供 C2 在"执行前"窗口注入 kill;生产路径为 0)
  const prePushMs = Number(process.env.RELAY_C_PRE_PUSH_MS ?? 0);
  if (prePushMs > 0) await new Promise((res) => setTimeout(res, prePushMs));
  git(process.env.RELAY_C_SRC, "push", intent.remote_url, `${intent.payload_sha}:refs/heads/${intent.branch}`);
  // —— 外部副作用已发生;以下"回执"尚未写库 ——
  await new Promise((res) => setTimeout(res, sleepMsAfterPush));
  await client.query("UPDATE action_intents SET state='COMPLETED', updated_at=now() WHERE id=$1", [intentId]);
  await audit(client, "executor", "EXECUTE_COMPLETED", { task_id: intent.task_id, intent: intentId });
  return { ok: true };
}

// 阶段 3:恢复。结果未知时必须先查询远端真实状态,再决策;绝不盲目重放。
export async function reconcileIntent(client, intentId) {
  const r = await client.query("SELECT * FROM action_intents WHERE id=$1", [intentId]);
  const intent = r.rows[0];
  if (!intent) throw new Error(`intent not found: ${intentId}`);
  if (intent.state === "COMPLETED") return { decision: "already_completed" };
  const actual = remoteHead(intent.remote_url, intent.branch);
  let decision;
  if (actual === intent.payload_sha) {
    decision = "SIDE_EFFECT_CONFIRMED";
    await client.query("UPDATE action_intents SET state='COMPLETED', updated_at=now() WHERE id=$1", [intentId]);
  } else if (actual === intent.expected_remote_sha) {
    decision = "SIDE_EFFECT_ABSENT_REEXECUTE_SAFE";
  } else {
    decision = "REMOTE_MOVED_NEEDS_HUMAN";
  }
  await audit(client, "reconciler", "RECONCILE", {
    task_id: intent.task_id, intent: intentId, intentState: intent.state,
    actualRemoteHead: actual, payloadSha: intent.payload_sha, expectedSha: intent.expected_remote_sha,
    decision,
  });
  return { decision, actualRemoteHead: actual };
}
