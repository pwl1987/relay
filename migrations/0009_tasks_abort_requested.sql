ALTER TABLE "tasks" ADD COLUMN "abort_requested_at" timestamp with time zone;--> statement-breakpoint
-- RELAY-CONTROL-READY-03 P1-3(停止最小切片):跨进程紧急停止旗标。
-- ops.requestAbort 置旗(幂等:set-if-null)+ ABORT_REQUESTED 审计;worker 在 Run 期间以
-- 心跳轮询读取并翻转 runner cancelSignal(cancelled)⇒ SIGTERM→SIGKILL,run=CANCELLED,
-- 任务按合法转移 RUNNING→CANCELLED(租约权威不变),ABORT_CONFIRMED 审计。
