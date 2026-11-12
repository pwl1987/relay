// 只读视图(WEB-UX-01 §4.3 起本文件为纯再导出桶;实现按边界拆分至 src/server/views/)。
// 铁律不变:全部只含 SELECT;不产生状态、不写库、不复制第二套状态机;任何状态转移都必须
// 回到 src/core/*。拆分边界:shared(公共类型/工具)/dashboard/goal/decisions/changesets/
// projects/models-usage/system。行为不变;现有测试(console-views/console-api/web-journey)先锁。
export * from "./views/shared.ts";
export * from "./views/dashboard.ts";
export * from "./views/goal.ts";
export * from "./views/decisions.ts";
export * from "./views/changesets.ts";
export * from "./views/projects.ts";
export * from "./views/models-usage.ts";
export * from "./views/system.ts";
