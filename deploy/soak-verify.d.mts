// soak-verify.mjs 的类型声明(回归测试 import 用)
export interface SoakVerifyResult {
  completed: boolean;
  verdict: string;
  targetSeconds: number;
  samples: number;
  windowSeconds: { first: number; last: number };
  headerDuplicates: number;
  gaps: Array<{ from: number; to: number; gapSeconds: number }>;
  deadRows: Array<{ epoch: number; elapsed: number }>;
  pgAnomalies: number;
  rss: { peakKb: number; limitKb: number; ok: boolean };
  cpu: { maxPct: number };
  unexpectedTick: Array<{ elapsed: number; status: string }>;
  hardErrors: string[];
  warnings: string[];
  note: string;
}
export interface SoakLogResult {
  claimedTasks: string[];
  unexpectedClaimed: boolean;
  tickStatusCounts: Record<string, number>;
  errorTicks: string[];
}
export function verifyCsv(csvText: string, opts: { target: number; rssLimit: number; gapLimit: number }): SoakVerifyResult;
export function verifyWorkerLog(logText: string): SoakLogResult;
