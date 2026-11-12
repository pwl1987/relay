CREATE TABLE "goal_message_consumptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" bigint NOT NULL,
	"goal_id" text NOT NULL,
	"task_id" text NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_message_consumptions_message_id_unique" UNIQUE("message_id")
);--> statement-breakpoint
ALTER TABLE "goal_message_consumptions" ADD CONSTRAINT "goal_message_consumptions_message_id_goal_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "goal_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_message_consumptions" ADD CONSTRAINT "goal_message_consumptions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_message_consumptions" ADD CONSTRAINT "goal_message_consumptions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_message_consumptions_goal_id_idx" ON "goal_message_consumptions" ("goal_id","id");--> statement-breakpoint
-- WEB-UX-03C §0.1:append-only 映射事实(message → 派生执行任务)。
-- UNIQUE(message_id) 是 at-most-once 的数据库级证明:同一 USER_MESSAGE 最多派生一次执行任务;
-- 重启/重复 tick/重试落入 UNIQUE 冲突 ⇒ 事务回滚,绝不重复派生。
-- 不复制 Task 状态;goal_messages 保持会话事实,本表保持消费映射,均 append-only。
CREATE FUNCTION "goal_message_consumptions_append_only_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'goal_message_consumptions is append-only (webux-03 03B.1)';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "goal_message_consumptions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "goal_message_consumptions"
  FOR EACH ROW EXECUTE FUNCTION "goal_message_consumptions_append_only_guard"();
