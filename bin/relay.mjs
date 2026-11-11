#!/usr/bin/env node
// relay 命令入口(npm bin 薄壳;零依赖)。实际实现见 src/cli.ts(裸 node strip-types 直跑)。
import { runCliMain } from "../src/cli.ts";
runCliMain(process.argv.slice(2)).catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
