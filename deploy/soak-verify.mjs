// 24h 长稳独立验证器(收口包 R-3;收口指令 §4)。
// 输入:samples.csv(epoch,elapsed_s,rss_kb,cpu_pct,alive,pg_conns,last_tick_status)+ worker.log 路径(可选)。
// 九项核验:①剔除重复表头 ②连续时间窗(目标 86400s)③全部存活采样 ④采样缺口(>gapLimit 秒)
// ⑤PG 连接异常('-' 或骤降)⑥RSS/CPU 阈值 ⑦tick 状态与意外推进(空闲观察出现 PROGRESSED 即标记)
// ⑧异常退出(alive=no)⑨意外领取(claimed 痕迹——空闲观察 tick claimed 应为 '-')。
// 原则:soak-final.json 只是初步报告;本验证器输出为核验结论;24h=空闲稳定性口径(不得称业务负载稳定)。
// 用法:node deploy/soak-verify.mjs <samples.csv> [--target 86400] [--rss-limit 400000] [--gap-limit 90]
// 退出码:0 = 无硬异常(完成与否见 verdict.completed);1 = 存在硬异常。

import { readFileSync, existsSync } from "node:fs";

function parseArgs(argv) {
  const o = { target: 86400, rssLimit: 400000, gapLimit: 90 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--target") o.target = Number(argv[++i]);
    else if (argv[i] === "--rss-limit") o.rssLimit = Number(argv[++i]);
    else if (argv[i] === "--gap-limit") o.gapLimit = Number(argv[++i]);
  }
  return o;
}

export function verifyCsv(csvText, opts) {
  const lines = csvText.trim().split("\n");
  // ①剔除重复表头(首行表头;任何后续同名表头行剔并计数)
  const header = "epoch,elapsed_s,rss_kb,cpu_pct,alive,pg_conns,last_tick_status";
  let headerDuplicates = 0;
  let rows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (l === header) {
      if (i > 0) headerDuplicates++;
      continue;
    }
    rows.push(l.split(","));
  }
  const hard = []; // 硬异常(验证失败)
  const warns = []; // 软异常(标记,不判死)
  if (rows.length === 0) {
    return { completed: false, verdict: "no_samples", samples: 0, headerDuplicates, hardErrors: ["no_samples"], warnings: [] };
  }
  const num = (s) => Number(s);
  // ③存活采样
  const deadRows = rows.filter((r) => r[4] === "no");
  if (deadRows.length > 0) hard.push(`worker_dead_rows:${deadRows.length}(首见 epoch=${deadRows[0][0]})`);
  // ④采样缺口(相邻行 elapsed 差 > gapLimit)
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const gap = num(rows[i][1]) - num(rows[i - 1][1]);
    if (gap > opts.gapLimit) gaps.push({ from: num(rows[i - 1][1]), to: num(rows[i][1]), gapSeconds: gap });
  }
  if (gaps.length > 0) hard.push(`sampling_gaps:${gaps.length}`);
  // ②完整连续时间窗
  const firstElapsed = num(rows[0][1]);
  const lastRow = rows[rows.length - 1];
  const lastElapsed = num(lastRow[1]);
  const completed = lastElapsed >= opts.target;
  if (!completed) warns.push(`observation_incomplete:${lastElapsed}/${opts.target}s`);
  // ⑤PG 连接异常('-'=采样失败;骤变检测)
  let pgAnomalies = 0;
  let prevPg = null;
  for (const r of rows) {
    const pg = r[5];
    if (pg === "-" || pg === "" ) { pgAnomalies++; continue; }
    const v = num(pg);
    if (prevPg !== null && Math.abs(v - prevPg) > 20) warns.push(`pg_conn_jump:${prevPg}->${v}@${r[1]}s`);
    prevPg = v;
  }
  if (pgAnomalies > 0) hard.push(`pg_sampling_failed_rows:${pgAnomalies}`);
  // ⑥RSS/CPU 阈值
  const rssVals = rows.map((r) => num(r[2])).filter((v) => v > 0);
  const rssPeak = rssVals.length ? Math.max(...rssVals) : 0;
  if (rssPeak > opts.rssLimit) hard.push(`rss_peak_exceeded:${rssPeak}>${opts.rssLimit}`);
  const cpuVals = rows.map((r) => num(r[3])).filter((v) => v > 0);
  const cpuMax = cpuVals.length ? Math.max(...cpuVals) : 0;
  // ⑦tick 状态与意外推进(空闲观察:PROGRESSED=意外推进;IDLE*/IDLE_PROVIDER_DOWN=预期)
  const unexpectedTick = [];
  for (const r of rows) {
    const st = r[6];
    if (st && st !== "none" && !st.startsWith("IDLE")) unexpectedTick.push({ elapsed: num(r[1]), status: st });
  }
  if (unexpectedTick.length > 0) hard.push(`unexpected_tick_rows:${unexpectedTick.length}`);
  // ⑨意外领取(空闲观察零领取;claimed 痕迹由 worker.log 核验,CSV 无该列 ⇒ 从 worker.log 扫)
  return {
    completed,
    verdict: completed && hard.length === 0
      ? "24h 空闲稳定性核验通过(空闲口径;不得宣称业务负载稳定性)"
      : completed
        ? `观察期已满但存在硬异常:${hard.join("; ")}`
        : `观察未满(${lastElapsed}/${opts.target}s)且存在硬异常或软异常`,
    targetSeconds: opts.target,
    samples: rows.length,
    windowSeconds: { first: firstElapsed, last: lastElapsed },
    headerDuplicates,
    gaps,
    deadRows: deadRows.map((r) => ({ epoch: num(r[0]), elapsed: num(r[1]) })),
    pgAnomalies,
    rss: { peakKb: rssPeak, limitKb: opts.rssLimit, ok: rssPeak <= opts.rssLimit },
    cpu: { maxPct: cpuMax },
    unexpectedTick,
    hardErrors: hard,
    warnings: warns,
    note: "本验证器输出为核验结论;soak-final.json 仅初步报告;24h=空闲稳定性口径",
  };
}

