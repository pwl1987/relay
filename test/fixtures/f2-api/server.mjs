// F2 夹具:HTTP API(真实业务级边界缺陷)。
// POST /api/divide {a, b} → {result: a/b}
// 缺陷:b=0 时未做边界检查 —— 除零抛异常未捕获(uncaughtException ⇒ 500/进程崩)。
// 缺陷 2:a/b 非数字输入时结果 NaN 被序列化为 null(应 400)。
import { createServer } from "node:http";

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/divide") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { a, b } = JSON.parse(body || "{}");
      // 边界缺陷:无 b===0 / 非数字校验
      const result = a / b;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(0, "127.0.0.1", () => {
  console.log(`F2API_PORT=${server.address().port}`);
});
