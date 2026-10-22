import {
  clearAccountRecords,
  normalizeTimestampMs,
  saveAccountMeta,
  upsertFunding,
  upsertTrades,
  upsertWithdrawals,
} from "./db";
import type {
  AccountMetaRecord,
  AccountSyncState,
  CheckerNetwork,
  LighterTokenInfo,
  LighterTrade,
  PositionFundingRecord,
  SyncProgressInfo,
  SyncResult,
  WithdrawalRecord,
} from "./types";

export const API_HOSTS: Record<CheckerNetwork, string> = {
  rh: "https://api.rh.lighter.xyz/api/v1",
  mainnet: "https://mainnet.zklighter.elliot.ai/api/v1",
};

const ROW_CAP = 150000;
const PAGE_LIMIT = 100;
const ASSET_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class AuthExpiredError extends Error {
  public readonly network: CheckerNetwork;
  public readonly statusCode: number;

  constructor(network: CheckerNetwork, statusCode: number, message?: string) {
    super(
      message ||
        `Lighter ${network === "rh" ? "Robinhood" : "Core"} token expired or invalid (HTTP ${statusCode}). Please update your Read-Only token.`,
    );
    this.name = "AuthExpiredError";
    this.network = network;
    this.statusCode = statusCode;
  }
}

/**
 * Validates Lighter API JSON payload for embedded error codes, even when HTTP status is 200 OK.
 */
export function assertApiOk(data: any, network: CheckerNetwork): void {
  if (!data || typeof data !== "object") return;
  const code = data.code;
  const msg = typeof data.message === "string" ? data.message : "";
  const isAuthMsg = /auth|token|expired|unauthorized/i.test(msg);

  if (code === 401 || code === 403 || isAuthMsg) {
    throw new AuthExpiredError(network, typeof code === "number" ? code : 401, msg);
  }

  if (code !== undefined && code !== 200 && code !== 0) {
    throw new Error(msg || `API Error code: ${code}`);
  }
}

/**
 * Parses a Lighter Read-Only or API key string into structured metadata.
 * Supports:
 * - ro:<account_index>:<scope>:<expiry>:<signature_hex>
 * - <account_index>:<key_index>:<expiry>:<signature_hex>
 */
export function parseLighterToken(
  rawInput: string,
  fallbackNetwork: CheckerNetwork = "mainnet",
): LighterTokenInfo {
  const token = (rawInput || "").trim();
  if (!token) {
    throw new Error("Token string is empty");
  }

  const parts = token.split(":");
  let accountIndex = 0;
  let expiryMs: number | undefined = undefined;
  let scope: string | undefined = undefined;
  let keyIndex: number | undefined = undefined;

  if (parts[0] === "ro" && parts.length >= 3) {
    // Canonical Read-Only Token: ro:<account_index>:<scope>:<expiry>:<sig>
    accountIndex = Number(parts[1]);
    scope = parts[2];
    if (parts.length >= 4) {
      const rawExp = Number(parts[3]);
      if (!isNaN(rawExp) && rawExp > 0) {
        expiryMs = rawExp < 1e11 ? rawExp * 1000 : rawExp;
      }
    }
  } else if (/^\d+$/.test(parts[0]) && parts.length >= 3) {
    // Standard Token: <account_index>:<key_index>:<expiry>:<sig>
    accountIndex = Number(parts[0]);
    keyIndex = Number(parts[1]);
    const rawExp = Number(parts[2]);
    if (!isNaN(rawExp) && rawExp > 0) {
      expiryMs = rawExp < 1e11 ? rawExp * 1000 : rawExp;
    }
  } else {
    // Fallback: extract first numeric sequence
    const match = token.match(/(?:ro:)?(\d+)/i);
    if (match && match[1]) {
      accountIndex = Number(match[1]);
    }
  }

  if (isNaN(accountIndex) || accountIndex <= 0) {
    throw new Error(`Unable to determine account_index from token: "${token.slice(0, 20)}..."`);
  }

  return {
    rawToken: token,
    accountIndex,
    network: fallbackNetwork,
    expiryMs,
    scope,
    keyIndex,
  };
}

/**
 * Conceals sensitive token characters for secure UI display.
 * e.g. "ro:31704:readonly:1790000000:3a5f... -> ro:31704:••••••••••••••••••••3a5f"
 */
export function maskToken(token: string): string {
  if (!token) return "";
  const t = token.trim();
  if (t.length <= 16) {
    return "••••••••";
  }

  // If format is ro:12345:...
  if (t.startsWith("ro:")) {
    const secondColon = t.indexOf(":", 3);
    const prefix = secondColon !== -1 ? t.slice(0, secondColon + 1) : "ro:";
    const suffix = t.slice(-4);
    return `${prefix}••••••••••••${suffix}`;
  }

  // Standard format 12345:0:...
  const firstColon = t.indexOf(":");
  if (firstColon !== -1) {
    const prefix = t.slice(0, firstColon + 1);
    const suffix = t.slice(-4);
    return `${prefix}••••••••••••${suffix}`;
  }

  return `${t.slice(0, 6)}••••••••${t.slice(-4)}`;
}

