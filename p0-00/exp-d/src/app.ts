// P0-00 实验 D:DBOS v5.4.0 durable workflow 对比应用(实验代码,非产品实现)。
// 注:v3.5.8 需要额外 datasource 包且 npm 无独立 pg 实现;v5 的用户库同样以 ORM datasource
// 为主(DBOSConfig 仅存 systemDatabaseUrl),实验改用 workflow + step(自带 pg Pool),
// 聚焦 durable 执行核心语义(同 ID 去重、崩溃恢复、任务级单写者缺口)。API 摩擦点作为
// ADR-0007 对比证据记录:v3→v5 破坏性变更、Context 类型不导出、装饰方法调用需 as any。
// 模式:
//   setup                          建任务表(复用实验 B schema)
//   d1 <workflowID> <task>         同一 workflowID 并发启动两次 → 观察去重/冲突语义
//   d2a <workflowID> <task>        启动含 15s durable sleep 的 workflow(供父进程 SIGKILL)
//   d2b <workflowID>               重启后 launch() 自动恢复,retrieve 等待最终结果
//   d3 <task>                      两个不同 workflowID 并发处理同一任务 → 观察任务级单写者
import { DBOS } from "@dbos-inc/dbos-sdk";
import pg from "pg";
import { readFileSync } from "node:fs";

const DB = process.env.RELAY_P000_PG ?? "postgresql://postgres:relayp000local@127.0.0.1:55433/relayp000";
const pool = new pg.Pool({ connectionString: DB, max: 4 });

export class TaskSteps {
	// 原子 claim:单条 UPDATE 决定成败(与实验 B 的 SQL 语义对齐,但无显式租约/fencing)
	@DBOS.step()
	static async claimTask(taskId: string, worker: string) {
		console.error(`[claimTask] received taskId=${JSON.stringify(taskId)} worker=${JSON.stringify(worker)}`);
		const c = await pool.connect();
		try {
			const probe = await c.query("SELECT id,state FROM tasks WHERE id=$1", [taskId]);
			console.error(`[claimTask] probe=${JSON.stringify(probe.rows)} rowCount=${probe.rowCount}`);
			const r = await c.query(
				`UPDATE tasks SET state='LEASED', state_version=state_version+1, updated_at=now()
				 WHERE id=$1 AND state='READY' RETURNING id`,
				[taskId],
			);
			if (r.rowCount === 0) return { ok: false, reason: "not_ready_or_claimed" };
			await c.query(
				`INSERT INTO audit_events (actor,action,task_id,before_state,after_state,detail)
				 VALUES ($1,'DBOS_CLAIM',$2,'READY','LEASED','{"via":"dbos-step"}')`,
				[worker, taskId],
			);
			return { ok: true };
		} finally {
			c.release();
		}
	}

	@DBOS.step()
	static async markRunning(taskId: string, worker: string) {
		const c = await pool.connect();
		try {
			await c.query(`UPDATE tasks SET state='RUNNING', state_version=state_version+1, updated_at=now() WHERE id=$1 AND state='LEASED'`, [taskId]);
			await c.query(
				`INSERT INTO audit_events (actor,action,task_id,before_state,after_state,detail)
				 VALUES ($1,'DBOS_MARK_RUNNING',$2,'LEASED','RUNNING','{}')`,
				[worker, taskId],
			);
			return { ok: true };
		} finally {
			c.release();
		}
	}

	@DBOS.step()
	static async markAccepted(taskId: string, worker: string) {
		const c = await pool.connect();
		try {
			await c.query(`UPDATE tasks SET state='ACCEPTED', state_version=state_version+1, updated_at=now() WHERE id=$1 AND state='RUNNING'`, [taskId]);
			await c.query(
				`INSERT INTO audit_events (actor,action,task_id,before_state,after_state,detail)
				 VALUES ($1,'DBOS_MARK_ACCEPTED',$2,'RUNNING','ACCEPTED','{}')`,
				[worker, taskId],
			);
			return { ok: true };
		} finally {
			c.release();
		}
	}
}

