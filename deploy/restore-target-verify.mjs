// 恢复目标真实身份校验(RELAY-RESTORE-TARGET-09R;fail-closed 单一入口)。
// 背景(协调方 Major-R1 两绕过实证):restore-verify.sh 旧守卫仅做 RELAY_DB_URL/RESTORE_URL 字符串前缀
// 比较,127.0.0.1 与 localhost 等同实例别名可绕过;docker 回退分支完全忽略 RESTORE_URL 的 host/port,
// RELAY_RESTORE_CONTAINER 指向源容器/任意容器即被盲信。本脚本在任何 DROP/CREATE/导入之前证明:
//   ① 文本层:两连接串规范化实例键(回环折叠 localhost/127.*/::1 + 默认端口 5432 + 剥 query/fragment)
//      相同 ⇒ 拒绝(同实例别名/端口缺省形态);
//   ② 执行面绑定(docker 回退分支):docker inspect 恢复容器严格校验(运行中 + 5432/tcp 恰一条映射 +
//      HostIp=127.0.0.1 + HostPort==RESTORE_URL 端口)⇒ 声明目标与物理执行容器绑定;RESTORE_URL 必须
//      回环;显式 RELAY_PG_CONTAINER(源容器)与恢复容器同名/同容器 ID ⇒ 拒绝(容器名欺骗);
//   ③ 真值层:pg 直连源 URL 与目标 URL 读服务端身份(pg_postmaster_start_time + inet_server_port,
//      零原始数据查询);任一失败 ⇒ 无法证明隔离 ⇒ 拒绝;身份相同 ⇒ 同一物理实例 ⇒ 拒绝(任意别名/
//      同集群在服务端真值识别,不依赖连接串文本)。
// 仅读元数据;消息脱敏(零密码);校验失败 exit 2,调用方(restore-verify.sh)据此在任何 DDL 前拒绝。
import { readFileSync } from "node:fs";
import pg from "pg";
import { redactDbUrl } from "./backup-validate.mjs";