/**
 * Trims incoming trade object to required monomorphic shape for checker analytics.
 */
export function slimTrade(t: any): LighterTrade {
  const tid = Number(t.trade_id_str || t.trade_id) || 0;
  const askId = t.ask_id != null ? t.ask_id : 0;
  const bidId = t.bid_id != null ? t.bid_id : 0;
  const rawTs = t.timestamp != null ? Number(t.timestamp) : 0;

  return {
    trade_id: tid,
    trade_id_str: t.trade_id_str || (tid !== 0 ? String(tid) : ""),
    tx_hash: t.tx_hash || "",
    type: t.type || "trade",
    market_id: Number(t.market_id) || 0,
    market_kind: t.market_kind || "perps",
    size: String(t.size ?? "0"),
    price: String(t.price ?? "0"),
    usd_amount: String(t.usd_amount ?? "0"),
    ask_account_id: Number(t.ask_account_id) || 0,
    bid_account_id: Number(t.bid_account_id) || 0,
    is_maker_ask: Boolean(t.is_maker_ask),
    block_height: Number(t.block_height) || 0,
    timestamp: normalizeTimestampMs(rawTs),
    taker_fee: t.taker_fee != null ? Number(t.taker_fee) : 0,
    maker_fee: t.maker_fee != null ? Number(t.maker_fee) : 0,
    ask_id: askId,
    ask_id_str: t.ask_id_str || (askId !== 0 ? String(askId) : ""),
    bid_id: bidId,
    bid_id_str: t.bid_id_str || (bidId !== 0 ? String(bidId) : ""),
    ask_client_id: t.ask_client_id != null ? t.ask_client_id : 0,
    bid_client_id: t.bid_client_id != null ? t.bid_client_id : 0,
    transaction_time: t.transaction_time != null ? Number(t.transaction_time) : 0,
    ask_account_pnl: t.ask_account_pnl != null ? String(t.ask_account_pnl) : undefined,
    bid_account_pnl: t.bid_account_pnl != null ? String(t.bid_account_pnl) : undefined,
    funding: t.funding != null ? Number(t.funding) : undefined,
    funding_fee: t.funding_fee != null ? Number(t.funding_fee) : undefined,
  };
}

const assetMapMemoryCache = new Map<CheckerNetwork, Map<number, string>>();

/**
 * Retrieves asset details map (asset_id -> symbol) with 24h localStorage TTL caching.
 */
