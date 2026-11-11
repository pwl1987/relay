#!/usr/bin/env bash
# R-3 期满终验 runner(最终收口轮合同 CURRENT.md §3)。
# 职责:setsid detached 脱离会话进程组(防会话解体连坐——2026-11-12 06:05 教训);到期后运行独立验证器**一次**,
# 保存权威快照(唯一终版快照,避免多份运行读数歧义——REVIEW 附审 Minor-m1 教训)。
# 只读边界:不触碰 git、不动两采集进程、不改 CSV/日志/start-epoch;只写快照与本 runner 日志。
set -u
cd "$(dirname "$0")/../.."   # 仓库根
LOG=p0-mvp/soak-24h/final-runner.log
# TARGET = start-epoch 1794389572 + 86400 = 1794475972(2026-11-12 17:32:52+0800 期满)+ 128s 边距
# 边距用途:采样相位在每分钟 :41s,首个 elapsed>=86400 的样本在 17:33:41(elapsed≈86449),
# 采样器随后自写 soak-final.json 并退出;17:35:00 起跑验证器确保末样本与 final 均已落盘。
TARGET=1794476100
echo "RUNNER start $(date -Is) target_epoch=$TARGET (期满=1794475972=2026-11-12T17:32:52+08:00)" >> "$LOG"
while [ "$(date +%s)" -lt "$TARGET" ]; do sleep 120; done
ts=$(TZ=Asia/Shanghai date '+%Y%m%dT%H%M+0800')
echo "RUNNER fire $(date -Is) ts=$ts" >> "$LOG"
node deploy/soak-verify.mjs p0-mvp/soak-24h/samples.csv --log p0-mvp/soak-24h/worker.log \
  > "p0-mvp/soak-24h/verify-final-${ts}.json" 2> "p0-mvp/soak-24h/verify-final-${ts}.stderr.txt"
rc=$?
echo "RUNNER verify exit=$rc ts=$ts(缝在⇒硬异常 sampling_gaps:1⇒exit 1 为预期;判定权在 REVIEW)" >> "$LOG"
{
  echo "--- fire-time state $(date -Is)"
  test -f p0-mvp/soak-24h/soak-final.json && echo "soak-final.json: present" || echo "soak-final.json: ABSENT"
  echo "worker 810994 / sampler 811916 进程状态:"
  ps -o pid,stat,etime -p 810994,811916 2>/dev/null || echo "  (均已退出)"
  echo "last csv row: $(tail -1 p0-mvp/soak-24h/samples.csv)"
  echo "csv lines: $(wc -l < p0-mvp/soak-24h/samples.csv)"
} >> "$LOG"
echo "RUNNER done $(date -Is)" >> "$LOG"
