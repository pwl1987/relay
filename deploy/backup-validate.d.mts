// backup-validate.mjs 的类型声明(单测 import 用;RELAY-BACKUP-INTEGRITY-09)
export function isValidRelaySchemaName(s: unknown): boolean;
export function redactDbUrl(url: string): string;
export function validateBackupTarget(
  schema: string,
  url: string,
  pgModule?: unknown,
): Promise<{ ok: boolean; reason?: string; dbName?: string }>;
