// Gate 裁决写入(V08 最小门锁)。完整 Gate 编排(证据绑定 commit/environment)属 P0-02A;
// P0-01A 只承载状态层语义:VERIFYING->ACCEPTED 必须存在本表 PASS 记录(gate_required=true 时)。
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Exec } from "./db.ts";
import { appendAudit } from "./audit.ts";

export type GateVerdict = "PASS" | "REWORK" | "BLOCK";

export async function recordGateVerdict(
  exec: Exec,
  spec: {
    taskId: string;
    verdict: GateVerdict;
    reviewer: string;
    commitRef?: string | null;
    id?: string;
  },
): Promise<{ id: string }> {
  const id = spec.id ?? `gate-${randomUUID()}`;
  const res = await exec.execute(sql`
    INSERT INTO task_gate_verdicts (id, task_id, commit_ref, verdict, reviewer)
    VALUES (${id}, ${spec.taskId}, ${spec.commitRef ?? null}, ${spec.verdict}, ${spec.reviewer})
    RETURNING id
  `);
  const finalId = String(res.rows[0]!["id"]);
  await appendAudit(exec, {
    actor: spec.reviewer,
    authority: "GATE",
    action: `GATE_${spec.verdict}`,
    taskId: spec.taskId,
    detail: { verdict: spec.verdict, commitRef: spec.commitRef ?? null, gateId: finalId },
  });
  return { id: finalId };
}
