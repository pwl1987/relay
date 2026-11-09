// Stub Pi RPC 进程(确定性生命周期测试;真实进程+真实信号,非模型)。
// 模式(env STUB_MODE):
//   ok         prompt 后输出 assistant 文本(含 relay-handoff)+ agent_settled
//   hang       prompt 后静默(不 settle)—— 超时/取消/租约丢失测试用
//   no-handoff settled 但无 handoff 块(缺失如实记录路径)
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
      send({ type: "agent_start" });
      send({ type: "turn_start" });
      send({ type: "message_start" });
      const text =
        mode === "no-handoff"
          ? "工作完成,但没有 handoff 块。"
          : '读取完成。\n```relay-handoff\n{"status":"done","summary":"stub 完成"}\n```';
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
      send({ type: "turn_end" });
      send({ type: "agent_end" });
      send({ type: "agent_settled" });
    }, delayMs);
  }
}