export async function getAssetMap(network: CheckerNetwork): Promise<Map<number, string>> {
  const cached = assetMapMemoryCache.get(network);
  if (cached && cached.size > 0) return cached;

  const storageKey = `lighter_assets_${network}`;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.timestamp && Date.now() - parsed.timestamp < ASSET_CACHE_TTL_MS && parsed.assets) {
        const map = new Map<number, string>();
        for (const [id, sym] of Object.entries(parsed.assets)) {
          map.set(Number(id), String(sym));
        }
        assetMapMemoryCache.set(network, map);
        return map;
      }
    }
  } catch {}

  const map = new Map<number, string>();
  // Defaults for quick fallback
  if (network === "rh") {
    map.set(0, "ETH");
    map.set(1, "USDG");
  } else {
    map.set(0, "ETH");
    map.set(1, "USDC");
  }

  try {
    const apiBase = API_HOSTS[network];
    const res = await fetch(`${apiBase}/assetDetails`);
    if (res.ok) {
      const data = await res.json();
      const list = data?.asset_details || data?.data || [];
      const cacheObj: Record<string, string> = {};
      for (const item of list) {
        if (item && item.asset_id != null && item.symbol) {
          const aId = Number(item.asset_id);
          const sym = String(item.symbol);
          map.set(aId, sym);
          cacheObj[String(aId)] = sym;
        }
      }
      assetMapMemoryCache.set(network, map);
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ timestamp: Date.now(), assets: cacheObj }),
        );
      } catch {}
    }
  } catch (err) {
    console.warn(`[LighterSync] Failed to fetch asset details for ${network}:`, err);
  }

  return map;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resilient fetch with exponential backoff and rate limit (429) cooldown.
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  network: CheckerNetwork,
  maxRetries = 3,
): Promise<Response> {
  const signal = options.signal;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error("Sync cancelled by user");
    }

    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err: any) {
      if (signal?.aborted || err?.name === "AbortError") {
        throw new Error("Sync cancelled by user", { cause: err });
      }
      if (attempt < maxRetries) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      throw new Error(`Network error connecting to ${network}: ${err?.message || String(err)}`, {
        cause: err,
      });
    }

    if (res.status === 429 && attempt < maxRetries) {
      await sleep(1500 * (attempt + 1));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new AuthExpiredError(network, res.status);
    }

    if (!res.ok) {
      if (attempt < maxRetries && res.status >= 500) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} (${network}): ${errText.slice(0, 100)}`);
    }

    return res;
  }

  throw new Error(`Request to ${url} failed after ${maxRetries} retries`);
}

export interface SyncOptions {
  forceFullSync?: boolean;
  signal?: AbortSignal;
  onProgress?: (info: SyncProgressInfo) => void;
}

/**
 * Lighter Synchronization Service: executes concurrent 1-RTT Delta Sync and Initial Full Sync.
 */
export class LighterSyncService {
  /**
   * Synchronizes an individual account (RH or Core).
   */
  public async syncAccount(
    meta: AccountMetaRecord,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const network = meta.network;
    const accountIndex = meta.accountIndex;
    const auth = meta.authToken;
    const apiBase = API_HOSTS[network];
    const signal = options.signal;

    const isFullSync = options.forceFullSync || !meta.syncState?.hasFullHistory;
    const reqHeaders: Record<string, string> = {
      Accept: "application/json",
      Authorization: auth,
      PreferAuthServer: "true",
    };
    const fetchOptions: RequestInit = {
      headers: reqHeaders,
      credentials: "omit",
      signal,
    };

    options.onProgress?.({
      network,
      accountIndex,
      phase: "init",
      page: 1,
      count: 0,
      progressPercent: isFullSync ? 5 : 10,
      message: isFullSync ? "Starting Full Sync..." : "Checking for new trades...",
    });

    if (isFullSync) {
      return await this.executeFullSync(meta, apiBase, fetchOptions, options, startTime);
    } else {
      return await this.executeDeltaSync(meta, apiBase, fetchOptions, options, startTime);
    }
  }

  /**
   * 1-RTT Intra-Account Parallel Delta Sync.
   * Launches /trades, /account, /positionFunding, and /withdraw/history concurrently.
   */
  private async executeDeltaSync(
    meta: AccountMetaRecord,
    apiBase: string,
    fetchOptions: RequestInit,
    options: SyncOptions,
    startTime: number,
  ): Promise<SyncResult> {
    const network = meta.network;
    const accountIndex = meta.accountIndex;
    const accountKey = meta.accountKey;
    const syncState = meta.syncState || { hasFullHistory: true };

    const latestTradeId = syncState.latestTradeId;
    const latestTradeTs = syncState.latestTradeTs;
    const latestFundingTs = syncState.latestFundingTs;
    const latestWithdrawId = syncState.latestWithdrawId;
    const latestWithdrawTs = syncState.latestWithdrawTs;

    // Concurrent 1-RTT execution across all 4 endpoints
    const [tradesResult, accountResult, fundingResult, withdrawalsResult] = await Promise.all([
      this.fetchDeltaTrades(meta, apiBase, fetchOptions, latestTradeId, latestTradeTs, options),
      this.fetchAccountSnapshot(apiBase, meta.accountIndex, fetchOptions, network),
      this.fetchDeltaFunding(meta, apiBase, fetchOptions, latestFundingTs, options),
      this.fetchDeltaWithdrawals(
        meta,
        apiBase,
        fetchOptions,
        latestWithdrawId,
        latestWithdrawTs,
        options,
      ),
    ]);

    const newTrades = tradesResult.trades;
    const newFunding = fundingResult.funding;
    const newWithdrawals = withdrawalsResult.withdrawals;

    // 1. Batch writes to IDB
    if (newTrades.length > 0 || newFunding.length > 0 || newWithdrawals.length > 0) {
      options.onProgress?.({
        network,
        accountIndex,
        phase: "saving",
        page: 1,
        count: newTrades.length,
        progressPercent: 95,
        message:
          newTrades.length > 0
            ? `Saving +${newTrades.length.toLocaleString()} trades to IndexedDB...`
            : "Updating IndexedDB...",
      });
    }

    if (newTrades.length > 0) {
      await upsertTrades(accountKey, newTrades);
    }
    if (newFunding.length > 0) {
      await upsertFunding(accountKey, newFunding);
    }
    if (newWithdrawals.length > 0) {
      await upsertWithdrawals(accountKey, newWithdrawals);
    }

    // 2. ATOMIC Cursor Advancement: only advance cursors if cutoff loop was reached cleanly
    if (tradesResult.reachedCutoff || newTrades.length === 0) {
      const updatedSyncState: AccountSyncState = {
        ...syncState,
        hasFullHistory: true,
      };

      if (tradesResult.topmostTradeId != null) {
        updatedSyncState.latestTradeId = tradesResult.topmostTradeId;
      }
      if (tradesResult.topmostTradeTs != null) {
        updatedSyncState.latestTradeTs = tradesResult.topmostTradeTs;
      }
      if (fundingResult.completedCleanly && fundingResult.topmostFundingTs != null) {
        updatedSyncState.latestFundingTs = fundingResult.topmostFundingTs;
      }
      if (withdrawalsResult.completedCleanly) {
        if (withdrawalsResult.topmostWithdrawId != null) {
          updatedSyncState.latestWithdrawId = withdrawalsResult.topmostWithdrawId;
        }
        if (withdrawalsResult.topmostWithdrawTs != null) {
          updatedSyncState.latestWithdrawTs = withdrawalsResult.topmostWithdrawTs;
        }
      }

      const updatedMeta: AccountMetaRecord = {
        ...meta,
        positions: accountResult?.positions || meta.positions,
        fundingSummary: accountResult?.fundingSummary || meta.fundingSummary,
        lastSyncedAt: Date.now(),
        syncState: updatedSyncState,
      };

      await saveAccountMeta(updatedMeta);
    }

    const durationMs = Date.now() - startTime;
    options.onProgress?.({
      network,
      accountIndex,
      phase: "done",
      page: 1,
      count: newTrades.length,
      progressPercent: 100,
      message:
        newTrades.length > 0
          ? `Delta sync complete: +${newTrades.length} trades (${(durationMs / 1000).toFixed(1)}s)`
          : `All data up to date (${(durationMs / 1000).toFixed(1)}s)`,
    });

    return {
      network,
      accountIndex,
      accountKey,
      newTrades,
      newFunding,
      newWithdrawals,
      isFullSync: false,
      durationMs,
    };
  }

  /**
   * Fetches delta slice of /trades until reaching cutoff (latestTradeId or timestamp with 5s buffer).
   */
  private async fetchDeltaTrades(
    meta: AccountMetaRecord,
    apiBase: string,
    fetchOptions: RequestInit,
    latestTradeId?: number,
    latestTradeTs?: number,
    options?: SyncOptions,
  ): Promise<{
    trades: LighterTrade[];
    reachedCutoff: boolean;
    topmostTradeId?: number;
    topmostTradeTs?: number;
  }> {
    const network = meta.network;
    const accountIndex = meta.accountIndex;
    const newTrades: LighterTrade[] = [];
    const seenIds = new Set<number>();
    let cursor = "";
    let reachedCutoff = false;
    let topmostTradeId: number | undefined = undefined;
    let topmostTradeTs: number | undefined = undefined;
    let page = 0;

    while (!reachedCutoff && newTrades.length < ROW_CAP) {
      page++;
      const url =
        `${apiBase}/trades?market_type=all&account_index=${accountIndex}` +
        `&sort_by=timestamp&sort_dir=desc&ask_filter=-1&role=all&type=all&limit=${PAGE_LIMIT}&aggregate=false` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

      const res = await fetchWithRetry(url, fetchOptions, network);
      const data = await res.json();
      assertApiOk(data, network);
      const list = data.trades || [];
      if (!Array.isArray(list) || list.length === 0) {
        reachedCutoff = true;
        break;
      }

      for (let i = 0; i < list.length; i++) {
        const rawTrade = list[i];
        const tid = Number(rawTrade.trade_id_str || rawTrade.trade_id);
        const tsMs = normalizeTimestampMs(rawTrade.timestamp);

        if (topmostTradeId === undefined) {
          topmostTradeId = tid;
          topmostTradeTs = tsMs;
        }

        // Strict cutoff rule: stop primarily by trade_id; fallback by strict < (ts - 5000ms buffer)
        if (latestTradeId != null && tid === latestTradeId) {
          reachedCutoff = true;
          break;
        }
        if (latestTradeTs != null && tsMs < latestTradeTs - 5000) {
          reachedCutoff = true;
          break;
        }

        if (!seenIds.has(tid)) {
          seenIds.add(tid);
          newTrades.push(slimTrade(rawTrade));
        }
      }

      options?.onProgress?.({
        network,
        accountIndex,
        phase: "trades",
        page,
        count: newTrades.length,
        progressPercent: Math.min(65, Math.round(15 + page * 2.5)),
        message:
          newTrades.length > 0
            ? `Syncing trades: page ${page} (+${newTrades.length.toLocaleString()} new)...`
            : `Checking trades: page ${page}...`,
      });

      if (reachedCutoff || newTrades.length >= ROW_CAP) {
        reachedCutoff = true;
        break;
      }

      const nextCur = data.next_cursor;
      if (!nextCur || nextCur === cursor) {
        reachedCutoff = true;
        break;
      }
      cursor = nextCur;
    }

    return {
      trades: newTrades,
      reachedCutoff,
      topmostTradeId,
      topmostTradeTs,
    };
  }

  /**
   * Fetches delta slice of /positionFunding until strict hourly cutoff (fTs < latestFundingTs).
   */
  private async fetchDeltaFunding(
    meta: AccountMetaRecord,
    apiBase: string,
    fetchOptions: RequestInit,
    latestFundingTs?: number,
    options?: SyncOptions,
  ): Promise<{
    funding: PositionFundingRecord[];
    topmostFundingTs?: number;
    completedCleanly: boolean;
  }> {
    const network = meta.network;
    const accountIndex = meta.accountIndex;
    const newFunding: PositionFundingRecord[] = [];
    let cursor = "";
    let reachedCutoff = false;
    let completedCleanly = true;
    let topmostFundingTs: number | undefined = undefined;
    let page = 0;

    while (!reachedCutoff && page < 20) {
      page++;
      const url =
        `${apiBase}/positionFunding?account_index=${accountIndex}&limit=${PAGE_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

      try {
        const res = await fetchWithRetry(url, fetchOptions, network);
        const data = await res.json();
        assertApiOk(data, network);
        const list = data.position_fundings || data.data || data.funding_history || [];
        if (!Array.isArray(list) || list.length === 0) break;

        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          const fTs = normalizeTimestampMs(item.timestamp);
          if (topmostFundingTs === undefined) {
            topmostFundingTs = fTs;
          }

          // Strict hourly cutoff: fTs < latestFundingTs (allows re-ingesting same-hour multiple markets safely)
          if (latestFundingTs != null && fTs < latestFundingTs) {
            reachedCutoff = true;
            break;
          }
          newFunding.push({
            timestamp: fTs,
            market_id: Number(item.market_id) || 0,
            funding_id: item.funding_id != null ? Number(item.funding_id) : undefined,
            change: item.change != null ? item.change : "0",
            rate: item.rate,
            position_size: item.position_size,
            position_side: item.position_side,
            discount: item.discount,
          });
        }

        options?.onProgress?.({
          network,
          accountIndex,
          phase: "funding",
          page,
          count: newFunding.length,
          progressPercent: Math.min(82, Math.round(65 + page * 3)),
          message:
            newFunding.length > 0
              ? `Syncing funding: page ${page} (+${newFunding.length.toLocaleString()} new)...`
              : `Checking funding: page ${page}...`,
        });

        if (reachedCutoff) break;

        const nextCur = data.next_cursor || data.cursor;
        if (!nextCur || nextCur === cursor) break;
        cursor = nextCur;
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        completedCleanly = false;
        break;
      }
    }

    return {
      funding: newFunding,
      topmostFundingTs,
      completedCleanly,
    };
  }

  /**
   * Fetches delta slice of /withdraw/history until cutoff.
   */
  private async fetchDeltaWithdrawals(
    meta: AccountMetaRecord,
    apiBase: string,
    fetchOptions: RequestInit,
    latestWithdrawId?: string,
    latestWithdrawTs?: number,
    options?: SyncOptions,
  ): Promise<{
    withdrawals: WithdrawalRecord[];
    topmostWithdrawId?: string;
    topmostWithdrawTs?: number;
    completedCleanly: boolean;
  }> {
    const network = meta.network;
    const accountIndex = meta.accountIndex;
    const newWithdrawals: WithdrawalRecord[] = [];
    const assets = await getAssetMap(network);
    let cursor = "";
    let reachedCutoff = false;
    let completedCleanly = true;
    let topmostWithdrawId: string | undefined = undefined;
    let topmostWithdrawTs: number | undefined = undefined;
    let page = 0;

    while (!reachedCutoff && page < 15) {
      page++;
      const url =
        `${apiBase}/withdraw/history?account_index=${accountIndex}&limit=${PAGE_LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

      try {
        const res = await fetchWithRetry(url, fetchOptions, network);
        const data = await res.json();
        assertApiOk(data, network);
        const list =
          data.withdraw_history ||
          data.withdraw_histories ||
          data.withdraws ||
          data.withdrawals ||
          data.data ||
          [];
        if (!Array.isArray(list) || list.length === 0) break;

        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          if (!item) continue;
          const rawWTs = item.timestamp_ms || item.timestampMs || item.timestamp || item.created_at;
          const wTs = normalizeTimestampMs(rawWTs);
          const wid = String(
            item.id || item.withdraw_id || item.l1_tx_hash || `${wTs}_${item.amount}`,
          );

          if (topmostWithdrawId === undefined) {
            topmostWithdrawId = wid;
            topmostWithdrawTs = wTs;
          }

          if (latestWithdrawId != null && wid === latestWithdrawId) {
            reachedCutoff = true;
            break;
          }
          if (latestWithdrawTs != null && wTs < latestWithdrawTs - 5000) {
            reachedCutoff = true;
            break;
          }

          const aId = Number(item.asset_id ?? item.assetId ?? 0);
          const sym =
            item.symbol ||
            assets.get(aId) ||
            (aId === 1 ? "USDC" : network === "rh" ? "USDG" : "USDC");
          const amountNum = Number(item.amount ?? item.usd_amount ?? item.amount_usd ?? 0);
          const rawFee = item.fee_usd ?? item.fee ?? item.usd_fee ?? item.fee_amount;
          const feeNum = rawFee != null && !isNaN(Number(rawFee)) ? Number(rawFee) : undefined;

          newWithdrawals.push({
            id: wid,
            amount: item.amount != null ? String(item.amount) : String(amountNum),
            amountUsd: item.amount_usd != null ? Number(item.amount_usd) : amountNum,
            timestamp: item.timestamp != null ? Number(item.timestamp) : Math.floor(wTs / 1000),
            timestampMs: wTs,
            status: item.status ? String(item.status).toLowerCase() : "completed",
            type: item.type ? String(item.type).toLowerCase() : "secure",
            l1_tx_hash: item.l1_tx_hash || item.tx_hash || "",
            asset_id: aId,
            symbol: sym,
            fee: item.fee != null ? String(item.fee) : undefined,
            feeUsd: feeNum,
          });
        }

        options?.onProgress?.({
          network,
          accountIndex,
          phase: "withdrawals",
          page,
          count: newWithdrawals.length,
          progressPercent: Math.min(92, Math.round(82 + page * 2.5)),
          message:
            newWithdrawals.length > 0
              ? `Syncing withdrawals: page ${page} (+${newWithdrawals.length.toLocaleString()} new)...`
              : `Checking withdrawals: page ${page}...`,
        });

        if (reachedCutoff) break;

        const nextCur = data.next_cursor || data.cursor;
        if (!nextCur || nextCur === cursor) break;
        cursor = nextCur;
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        completedCleanly = false;
        break;
      }
    }

    return {
      withdrawals: newWithdrawals,
      topmostWithdrawId,
      topmostWithdrawTs,
      completedCleanly,
    };
  }

  /**
   * Fetches account positions and cumulative funding summary snapshot from /account.
   */
  private async fetchAccountSnapshot(
    apiBase: string,
    accountIndex: number,
    fetchOptions: RequestInit,
    network: CheckerNetwork,
  ): Promise<{
    positions: any[];
    fundingSummary: { totalFundingUsd: number; byMarketUsd: Record<string, number> };
  } | null> {
    try {
      const res = await fetchWithRetry(
        `${apiBase}/account?by=index&value=${accountIndex}`,
        fetchOptions,
        network,
        2,
      );
      if (res.ok) {
        const data = await res.json();
        assertApiOk(data, network);
        const accObj = data?.account || data?.sub_accounts?.[0] || data;
        const positions = Array.isArray(accObj?.positions) ? accObj.positions : [];
        let totalFundingUsd = 0;
        const byMarketUsd: Record<string, number> = {};

        for (const p of positions) {
          const sym = String(p.symbol || p.market_symbol || p.market_id || "").toUpperCase();
          const paid = Number(p.total_funding_paid_out) || 0;
          totalFundingUsd += paid;
          if (sym) {
            byMarketUsd[sym] = (byMarketUsd[sym] || 0) + paid;
          }
        }

        return {
          positions,
          fundingSummary: {
            totalFundingUsd,
            byMarketUsd,
          },
        };
      }
    } catch (err) {
      console.warn(`[LighterSync] Failed to fetch /account snapshot for ${network}:`, err);
    }
    return null;
  }

  /**
   * Initial / Full Sync: downloads full history up to ROW_CAP (150,000 trades), position funding, and withdrawals.
   */
  private async executeFullSync(
    meta: AccountMetaRecord,
    apiBase: string,
    fetchOptions: RequestInit,
    options: SyncOptions,
    startTime: number,
  ): Promise<SyncResult> {
    const network = meta.network;
    const accountIndex = meta.accountIndex;
    const accountKey = meta.accountKey;

    let cursor = "";
    let page = 0;
    let totalTradesCount = 0;
    const allTrades: LighterTrade[] = [];
    const seenIds = new Set<number>();
    let topmostTradeId: number | undefined = undefined;
    let topmostTradeTs: number | undefined = undefined;

    // 1. Fetch complete trades history with prefetch pipeline
    while (totalTradesCount < ROW_CAP) {
      page++;
      const url =
        `${apiBase}/trades?market_type=all&account_index=${accountIndex}` +
        `&sort_by=timestamp&sort_dir=desc&ask_filter=-1&role=all&type=all&limit=${PAGE_LIMIT}&aggregate=false` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

      const res = await fetchWithRetry(url, fetchOptions, network);
      const data = await res.json();
      assertApiOk(data, network);
      const list = data.trades || [];
      if (!Array.isArray(list) || list.length === 0) break;

      if (page === 1) {
        await clearAccountRecords(accountKey);
      }

      const pageTrades: LighterTrade[] = [];
      for (let i = 0; i < list.length; i++) {
        const rawTrade = list[i];
        const tid = Number(rawTrade.trade_id_str || rawTrade.trade_id);
        const tsMs = normalizeTimestampMs(rawTrade.timestamp);

        if (topmostTradeId === undefined) {
          topmostTradeId = tid;
          topmostTradeTs = tsMs;
        }

        if (!seenIds.has(tid)) {
          seenIds.add(tid);
          const slimmed = slimTrade(rawTrade);
          pageTrades.push(slimmed);
          allTrades.push(slimmed);
        }
      }

      totalTradesCount += pageTrades.length;
      if (pageTrades.length > 0) {
        await upsertTrades(accountKey, pageTrades);
      }

      options.onProgress?.({
        network,
        accountIndex,
        phase: "trades",
        page,
        count: totalTradesCount,
        progressPercent: Math.min(60, Math.round(10 + page * 2.5)),
        message: `Full Sync: trades page ${page} (${totalTradesCount.toLocaleString()} trades)...`,
      });

      const nextCur = data.next_cursor;
      if (!nextCur || nextCur === cursor) break;
      cursor = nextCur;
    }

    // 2. Fetch full hourly funding history
    const allFunding: PositionFundingRecord[] = [];
    let fundCursor = "";
    let fundPage = 0;
    let topmostFundingTs: number | undefined = undefined;

    options.onProgress?.({
      network,
      accountIndex,
      phase: "funding",
      page: 1,
      count: 0,
      progressPercent: 62,
      message: "Full Sync: fetching funding history...",
    });

    while (fundPage < 50) {
      fundPage++;
      const url =
        `${apiBase}/positionFunding?account_index=${accountIndex}&limit=${PAGE_LIMIT}` +
        (fundCursor ? `&cursor=${encodeURIComponent(fundCursor)}` : "");

      try {
        const res = await fetchWithRetry(url, fetchOptions, network);
        const data = await res.json();
        assertApiOk(data, network);
        const list = data.position_fundings || data.data || data.funding_history || [];
        if (!Array.isArray(list) || list.length === 0) break;

        const pageFunding: PositionFundingRecord[] = [];
        for (const item of list) {
          const fTs = normalizeTimestampMs(item.timestamp);
          if (topmostFundingTs === undefined) topmostFundingTs = fTs;
          const rec: PositionFundingRecord = {
            timestamp: fTs,
            market_id: Number(item.market_id) || 0,
            funding_id: item.funding_id != null ? Number(item.funding_id) : undefined,
            change: item.change != null ? item.change : "0",
            rate: item.rate,
            position_size: item.position_size,
            position_side: item.position_side,
            discount: item.discount,
          };
          pageFunding.push(rec);
          allFunding.push(rec);
        }

        if (pageFunding.length > 0) {
          await upsertFunding(accountKey, pageFunding);
        }

        options.onProgress?.({
          network,
          accountIndex,
          phase: "funding",
          page: fundPage,
          count: allFunding.length,
          progressPercent: Math.min(80, Math.round(62 + fundPage * 3)),
          message: `Full Sync: funding page ${fundPage} (${allFunding.length.toLocaleString()} entries)...`,
        });

        const nextCur = data.next_cursor || data.cursor;
        if (!nextCur || nextCur === fundCursor) break;
        fundCursor = nextCur;
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        break;
      }
    }

    // 3. Fetch full withdrawals history
    const allWithdrawals: WithdrawalRecord[] = [];
    const assets = await getAssetMap(network);
    let withdrawCursor = "";
    let withdrawPage = 0;
    let topmostWithdrawId: string | undefined = undefined;
    let topmostWithdrawTs: number | undefined = undefined;

    options.onProgress?.({
      network,
      accountIndex,
      phase: "withdrawals",
      page: 1,
      count: 0,
      progressPercent: 82,
      message: "Full Sync: fetching withdrawals...",
    });

    while (withdrawPage < 30) {
      withdrawPage++;
      const url =
        `${apiBase}/withdraw/history?account_index=${accountIndex}&limit=${PAGE_LIMIT}` +
        (withdrawCursor ? `&cursor=${encodeURIComponent(withdrawCursor)}` : "");

      try {
        const res = await fetchWithRetry(url, fetchOptions, network);
        const data = await res.json();
        assertApiOk(data, network);
        const list =
          data.withdraw_history ||
          data.withdraw_histories ||
          data.withdraws ||
          data.withdrawals ||
          data.data ||
          [];
        if (!Array.isArray(list) || list.length === 0) break;

        const pageWithdrawals: WithdrawalRecord[] = [];
        for (const item of list) {
          const wTs = normalizeTimestampMs(item.timestamp_ms || item.timestampMs || item.timestamp);
          const wid = String(
            item.id || item.withdraw_id || item.l1_tx_hash || `${wTs}_${item.amount}`,
          );
          if (topmostWithdrawId === undefined) {
            topmostWithdrawId = wid;
            topmostWithdrawTs = wTs;
          }
          const aId = Number(item.asset_id ?? item.assetId ?? 0);
          const sym =
            item.symbol ||
            assets.get(aId) ||
            (aId === 1 ? "USDC" : network === "rh" ? "USDG" : "USDC");
          const amountNum = Number(item.amount ?? item.usd_amount ?? 0);
          const rawFee = item.fee_usd ?? item.fee;
          const feeNum = rawFee != null && !isNaN(Number(rawFee)) ? Number(rawFee) : undefined;

          const rec: WithdrawalRecord = {
            id: wid,
            amount: item.amount != null ? String(item.amount) : String(amountNum),
            amountUsd: item.amount_usd != null ? Number(item.amount_usd) : amountNum,
            timestamp: item.timestamp != null ? Number(item.timestamp) : Math.floor(wTs / 1000),
            timestampMs: wTs,
            status: item.status ? String(item.status).toLowerCase() : "completed",
            type: item.type ? String(item.type).toLowerCase() : "secure",
            l1_tx_hash: item.l1_tx_hash || item.tx_hash || "",
            asset_id: aId,
            symbol: sym,
            fee: item.fee != null ? String(item.fee) : undefined,
            feeUsd: feeNum,
          };
          pageWithdrawals.push(rec);
          allWithdrawals.push(rec);
        }

        if (pageWithdrawals.length > 0) {
          await upsertWithdrawals(accountKey, pageWithdrawals);
        }

        options.onProgress?.({
          network,
          accountIndex,
          phase: "withdrawals",
          page: withdrawPage,
          count: allWithdrawals.length,
          progressPercent: Math.min(92, Math.round(82 + withdrawPage * 3)),
          message: `Full Sync: withdrawals page ${withdrawPage} (${allWithdrawals.length.toLocaleString()} entries)...`,
        });

        const nextCur = data.next_cursor || data.cursor;
        if (!nextCur || nextCur === withdrawCursor) break;
        withdrawCursor = nextCur;
      } catch (err) {
        if (err instanceof AuthExpiredError) throw err;
        break;
      }
    }

    // 4. Fetch account snapshot
    const accountSnapshot = await this.fetchAccountSnapshot(
      apiBase,
      accountIndex,
      fetchOptions,
      network,
    );

    options.onProgress?.({
      network,
      accountIndex,
      phase: "saving",
      page: 1,
      count: totalTradesCount,
      progressPercent: 96,
      message: `Saving ${totalTradesCount.toLocaleString()} trades to IndexedDB...`,
    });

    // 5. ATOMIC Meta Cursor Save
    const updatedSyncState: AccountSyncState = {
      latestTradeId: topmostTradeId,
      latestTradeTs: topmostTradeTs,
      latestFundingTs: topmostFundingTs,
      latestWithdrawId: topmostWithdrawId,
      latestWithdrawTs: topmostWithdrawTs,
      hasFullHistory: true,
    };

    const updatedMeta: AccountMetaRecord = {
      ...meta,
      positions: accountSnapshot?.positions || meta.positions,
      fundingSummary: accountSnapshot?.fundingSummary || meta.fundingSummary,
      lastSyncedAt: Date.now(),
      totalTradesCount,
      syncState: updatedSyncState,
    };

    await saveAccountMeta(updatedMeta);

    const durationMs = Date.now() - startTime;
    options.onProgress?.({
      network,
      accountIndex,
      phase: "done",
      page,
      count: totalTradesCount,
      progressPercent: 100,
      message: `Full sync complete: ${totalTradesCount.toLocaleString()} trades (${(durationMs / 1000).toFixed(1)}s)`,
    });

    return {
      network,
      accountIndex,
      accountKey,
      newTrades: allTrades,
      newFunding: allFunding,
      newWithdrawals: allWithdrawals,
      isFullSync: true,
      totalTradesInDb: totalTradesCount,
      durationMs,
    };
  }
}

export const syncService = new LighterSyncService();

/**
 * Concurrently synchronizes both configured accounts (RH and Core) in parallel.
 */
export async function syncDualAccounts(
  rhMeta: AccountMetaRecord | null,
  coreMeta: AccountMetaRecord | null,
  options: SyncOptions = {},
): Promise<{
  rhResult: SyncResult | null;
  coreResult: SyncResult | null;
  errors: Error[];
}> {
  const errors: Error[] = [];

  const [rhSettled, coreSettled] = await Promise.allSettled([
    rhMeta ? syncService.syncAccount(rhMeta, options) : Promise.resolve(null),
    coreMeta ? syncService.syncAccount(coreMeta, options) : Promise.resolve(null),
  ]);

  let rhResult: SyncResult | null = null;
  let coreResult: SyncResult | null = null;

  if (rhSettled.status === "fulfilled") {
    rhResult = rhSettled.value;
  } else {
    errors.push(rhSettled.reason);
  }

  if (coreSettled.status === "fulfilled") {
    coreResult = coreSettled.value;
  } else {
    errors.push(coreSettled.reason);
  }

  return {
    rhResult,
    coreResult,
    errors,
  };
}