export function verifyWorkerLog(logText) {
  // ⑨意外领取 + tick 错误扫描(worker.log;空闲观察应为零 claimed)
  const claimed = [...logText.matchAll(/claimed=(?!-)(\S+)/g)].map((m) => m[1]);
  const statuses = [...logText.matchAll(/status=(\S+)/g)].map((m) => m[1]);
  const errorTicks = statuses.filter((s) => !["IDLE", "IDLE_PROVIDER_DOWN", "PROGRESSED", "PARTIAL"].includes(s));
  return {
    claimedTasks: [...new Set(claimed)],
    unexpectedClaimed: claimed.length > 0,
    tickStatusCounts: statuses.reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}),
    errorTicks,
  };
}

// CLI 入口
const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("soak-verify.mjs");
if (isMain) {
  const csv = process.argv[2];
  if (!csv || !existsSync(csv)) {
    console.error("用法:node deploy/soak-verify.mjs <samples.csv> [--target 86400] [--rss-limit 400000] [--gap-limit 90] [--log worker.log]");
    process.exit(2);
  }
  const opts = parseArgs(process.argv);
  const result = verifyCsv(readFileSync(csv, "utf8"), opts);
  const logPathIdx = process.argv.indexOf("--log");
  if (logPathIdx > 0 && existsSync(process.argv[logPathIdx + 1])) {
    result.workerLog = verifyWorkerLog(readFileSync(process.argv[logPathIdx + 1], "utf8"));
    if (result.workerLog.unexpectedClaimed) result.hardErrors.push(`unexpected_claimed_tasks:${result.workerLog.claimedTasks.join(",")}`);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.hardErrors.length > 0 ? 1 : 0);
}
