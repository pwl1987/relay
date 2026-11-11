-- REWORK-1/US-02 P0 最小:Discovery 记录表(结果持久化,不依赖聊天上下文;失败行如实保留 reason,不伪造成功)。
-- 注:0003/0004 为手工迁移且未同步 drizzle snapshot ⇒ 本次 generate 曾产出全量 diff;
--     本文件仅含 discoveries 增量(与既有手工迁移同模式),snapshot 已重新对齐(后续 generate 增量正确)。
CREATE TABLE "discoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"run_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"report" jsonb,
	"content_sha256" text,
	"model_ref" text NOT NULL,
	"sandbox" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discoveries" ADD CONSTRAINT "discoveries_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE no action ON UPDATE no action;