/** 解析连接串:回环 host 归一(去 IPv6 括号/小写)、默认端口 5432、剥 query/fragment;失败返回 null。 */
export function parseDbUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") return null;
    let host = u.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (!host) return null;
    const port = u.port === "" ? 5432 : Number(u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    // dbname 归一:剥首斜杠;尾斜杠为连接串噪声(与 bash ${RESTORE_URL%/} 语义一致)
    return { scheme: u.protocol.replace(":", ""), host, port, dbname: u.pathname.replace(/^\//, "").replace(/\/$/, "") };
  } catch {
    return null;
  }
}

/** 回环判定:localhost / 127.0.0.0-127.255.255.255 / ::1(同一物理机的本机别名族)。 */
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** 规范化实例键:回环别名折叠为 loopback,端口缺省补 5432 ⇒ 文本层同实例判定(快速门)。 */
export function instanceKey(url) {
  const p = parseDbUrl(url);
  if (!p) return null;
  return `${isLoopbackHost(p.host) ? "loopback" : p.host}:${p.port}`;
}

/**
 * 严格解析 docker inspect 恢复容器 JSON(08R 回环安全门同款强度):
 * 恰一容器对象 + 运行中 + 5432/tcp 恰一条映射 + HostIp=127.0.0.1 + 数字 HostPort ⇒ 返回 { hostPort }。
 * 任一不满足抛出(消息含实际值,零密码)。
 */
export function readInspectMapping(jsonText, containerName) {
  let arr;
  try {
    arr = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`docker inspect 输出非 JSON(${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(arr) || arr.length !== 1 || !arr[0] || typeof arr[0] !== "object")
    throw new Error(`docker inspect 结果异常(容器数=${Array.isArray(arr) ? arr.length : "非数组"}):${containerName}`);
  const info = arr[0];
  if (info.State?.Running !== true) throw new Error(`恢复容器未运行(State.Running=${JSON.stringify(info.State?.Running ?? null)}):${containerName}`);
  const mappings = info.NetworkSettings?.Ports?.["5432/tcp"];
  if (!Array.isArray(mappings) || mappings.length !== 1)
    throw new Error(`恢复容器 5432/tcp 发布映射必须恰一条,实际=${JSON.stringify(mappings ?? null)}:${containerName}`);
  const { HostIp, HostPort } = mappings[0] ?? {};
  if (HostIp !== "127.0.0.1")
    throw new Error(`恢复容器 5432/tcp 必须发布到 127.0.0.1(实际 HostIp=${JSON.stringify(HostIp ?? null)}):${containerName}`);
  if (typeof HostPort !== "string" || HostPort === "" || !/^\d+$/.test(HostPort))
    throw new Error(`恢复容器 5432/tcp 发布端口非数字(实际 HostPort=${JSON.stringify(HostPort ?? null)}):${containerName}`);
  return { hostPort: HostPort, containerId: typeof info.Id === "string" ? info.Id : null };
}

/** 服务端实例身份探针(零原始数据):postmaster 启动时刻 + 服务端端口/地址。 */
export async function probeInstance(url, pgModule = pg) {
  const pool = new pgModule.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const r = await pool.query(
      "SELECT pg_postmaster_start_time()::text AS start_time, inet_server_port()::int AS server_port, inet_server_addr()::text AS server_addr",
    );
    const row = r.rows[0];
    if (!row || typeof row.start_time !== "string" || row.start_time === "" || row.server_port === null)
      throw new Error("身份探针返回不完整(start_time/server_port 缺失;非 TCP 连接?)");
    return { startTime: row.start_time, port: Number(row.server_port), addr: row.server_addr ?? null };
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * 总校验:返回 { ok:true, source, target, containerPort? } 或 { ok:false, reason };绝不抛出。
 * opts:sourceUrl / targetUrl 必填;docker 模式另传 restoreContainer + containerInspectJson 文本
 * (+ 可选 sourceContainerInspectJson 文本,供容器 ID 欺骗核对)。
 */
export async function verifyRestoreTarget(opts, pgModule = pg) {
  const { sourceUrl, targetUrl } = opts;
  if (!sourceUrl) return { ok: false, reason: "RELAY_DB_URL(备份源实例连接串)未提供:无法证明恢复目标不是源实例;拒绝" };
  if (!targetUrl) return { ok: false, reason: "RESTORE_URL(隔离恢复实例 base 连接串)未提供;拒绝" };
  const srcParsed = parseDbUrl(sourceUrl);
  const tgtParsed = parseDbUrl(targetUrl);
  if (!srcParsed) return { ok: false, reason: `RELAY_DB_URL 不可解析为 postgresql:// 连接串(${redactDbUrl(String(sourceUrl))});拒绝` };
  if (!tgtParsed) return { ok: false, reason: `RESTORE_URL 不可解析为 postgresql:// base 连接串(${redactDbUrl(String(targetUrl))});拒绝` };
  // ① 文本层快速门:回环折叠 + 默认端口 ⇒ 同实例别名/端口缺省形态直接拒绝(不产生任何连接)
  const srcKey = instanceKey(sourceUrl);
  const tgtKey = instanceKey(targetUrl);
  if (srcKey === tgtKey)
    return { ok: false, reason: `规范化实例键相同(源=${srcKey};目标=${tgtKey}):同实例别名/端口缺省形态,拒绝恢复(别名不构成隔离证明)` };
  // ② 执行面绑定(docker 回退分支)
  let containerPort;
  let restContainerId;
  if (opts.containerInspectJson !== undefined) {
    if (!isLoopbackHost(tgtParsed.host))
      return { ok: false, reason: `docker 回退分支要求 RESTORE_URL 为回环地址(实际 host=${tgtParsed.host});非回环声明目标无法与本地容器绑定,拒绝` };
    let mapped;
    try {
      mapped = readInspectMapping(opts.containerInspectJson, opts.restoreContainer ?? "(未命名恢复容器)");
    } catch (err) {
      return { ok: false, reason: `恢复容器绑定失败:${err instanceof Error ? err.message : String(err)};声明目标≠物理执行目标,拒绝` };
    }
    containerPort = mapped.hostPort;
    restContainerId = mapped.containerId;
    if (containerPort !== String(tgtParsed.port))
      return {
        ok: false,
        reason: `RESTORE_URL 端口(${tgtParsed.port})与实际恢复容器发布端口(${containerPort})不一致:声明目标≠物理执行目标,拒绝`,
      };
    if (opts.sourceContainerInspectJson !== undefined) {
      try {
        const srcMapped = readInspectMapping(opts.sourceContainerInspectJson, "(显式 RELAY_PG_CONTAINER)");
        if (restContainerId && srcMapped.containerId && restContainerId === srcMapped.containerId)
          return { ok: false, reason: `恢复容器与源容器为同一容器 ID(${restContainerId.slice(0, 12)}):容器名别名/欺骗形态,拒绝` };
      } catch {
        // 源容器 inspect 失败不阻塞:源实例身份由 ③ 真值层探针承担(此处为深度防御,非唯一证明)
      }
    }
  }
  // ③ 真值层双探针:任一失败 ⇒ 无法证明 ⇒ 拒绝;身份相同 ⇒ 同一物理实例 ⇒ 拒绝
  let source;
  try {
    source = await probeInstance(sourceUrl, pgModule);
  } catch (err) {
    return { ok: false, reason: `源实例身份不可证(连接失败:${err instanceof Error ? err.message : String(err)};${redactDbUrl(String(sourceUrl))});拒绝` };
  }
  let target;
  try {
    target = await probeInstance(targetUrl, pgModule);
  } catch (err) {
    return { ok: false, reason: `恢复目标实例身份不可证(连接失败:${err instanceof Error ? err.message : String(err)};${redactDbUrl(String(targetUrl))});拒绝` };
  }
  if (source.startTime === target.startTime && source.port === target.port)
    return {
      ok: false,
      reason: `源实例与恢复目标为同一物理实例(postmaster 启动时刻与端口相同:${source.startTime.slice(0, 19)}…:${source.port});同实例别名/同集群已识别,拒绝恢复`,
    };
  return { ok: true, source, target, containerPort };
}

const isMain = typeof process.argv[1] === "string" && process.argv[1].endsWith("restore-target-verify.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1 || i + 1 >= args.length) return undefined;
    return args[i + 1];
  };
  const opts = {
    sourceUrl: opt("source-url"),
    targetUrl: opt("target-url"),
    restoreContainer: opt("restore-container"),
    containerInspectJson: opt("container-inspect-json") === undefined ? undefined : readFileSync(opt("container-inspect-json"), "utf8"),
    sourceContainerInspectJson:
      opt("source-container-inspect-json") === undefined ? undefined : readFileSync(opt("source-container-inspect-json"), "utf8"),
  };
  const result = await verifyRestoreTarget(opts);
  if (!result.ok) {
    console.error(`[restore-target] fail-closed:${result.reason}`);
    process.exit(2);
  }
  console.log(`[restore-target] 源实例身份:start=${result.source.startTime} port=${result.source.port}`);
  console.log(`[restore-target] 恢复目标身份:start=${result.target.startTime} port=${result.target.port}${result.containerPort ? `(容器发布=${result.containerPort})` : ""}`);
  console.log("[restore-target] 身份证明通过:目标为与源实例不同的可达隔离实例;执行面绑定成立(如适用)");
  console.log(`RESTORE_TARGET_START_TIME=${result.target.startTime}`);
}
