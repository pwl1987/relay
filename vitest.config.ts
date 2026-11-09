import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 集成测试含真实故障注入(SIGKILL/等待租约过期),需要顺序与时间裕量
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
    fileParallelism: false,
  },
});
