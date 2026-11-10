// GitHub 凭据隔离(P0-02B G-1:凭据只由可信执行器持有,不进 Pi/Reviewer/候选工作区/日志)。
// 形态:宿主 0600 原始 PAT 文件 → 会话级 git credential-store 文件(0600);
// 执行器经 credential.helper=store --file=<path> 注入 —— 令牌本体不出现在 argv/env/错误文本,
// 只存在于 0600 文件与 git 子进程内存。cleanup 必须调用(会话结束即删)。
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** 原始 PAT 文件要求:存在、常规文件、0600、非空。 */
export function tokenFileValid(path: string | null | undefined): boolean {
  if (!path) return false;
  try {
    if (!existsSync(path)) return false;
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o777) === 0o600 && st.size > 0;
  } catch {
    return false;
  }
}

/** 读取原始 PAT(去除尾随空白);文件无效即抛(FAIL-CLOSED,不降级)。 */
export function readTokenFile(path: string): string {
  if (!tokenFileValid(path)) {
    throw new Error(`github token file invalid: ${path}(须为 0600 非空常规文件)`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length === 0) throw new Error("github token file empty");
  return token;
}

export interface CredentialStore {
  /** 传给执行器 credentialFile 的 0600 store 文件路径 */
  path: string;
  cleanup(): void;
}

/** 从原始 PAT 构建会话级 credential-store 文件(0600;内容形如 https://x-access-token:<PAT>@github.com)。 */
export function makeCredentialStore(tokenFile: string, opts: { host?: string; baseDir?: string } = {}): CredentialStore {
  const token = readTokenFile(tokenFile);
  const host = opts.host ?? "github.com";
  const dir = opts.baseDir ?? mkdtempSync(join(tmpdir(), `relay-ghcred-${randomUUID().slice(0, 8)}-`));
  const path = join(dir, "credential-store");
  writeFileSync(path, `https://x-access-token:${token}@${host}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    path,
    cleanup() {
      rmSync(path, { force: true });
    },
  };
}
