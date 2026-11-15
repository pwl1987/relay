// restore-target-verify.mjs 的类型声明(单测 import 用;RELAY-RESTORE-TARGET-09R)
export interface ParsedDbUrl {
  scheme: string;
  host: string;
  port: number;
  dbname: string;
}
export interface InstanceProbe {
  startTime: string;
  port: number;
  addr: string | null;
}
export function parseDbUrl(url: unknown): ParsedDbUrl | null;
export function isLoopbackHost(host: unknown): boolean;
export function instanceKey(url: string): string | null;
export function readInspectMapping(jsonText: string, containerName: string): { hostPort: string; containerId: string | null };
export function probeInstance(url: string, pgModule?: unknown): Promise<InstanceProbe>;
export function verifyRestoreTarget(
  opts: {
    sourceUrl?: string;
    targetUrl?: string;
    restoreContainer?: string;
    containerInspectJson?: string;
    sourceContainerInspectJson?: string;
  },
  pgModule?: unknown,
): Promise<{ ok: boolean; reason?: string; source?: InstanceProbe; target?: InstanceProbe; containerPort?: string }>;
