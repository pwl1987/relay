// E2E Provider 探测(合同条款 6:按当前实际可用性,不硬编码历史路由假设)。
// 候选来源:env RELAY_PI_PROVIDER/MODEL/API_KEY/BASE_URL,缺省探测本地路由;
// 不可用 ⇒ 返回 null(E2E 显式 skip,不假装)。
export interface ProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export async function probeProvider(): Promise<ProviderConfig | null> {
  const base = process.env.RELAY_PI_BASE_URL ?? "http://127.0.0.1:3425/v1";
  const cfg: ProviderConfig = {
    provider: process.env.RELAY_PI_PROVIDER ?? "magpie",
    model: process.env.RELAY_PI_MODEL ?? "group/gm",
    apiKey: process.env.RELAY_PI_API_KEY ?? "magpie",
    baseUrl: base,
  };
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? []).map((m) => String(m.id ?? ""));
    return ids.includes(cfg.model) ? cfg : null;
  } catch {
    return null;
  }
}
