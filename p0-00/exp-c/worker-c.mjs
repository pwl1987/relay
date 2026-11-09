// P0-00 实验 C:worker CLI(实验代码)。
// 用法:
//   node worker-c.mjs reset <srcDir> <remoteUrl>   重建表与审计,输出远端 HEAD
//   node worker-c.mjs reserve <intentId> <taskId> <key> <remoteUrl> <branch> <expectedSha> <payloadSha>
//   node worker-c.mjs execute <intentId> <sleepMsAfterPush>   [RELAY_C_SRC 必须设置]
//   node worker-c.mjs reconcile <intentId>
//   node worker-c.mjs intent <intentId>            打印意图当前状态
import { connect, reserveIntent, executeIntent, reconcileIntent, remoteHead, audit } from "./reconcile.mjs";

const [cmd, ...a] = process.argv.slice(2);
const client = await connect();

switch (cmd) {
  case "reset": {
    const fs = await import("node:fs/promises");
    await client.query(await fs.readFile(new URL("./schema-c.sql", import.meta.url), "utf8"));
    await client.query("DELETE FROM action_intents");
    const head = remoteHead(a[1], "main");
    await audit(client, "operator", "C_RESET", { task_id: "t-c", remoteHead: head });
    console.log(JSON.stringify({ ok: true, remoteHead: head }));
    break;
  }
  case "reserve": {
    const [id, taskId, key, remoteUrl, branch, expectedSha, payloadSha] = a;
    await reserveIntent(client, { id, taskId, key, remoteUrl, branch, expectedSha, payloadSha });
    console.log(JSON.stringify({ ok: true, reserved: id }));
    break;
  }
  case "execute": {
    const r = await executeIntent(client, a[0], Number(a[1] ?? 0));
    console.log(JSON.stringify({ op: "execute", ...r }));
    break;
  }
  case "reconcile": {
    const r = await reconcileIntent(client, a[0]);
    console.log(JSON.stringify({ op: "reconcile", ...r }));
    break;
  }
  case "intent": {
    const r = await client.query("SELECT id,state,expected_remote_sha,payload_sha FROM action_intents WHERE id=$1", [a[0]]);
    console.log(JSON.stringify(r.rows[0]));
    break;
  }
  default:
    console.error("unknown command", cmd);
    process.exit(2);
}
await client.end();
