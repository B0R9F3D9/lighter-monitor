import { CONFIG } from "../config";
import { LighterAccount, LighterApiResponse } from "../types";

export async function fetchLighterAccount(
  accountIndex: number, 
  baseUrl: string = CONFIG.LIGHTER_RH_BASE_URL
): Promise<LighterAccount | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/account?by=index&value=${accountIndex}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    });

    if (!res.ok) return null;

    const data = (await res.json()) as LighterApiResponse;
    if (data.code === 200 && data.accounts && data.accounts.length > 0) {
      return data.accounts[0];
    }
    return null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchInChunks<T, R>(
  items: T[], 
  chunkSize: number, 
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.allSettled(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}
