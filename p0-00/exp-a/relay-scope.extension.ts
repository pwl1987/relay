/**
 * P0-00 实验 A:受控作用域工具原型(实验代码,非产品实现)。
 *
 * relay_read 仅允许读取 RELAY_ALLOWED_ROOT 内的常规文件:
 * realpath 解析后做前缀校验,拒绝越界、路径穿越与非普通文件。
 * 这是 "Action Proposal → Policy → Scoped Executor" 中工具层策略的最小可测形态。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const ALLOWED_ROOT = process.env.RELAY_ALLOWED_ROOT
	? realpathSync(process.env.RELAY_ALLOWED_ROOT)
	: null;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "relay_read",
		label: "Relay Scoped Read",
		description:
			"Read a file from the Relay-allowed workspace. Paths outside the allowed root are DENIED.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to read" }),
		}),
		execute: async (_id, params) => {
			const deny = (reason: string) => ({
				content: [{ type: "text" as const, text: `DENIED: ${reason}` }],
				details: { denied: true, requestedPath: params.path },
			});
			if (!ALLOWED_ROOT) return deny("RELAY_ALLOWED_ROOT not configured");
			try {
				const requested = resolve(params.path);
				const real = realpathSync(requested);
				const rootWithSep = ALLOWED_ROOT.endsWith(sep) ? ALLOWED_ROOT : ALLOWED_ROOT + sep;
				if (real !== ALLOWED_ROOT && !real.startsWith(rootWithSep)) {
					return deny(`path outside allowed root ${ALLOWED_ROOT}`);
				}
				const st = statSync(real);
				if (!st.isFile()) return deny("not a regular file");
				const text = readFileSync(real, "utf8");
				return {
					content: [{ type: "text" as const, text: text.slice(0, 20000) }],
					details: { denied: false, resolvedPath: real },
				};
			} catch (e) {
				return deny(`error: ${(e as Error).message}`);
			}
		},
	});
}
