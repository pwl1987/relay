// Pi RPC 子进程客户端(ADR-0003:Worker 以 RPC 模式驱动 Pi,Pi 不拥有工作流状态)。
// 协议(实测,Pi 1.5.0 / p0-00 exp-a + P0-01B 探针):
//   stdin  JSONL: {id, type:"get_state"} | {id, type:"prompt", message}
//   stdout JSONL: {id, type:"response", command, success, data} + 事件流
//                 (agent_start/turn_start/message_start/message_end/turn_end/agent_end/
//                  agent_settled/tool_call 系)
// 结构性保证的机器校验点:agent_settled 事件 = 本轮完成;tool_call 事件计数 = 工具面观测。
import { spawn, type ChildProcess } from "node:child_process";

export interface RpcRecord {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  message?: { role?: string; content?: unknown };
  [k: string]: unknown;
}

export interface PiSpawnOptions {
  /** 完整 argv(含解释器与 cli.js 绝对路径;调用方负责版本已锁定)。 */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** 每条原始记录回调(测试/审计用)。 */
  onRecord?: (record: RpcRecord) => void;
}

export class PiRpcSession {
  private child: ChildProcess;
  private records: RpcRecord[] = [];
  private buffer = "";
  private pending = new Map<string, { resolve: (r: RpcRecord) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  readonly stdoutRecords: RpcRecord[] = [];

  readonly exited: Promise<{ code: number | null; signal: string | null; expected: boolean }>;
  private exitInfo: { code: number | null; signal: string | null; expected: boolean } = {
    code: null,
    signal: null,
    expected: false,
  };
  private exitStatusValue: { code: number | null; signal: string | null; expected: boolean } | null = null;
  private exitResolve!: (v: {
    code: number | null;
    signal: string | null;
    expected: boolean;
  }) => void;
  private killedByUs = false;

  private constructor(opts: PiSpawnOptions) {
    this.child = spawn(opts.argv[0]!, opts.argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((res) => {
      this.exitResolve = res;
    });
    this.child.stdout!.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "").trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let record: RpcRecord;
        try {
          record = JSON.parse(line) as RpcRecord;
        } catch {
          record = { type: "unparseable", raw: line };
        }
        this.records.push(record);
        this.stdoutRecords.push(record);
        opts.onRecord?.(record);
        if (record.type === "response" && record.id) {
          const p = this.pending.get(String(record.id));
          if (p) {
            this.pending.delete(String(record.id));
            p.resolve(record);
          }
        }
      }
    });
    this.child.stderr!.on("data", (d: Buffer) => {
      this.stderrText += d.toString();
    });
    this.child.once("close", (code, signal) => {
      this.exitInfo = { code, signal, expected: this.killedByUs };
      this.exitStatusValue = this.exitInfo;
      this.exitResolve(this.exitInfo);
      // 进程退出:未决请求 loud-fail(拒绝合成成功,避免掩盖 RPC 断连)
      for (const [, p] of this.pending) p.reject(new Error("rpc_process_exited"));
      this.pending.clear();
    });
  }

  stderrText = "";

  static spawn(opts: PiSpawnOptions): PiRpcSession {
    return new PiRpcSession(opts);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** 同步退出状态;null = 仍在运行。 */
  get exitStatus(): { code: number | null; signal: string | null; expected: boolean } | null {
    return this.exitStatusValue;
  }

  allRecords(): readonly RpcRecord[] {
    return this.records;
  }

  /** 相关 id 的响应(round-trip);进程已死 ⇒ loud reject(不合成成功)。 */
  async request(type: string, payload?: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcRecord> {
    if (this.exitStatus !== null) throw new Error(`rpc_process_exited before ${type}`);
    const id = `r${this.nextId++}`;
    const req = { id, type, ...payload };
    const response = new Promise<RpcRecord>((resolve2, reject2) => {
      this.pending.set(id, { resolve: resolve2, reject: reject2 });
      try {
        this.child.stdin!.write(JSON.stringify(req) + "\n");
      } catch (e) {
        this.pending.delete(id);
        reject2(new Error(`rpc_write_failed: ${(e as Error).message}`));
      }
    });
    return withTimeout(response, timeoutMs, `rpc request ${type} timeout`);
  }

  async prompt(message: string, timeoutMs = 15_000): Promise<RpcRecord> {
    return this.request("prompt", { message }, timeoutMs);
  }

  /** 等待 agent_settled;返回终止原因。deadline 到点由调用方 kill(这里只观察)。 */
  async waitSettled(deadlineMs: number): Promise<"settled" | "process_exited" | "deadline"> {
    const t0 = Date.now();
    for (;;) {
      if (this.records.some((r) => r.type === "agent_settled")) return "settled";
      if (this.exitStatus !== null) return "process_exited";
      if (Date.now() - t0 >= deadlineMs) return "deadline";
      await sleep(100);
    }
  }

  /** 是否发生过工具调用事件(空工具面校验点;受控扩展的调用也走事件流)。 */
  countToolCallEvents(): number {
    return this.records.filter((r) => String(r.type || "").includes("tool_call")).length;
  }

  /** 最后一条 assistant 消息的纯文本。 */
  assistantText(): string {
    return this.records
      .filter((r) => r.type === "message_end" && r.message?.role === "assistant")
      .map((r) =>
        Array.isArray(r.message?.content)
          ? (r.message!.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("")
          : "",
      )
      .join("\n")
      .trim();
  }

  /** 发信号;expected=true 标记"我方主动终止"(超时/取消/断连处置)。 */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.killedByUs = true;
    try {
      this.child.kill(signal);
    } catch {
      /* 已死 */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve2, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve2(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
