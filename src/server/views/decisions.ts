// 只读视图·Decision Inbox(WEB-UX-01 §4.3 自 src/server/views.ts 拆分;行为不变;只含 SELECT)。
import { sql } from "drizzle-orm";
import type { RelayDb } from "../../core/db.ts";
import { isLegalTransition } from "../../core/lifecycle.ts";
import {
  iso,
  num,
  str,
  json,
  type Row,
  type DecisionView,
  decisionGuidance,
  TIMEOUT_BEHAVIOR,
} from "./shared.ts";

export async function decisionListView(db: RelayDb): Promise<DecisionView[]> {
  const exec = db as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: Row[] }> };
  const rows = await exec.execute(sql`
    SELECT d.id, d.task_id, d.goal_id, d.level, d.question, d.fallback, d.deadline, d.state,
           d.verdict, d.decided_by, d.decided_at, d.created_at,
           t.state AS task_state, t.state_version, t.blocked_reason
    FROM decisions d LEFT JOIN tasks t ON t.id = d.task_id
    ORDER BY (d.state IN ('OPEN','EXPIRED_STILL_BLOCKED')) DESC, d.level ASC, d.deadline ASC NULLS LAST, d.created_at ASC
  `);
  const csRows = await exec.execute(sql`
    SELECT task_id, changed_files FROM candidate_changesets
    WHERE task_id IN (SELECT DISTINCT task_id FROM decisions WHERE task_id IS NOT NULL)
  `);
  const filesByTask = new Map<string, string[]>();
  for (const r of csRows.rows) {
    const tid = str(r["task_id"]);
    const diff = json<{ added?: string[]; modified?: string[]; removed?: string[] }>(r["changed_files"], {});
    filesByTask.set(tid, [...(diff.added ?? []), ...(diff.modified ?? []), ...(diff.removed ?? [])]);
  }
  return rows.rows.map((r) => {
    const level = str(r["level"]);
    const state = str(r["state"]);
    const pending = state === "OPEN" || state === "EXPIRED_STILL_BLOCKED";
    const taskState = r["task_state"] === null || r["task_state"] === undefined ? null : str(r["task_state"]);
    const legal = taskState ? isLegalTransition(taskState, "READY") : false;
    const tid = r["task_id"] === null ? null : str(r["task_id"]);
    return {
      id: str(r["id"]),
      taskId: tid,
      goalId: r["goal_id"] === null ? null : str(r["goal_id"]),
      level,
      question: str(r["question"]),
      fallback: json<Record<string, unknown> | null>(r["fallback"], null),
      deadline: iso(r["deadline"]),
      state,
      verdict: json<Record<string, unknown> | null>(r["verdict"], null),
      decidedBy: r["decided_by"] === null ? null : str(r["decided_by"]),
      decidedAt: iso(r["decided_at"]),
      createdAt: iso(r["created_at"]) ?? "",
      taskState,
      taskStateVersion: r["state_version"] === null || r["state_version"] === undefined ? null : num(r["state_version"]),
      timeoutBehavior: TIMEOUT_BEHAVIOR[level] ?? "未登记",
      affectedFiles: tid ? filesByTask.get(tid) ?? [] : [],
      reversible: level === "D3",
      canApprove: pending && level !== "D4" && legal,
      canReject: pending && level !== "D4",
      canDefer: pending && level !== "D4",
      guidance: decisionGuidance({
        level,
        question: str(r["question"]),
        fallback: json<Record<string, unknown> | null>(r["fallback"], null),
        taskState,
        blockedReason: r["blocked_reason"] === null || r["blocked_reason"] === undefined ? null : str(r["blocked_reason"]),
        deadline: iso(r["deadline"]),
        reversible: level === "D3",
      }),
    };
  });
}
