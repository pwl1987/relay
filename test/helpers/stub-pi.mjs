// Stub Pi RPC 进程(确定性生命周期测试;真实进程+真实信号,非模型)。
// 模式(env STUB_MODE):
//   ok         prompt 后输出 assistant 文本(含 relay-handoff)+ agent_settled
//   hang       prompt 后静默(不 settle)—— 超时/取消/租约丢失测试用
//   no-handoff settled 但无 handoff 块(缺失如实记录路径)
//   chatty      多回合 assistant message_end(模拟工具往返)后再 settle(回合硬顶测试)
//   with-tools settled 且发出 tool_call/tool_result 事件(Worker 侧持久化断言)
//   usage      message_end 携带 usage(token 实测核算路径)
//   exit-mid   prompt 后立即退出(断连路径)
// 另:写 STUB_PID_FILE(进程死亡断言);stdin 关闭(父进程被杀)即退出。
import { writeFileSync } from "node:fs";

const mode = process.env.STUB_MODE ?? "ok";
const delayMs = Number(process.env.STUB_DELAY_MS ?? "150");
if (process.env.STUB_PID_FILE) writeFileSync(process.env.STUB_PID_FILE, String(process.pid));

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    handle(req);
  }
});
process.stdin.on("close", () => process.exit(0));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(req) {
  if (req.type === "get_state") {
    send({ id: req.id, type: "response", command: "get_state", success: true, data: { model: { id: "stub" } } });
    return;
  }
  if (req.type === "prompt") {
    send({ id: req.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    if (mode === "exit-mid") {
      setTimeout(() => process.exit(9), 30);
      return;
    }
    setTimeout(() => {
      if (mode === "hang") return; // 永不 settle
      if (mode === "chatty") {
        // 5 个 assistant 回合(每回合一条 message_end),之后才 settle —— 回合硬顶应在 cap 处止损
        const turns = Number(process.env.STUB_TURNS ?? "5");
        let n = 0;
        const timer = setInterval(() => {
          n += 1;
          send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `回合 ${n}` }] } });
          if (n >= turns) {
            clearInterval(timer);
            send({ type: "agent_settled" });
          }
        }, 120);
        return;
      }
      if (mode === "with-tools") {
        send({ type: "tool_call", name: "relay_read", params: { path: "brief.txt" } });
        send({ type: "tool_result", name: "relay_read", denied: false });
        send({ type: "tool_call", name: "relay_read", params: { path: "/etc/passwd" } });
        send({ type: "tool_result", name: "relay_read", denied: true, reason: "outside_allowed_root" });
      }
      send({ type: "agent_start" });
      send({ type: "turn_start" });
      send({ type: "message_start" });
      const text =
        mode === "no-handoff"
          ? "工作完成,但没有 handoff 块。"
          : '读取完成。\n```relay-handoff\n{"status":"done","summary":"stub 完成"}\n```';
      const msg = { role: "assistant", content: [{ type: "text", text }] };
      if (process.env.STUB_USAGE === "1") {
        msg.usage = { input: 1234, output: 567 };
      }
      send({ type: "message_end", message: msg });
      send({ type: "turn_end" });
      send({ type: "agent_end" });
      send({ type: "agent_settled" });
    }, delayMs);
  }
}
