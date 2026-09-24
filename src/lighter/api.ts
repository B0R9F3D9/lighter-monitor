import { CONFIG } from "../config";
import { LighterAccount, LighterApiResponse, LighterNetwork } from "../types";

export async function fetchLighterAccount(
  network: LighterNetwork,
  accountIndex: number
): Promise<LighterAccount | null>;
export async function fetchLighterAccount(
  accountIndex: number
): Promise<LighterAccount | null>;
export async function fetchLighterAccount(
  networkOrIndex: LighterNetwork | number,
  maybeIndex?: number
): Promise<LighterAccount | null> {
  let network: LighterNetwork = 'rh';
  let index: number;

  if (typeof networkOrIndex === 'number') {
    index = networkOrIndex;
    network = 'rh';
  } else {
    network = networkOrIndex;
    index = maybeIndex!;
  }

  const baseUrl = CONFIG.NETWORKS[network]?.baseUrl || CONFIG.NETWORKS.rh.baseUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/account?by=index&value=${index}`, {
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
    console.error(`fetchLighterAccount error for [${network}] #${index}:`, err);
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
    const chunkResults = await Promise.allSettled(chunk.map(item => fn(item)));
    results.push(...chunkResults);
  }
  return results;
}
