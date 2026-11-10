// 循环安全器(P0-02A C-7;修复 startGoalLoop/startSupervisorLoop `.catch(() => {})` 静默吞异常)。
// 语义:
// - 连续 tick 异常计数(成功即清零);onTickError 回调逐次可观测;
// - 连续 ≥ 阈值(默认 3)⇒ **熔断**:停止调度新 tick(circuitOpen),onCircuitOpen 回调,
//   尽力落审计(auditTickError 失败不掩盖回调 —— DB 故障时审计本就可能失败);
// - 恢复 = 新循环实例/进程重启(熔断态属进程内;事实状态全在 PostgreSQL,重启即恢复推进)。
// 单拍失败不中断既有 in-flight Promise 链;stop 等待 in-flight tick 结束。
export interface SafeLoopOptions {
  intervalMs: number;
  /** 连续异常熔断阈值(默认 3) */
  errorThreshold?: number;
  /** 每次 tick 异常回调(含连续计数) */
  onTickError?: (error: Error, consecutiveErrors: number) => void;
  /** 熔断回调(仅触发一次) */
  onCircuitOpen?: (error: Error, consecutiveErrors: number) => void;
  /** 尽力落库的审计钩子(可选;失败被吞,可观测以回调为准) */
  auditTickError?: (error: Error, consecutiveErrors: number) => Promise<unknown>;
}

export interface SafeLoopHandle {
  stop(): Promise<void>;
  /** 当前连续异常计数(成功清零) */
  consecutiveErrors(): number;
  /** 是否已熔断 */
  circuitOpen(): boolean;
}

export function startSafeLoop(tick: () => Promise<unknown>, options: SafeLoopOptions): SafeLoopHandle {
  const threshold = options.errorThreshold ?? 3;
  let stopped = false;
  let open = false;
  let errors = 0;
  let running: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped || open) return;
    running = running
      .then(() => tick())
      .then(() => {
        errors = 0;
      })
      .catch((e: Error) => {
        errors += 1;
        options.onTickError?.(e, errors);
        void options
          .auditTickError?.(e, errors)
          .catch(() => {
            /* 审计尽力而为(DB 故障场景);可观测以 onTickError/onCircuitOpen 为准 */
          });
        if (errors >= threshold) {
          open = true;
          options.onCircuitOpen?.(e, errors);
        }
      });
  }, options.intervalMs);
  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await running;
    },
    consecutiveErrors: () => errors,
    circuitOpen: () => open,
  };
}
