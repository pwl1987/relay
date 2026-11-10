-- P0-02B:GitHub 安全交付集成 —— 三 SHA 绑定列(D-1)/交付状态(D-8)/Action Proposal(D-4)。
-- 手写 SQL(0003 同款纪律;避免 drizzle-kit 生成坑)。
--> statement-breakpoint
ALTER TABLE "candidate_changesets" ADD COLUMN "git_base_commit_sha" text;
--> statement-breakpoint
ALTER TABLE "candidate_changesets" ADD COLUMN "git_tree_sha" text;
--> statement-breakpoint
ALTER TABLE "candidate_changesets" ADD COLUMN "git_commit_sha" text;
--> statement-breakpoint
ALTER TABLE "candidate_changesets" ADD COLUMN "delivery_state" text NOT NULL DEFAULT 'NONE';
--> statement-breakpoint
ALTER TABLE "candidate_changesets" ADD COLUMN "delivery_intent_id" text;
--> statement-breakpoint
ALTER TABLE "candidate_changesets" ADD COLUMN "delivered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "candidate_changesets" ADD COLUMN "delivered_remote_head" text;
--> statement-breakpoint
CREATE TABLE "action_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL REFERENCES "tasks"("id"),
	"attempt" integer NOT NULL,
	"changeset_id" text NOT NULL UNIQUE REFERENCES "candidate_changesets"("id"),
	"gate_verdict_id" text NOT NULL,
	"capability" text NOT NULL,
	"target" text NOT NULL,
	"branch" text NOT NULL,
	"expected_remote_sha" text NOT NULL,
	"commit_sha" text NOT NULL,
	"state" text NOT NULL,
	"policy_detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "action_proposals_task_idx" ON "action_proposals" ("task_id");
