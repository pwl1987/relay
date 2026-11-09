CREATE TABLE "action_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"idempotency_key" text NOT NULL,
	"capability" text NOT NULL,
	"target" text NOT NULL,
	"branch" text,
	"expected_remote_sha" text,
	"payload_sha" text,
	"state" text DEFAULT 'RESERVED' NOT NULL,
	"reconcile_rule" text DEFAULT 'CHECK_THEN_DECIDE' NOT NULL,
	"deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_intents_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"authority" text DEFAULT 'SUPERVISOR' NOT NULL,
	"action" text NOT NULL,
	"task_id" text,
	"intent_id" text,
	"before_state" text,
	"after_state" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"task_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_gate_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"commit_ref" text,
	"verdict" text NOT NULL,
	"reviewer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text,
	"state" text DEFAULT 'CREATED' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"allowed_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gate_required" boolean DEFAULT true NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_intents" ADD CONSTRAINT "action_intents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_gate_verdicts" ADD CONSTRAINT "task_gate_verdicts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE no action ON UPDATE no action;