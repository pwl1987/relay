// 收口包 R-3:24h 长稳独立验证器回归(合成 CSV 九项核验;不读真实 soak 数据)。
import { describe, expect, it } from "vitest";
import { verifyCsv, verifyWorkerLog } from "../../deploy/soak-verify.mjs";

const HEADER = "epoch,elapsed_s,rss_kb,cpu_pct,alive,pg_conns,last_tick_status";
function csv(rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}
// 正常行工厂:每 60s 一行,alive=yes,RSS 110000,pg=1,IDLE_PROVIDER_DOWN
let clock = 1000000;
function goodRow(): string {
  clock += 60;
  return `${clock},${clock - 1000000},110000,0.5,yes,1,IDLE_PROVIDER_DOWN`;
}

describe("R-3:soak-verify 独立验证器回归", () => {
  it("①重复表头剔除:后续同名表头行剔除并计数", () => {
    const r = verifyCsv(csv([goodRow(), HEADER, goodRow(), HEADER, goodRow()]), { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(r.headerDuplicates).toBe(2);
    expect(r.samples).toBe(3);
  });

  it("②完整时间窗:≥target 判 completed;未满给观察未满警告(不写 PASS)", () => {
    clock = 1000000;
    const full = csv(Array.from({ length: 1440 }, () => goodRow())); // 1440*60s = 24h
    const rFull = verifyCsv(full, { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(rFull.completed).toBe(true);
    expect(rFull.verdict).toContain("空闲稳定性核验通过");
    expect(rFull.verdict).toContain("不得宣称业务负载稳定性");
    clock = 1000000;
    const partial = csv(Array.from({ length: 10 }, () => goodRow()));
    const rPart = verifyCsv(partial, { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(rPart.completed).toBe(false);
    expect(rPart.verdict).toContain("观察未满");
  });

  it("④采样缺口:>gapLimit 判硬异常", () => {
    clock = 1000000;
    const rows = [goodRow(), goodRow()];
    clock += 300; // 人为 5 分钟缺口
    rows.push(goodRow());
    const r = verifyCsv(csv(rows), { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(r.gaps.length).toBe(1);
    expect(r.hardErrors.join(";")).toContain("sampling_gaps:1");
  });

  it("③⑧进程死亡:alive=no 判硬异常", () => {
    clock = 1000000;
    const rows = [goodRow(), goodRow(), `${clock + 60},${clock + 60 - 1000000},110000,0,yes,1,IDLE_PROVIDER_DOWN`, `${clock + 120},${clock + 120 - 1000000},0,0,no,1,none`];
    const r = verifyCsv(csv(rows), { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(r.deadRows.length).toBe(1);
    expect(r.hardErrors.join(";")).toContain("worker_dead_rows:1");
  });

  it("⑤PG 采样失败列('-')判硬异常;连接数骤变给警告", () => {
    clock = 1000000;
    const rows = [goodRow(), `${clock},${clock - 1000000},110000,0.5,yes,-,IDLE_PROVIDER_DOWN`, `${clock},${clock - 1000000},110000,0.5,yes,50,IDLE_PROVIDER_DOWN`];
    const r = verifyCsv(csv(rows), { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(r.pgAnomalies).toBe(1);
    expect(r.warnings.join(";")).toContain("pg_conn_jump");
  });

  it("⑥RSS 超阈值判硬异常;阈值内通过", () => {
    clock = 1000000;
    const over = csv([`${clock},${clock - 1000000},450000,0.5,yes,1,IDLE_PROVIDER_DOWN`]);
    const rOver = verifyCsv(over, { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(rOver.rss.peakKb).toBe(450000);
    expect(rOver.hardErrors.join(";")).toContain("rss_peak_exceeded");
    const under = csv([`${clock},${clock - 1000000},118000,0.5,yes,1,IDLE_PROVIDER_DOWN`]);
    expect(verifyCsv(under, { target: 86400, rssLimit: 400000, gapLimit: 90 }).rss.ok).toBe(true);
  });

  it("⑦空闲观察出现 PROGRESSED=意外推进(硬异常);IDLE_* 白名单通过", () => {
    clock = 1000000;
    const r = verifyCsv(csv([goodRow(), `${clock},${clock - 1000000},110000,0.5,yes,1,PROGRESSED`]), { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(r.unexpectedTick.length).toBe(1);
    expect(r.hardErrors.join(";")).toContain("unexpected_tick_rows:1");
    const ok = verifyCsv(csv([goodRow()]), { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(ok.unexpectedTick.length).toBe(0);
  });

  it("⑨worker.log 意外领取扫描:claimed=- 通过;非 '-' 标记", () => {
    const clean = verifyWorkerLog("[relay-worker] tick status=IDLE_PROVIDER_DOWN claimed=- at=T\n");
    expect(clean.unexpectedClaimed).toBe(false);
    const dirty = verifyWorkerLog("[relay-worker] tick status=PROGRESSED claimed=task-1 at=T\n");
    expect(dirty.unexpectedClaimed).toBe(true);
    expect(dirty.claimedTasks).toEqual(["task-1"]);
  });

  it("空 CSV:no_samples 硬异常;CLI 语义:硬异常 ⇒ exit 1(由 main 分支保证)", () => {
    const r = verifyCsv("", { target: 86400, rssLimit: 400000, gapLimit: 90 });
    expect(r.verdict).toBe("no_samples");
    expect(r.hardErrors).toContain("no_samples");
  });
});
