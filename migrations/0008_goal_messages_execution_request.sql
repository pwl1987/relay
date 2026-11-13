ALTER TABLE "goal_messages" ADD COLUMN "execution_request" boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- RELAY-CONTROL-READY-03 P0-1(方案 A):服务器端显式执行意图,INSERT 时落库、append-only 不可改。
-- 普通"发送"(false)=只交流/记录,永不派生 Task;显式"交给 Relay 执行"(true)=经
-- consumption/API 校验(Goal 状态/在途/幂等/权限)后才可派生受控 Task。无迁移前旧行为=旧 C 代码事实。