export class TaskFlows {
	@DBOS.workflow()
	static async processTask(taskId: string, worker: string, holdMs: number) {
		const claim = await (TaskSteps.claimTask as any)(taskId, worker);
		if (!claim.ok) return claim.reason;
		await (TaskSteps.markRunning as any)(taskId, worker);
		await DBOS.sleep(holdMs); // durable sleep:恢复时不重复已执行步骤
		await (TaskSteps.markAccepted as any)(taskId, worker);
		return "ACCEPTED";
	}
}

async function main() {
	const [mode, ...args] = process.argv.slice(2);
	if (mode === "setup") {
		const c = await pool.connect();
		await c.query(readFileSync(new URL("../schema-b.sql", import.meta.url), "utf8"));
		for (const id of ["t-d1", "t-d2", "t-d3"]) {
			await c.query(
				`INSERT INTO tasks (id, state) VALUES ($1,'READY')
				 ON CONFLICT (id) DO UPDATE SET state='READY', state_version=0, updated_at=now()`,
				[id],
			);
			await c.query("DELETE FROM leases WHERE task_id=$1", [id]);
		}
		c.release();
		console.log(JSON.stringify({ ok: true, setup: true }));
		await pool.end();
		return;
	}

	DBOS.setConfig({ name: "relay-p000-exp-d", systemDatabaseUrl: DB, runAdminServer: false, logLevel: "WARN" });
	await DBOS.launch();

	try {
		switch (mode) {
			case "d1": {
				const [wfID, task] = args;
				const p1 = ((DBOS.startWorkflow(TaskFlows as any, { workflowID: wfID }) as any).processTask(task, "dbos-A", 100));
				const p2 = ((DBOS.startWorkflow(TaskFlows as any, { workflowID: wfID }) as any).processTask(task, "dbos-B", 100));
				const [r1, r2] = await Promise.allSettled([p1, p2]);
				console.log(JSON.stringify({
					mode: "d1",
					p1: r1.status === "fulfilled" ? await r1.value.getResult() : `REJECTED:${(r1.reason as Error).message}`,
					p2: r2.status === "fulfilled" ? await r2.value.getResult() : `REJECTED:${(r2.reason as Error).message}`,
				}));
				break;
			}
			case "d2a": {
				const [wfID, task] = args;
				const h = await ((DBOS.startWorkflow(TaskFlows as any, { workflowID: wfID }) as any).processTask(task, "dbos-A", 15000));
				console.log(JSON.stringify({ mode: "d2a", started: wfID }));
				await h.getResult(); // 等待直至被父进程 SIGKILL(处于 durable sleep 中)
				break;
			}
			case "d2b": {
				const [wfID] = args;
				const h = DBOS.retrieveWorkflow(wfID);
				const result = await h.getResult();
				console.log(JSON.stringify({ mode: "d2b", wfID, result, status: await h.getStatus() }));
				break;
			}
			case "d3": {
				const [task] = args;
				const p1 = ((DBOS.startWorkflow(TaskFlows as any, { workflowID: `${task}-wf-x` }) as any).processTask(task, "dbos-X", 100));
				const p2 = ((DBOS.startWorkflow(TaskFlows as any, { workflowID: `${task}-wf-y` }) as any).processTask(task, "dbos-Y", 100));
				const [r1, r2] = await Promise.allSettled([p1, p2]);
				console.log(JSON.stringify({
					mode: "d3",
					x: r1.status === "fulfilled" ? await r1.value.getResult() : `REJECTED:${(r1.reason as Error).message}`,
					y: r2.status === "fulfilled" ? await r2.value.getResult() : `REJECTED:${(r2.reason as Error).message}`,
				}));
				break;
			}
			default:
				console.error("unknown mode", mode);
				process.exitCode = 2;
		}
	} finally {
		await DBOS.shutdown();
		await pool.end();
	}
}

main().catch((e) => {
	console.error("FATAL", e?.message ?? e);
	process.exit(1);
});
