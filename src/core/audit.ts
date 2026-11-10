// 审计写入(append-only;表级触发器阻断 UPDATE/DELETE,见 db.ts AUDIT_APPEND_ONLY_GUARD)。
// 拒绝事件同样必须落审计(B2/B3 实测语义:非持有者推进、冒充、越权都留痕)。
import { sql } from "drizzle-orm";
import type { Exec } from "./db.ts";

// OPERATOR:P0-01C 恢复动作(resolveDecision/resumeTask 等 owner/运维权威,架构 §6 授权模型)
export type AuditAuthority = "OWNER" | "SUPERVISOR" | "WORKER" | "RECONCILER" | "GATE" | "OPERATOR";

export interface AuditEvent {
  actor: string;
  authority: AuditAuthority;
  action: string;
  taskId?: string | null;
  intentId?: string | null;
  beforeState?: string | null;
  afterState?: string | null;
  detail?: Record<string, unknown> | null;
}

export async function appendAudit(exec: Exec, event: AuditEvent): Promise<number> {
  const res = await exec.execute(sql`
    INSERT INTO audit_events
      (actor, authority, action, task_id, intent_id, before_state, after_state, detail)
    VALUES (
      ${event.actor},
      ${event.authority},
      ${event.action},
      ${event.taskId ?? null},
      ${event.intentId ?? null},
      ${event.beforeState ?? null},
      ${event.afterState ?? null},
      ${event.detail === undefined || event.detail === null ? null : JSON.stringify(event.detail)}::jsonb
    )
    RETURNING seq
  `);
  return Number(res.rows[0]?.["seq"]);
}
