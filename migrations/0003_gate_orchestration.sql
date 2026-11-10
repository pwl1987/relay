-- P0-02A:候选变更集 / 可信证据 / Gate 绑定列(手写 SQL;0002 的 drizzle-kit 生成坑留痕:硬编码 schema 与双引号损坏)。
--> statement-breakpoint
CREATE TABLE "candidate_changesets" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL REFERENCES "tasks"("id"),
	"run_id" text NOT NULL REFERENCES "runs"("id"),
	"attempt" integer NOT NULL,
	"base_sha" text NOT NULL,
	"candidate_sha" text NOT NULL,
	"requirement_sha" text NOT NULL,
	"changed_files" jsonb NOT NULL,
	"impact_scope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "candidate_changesets_task_attempt_idx" ON "candidate_changesets" ("task_id", "attempt");
--> statement-breakpoint
CREATE TABLE "gate_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL REFERENCES "tasks"("id"),
	"attempt" integer NOT NULL,
	"candidate_sha" text NOT NULL,
	"kind" text NOT NULL,
	"passed" boolean NOT NULL,
	"raw_output" text NOT NULL,
	"env" jsonb NOT NULL,
	"content_sha256" text NOT NULL,
	"produced_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gate_evidence_binding_idx" ON "gate_evidence" ("task_id", "attempt", "candidate_sha");
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "attempt" integer;
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "candidate_sha" text;
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "requirement_sha" text;
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "test_env" jsonb;
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "reviewer_run_id" text;
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "coder_run_id" text;
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "evidence_ids" jsonb;
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "consumed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD COLUMN "consumed_by" text;
