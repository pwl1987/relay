CREATE TABLE "goal_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"actor" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "goal_messages" ADD CONSTRAINT "goal_messages_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_messages_goal_id_idx" ON "goal_messages" ("goal_id","id");--> statement-breakpoint
-- WEB-UX-03 §3:actor 只允许 USER/RELAY;kind 只允许 USER_MESSAGE/RELAY_MESSAGE。
-- append-only 会话事实:UPDATE/DELETE 由 append-only 守卫统一拦截(applyMigrations 末尾 AUDIT_APPEND_ONLY_GUARD 机制只覆盖 audit_events;
-- 本表守卫见下方独立触发器)。
ALTER TABLE "goal_messages" ADD CONSTRAINT "goal_messages_actor_check" CHECK ("actor" IN ('USER','RELAY'));--> statement-breakpoint
ALTER TABLE "goal_messages" ADD CONSTRAINT "goal_messages_kind_check" CHECK ("kind" IN ('USER_MESSAGE','RELAY_MESSAGE'));--> statement-breakpoint
CREATE FUNCTION "goal_messages_append_only_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'goal_messages is append-only (webux-03)';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "goal_messages_no_update_delete"
  BEFORE UPDATE OR DELETE ON "goal_messages"
  FOR EACH ROW EXECUTE FUNCTION "goal_messages_append_only_guard"();
