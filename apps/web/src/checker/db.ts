/* oxlint-disable unicorn/prefer-add-event-listener */
import type {
  AccountMetaRecord,
  DbFundingRecord,
  DbTradeRecord,
  DbWithdrawalRecord,
  LighterTrade,
  PositionFundingRecord,
  WithdrawalRecord,
} from "./types";

const DB_NAME = "LighterCheckerDB";
const DB_VERSION = 1;

/**
 * Normalizes timestamp into milliseconds (handles both sec and ms).
 */
export function normalizeTimestampMs(ts: number): number {
  if (!ts || isNaN(ts)) return 0;
  return ts < 1e11 ? ts * 1000 : ts;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function getDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not supported in this environment"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // 1. accounts_meta: keyPath "accountKey" (e.g. "rh:31704", "mainnet:749329")
      if (!db.objectStoreNames.contains("accounts_meta")) {
        db.createObjectStore("accounts_meta", { keyPath: "accountKey" });
      }

      // 2. trades: keyPath "uid" (Zero secondary indexes for ultra-fast B-tree range scan)
      // uid format: "${accountKey}:${String(timestampMs).padStart(15, '0')}:${String(trade_id).padStart(12, '0')}"
      if (!db.objectStoreNames.contains("trades")) {
        db.createObjectStore("trades", { keyPath: "uid" });
      }

      // 3. funding_history: keyPath "uid"
      // uid format: "${accountKey}:${String(timestampMs).padStart(15, '0')}:${market_id}"
      if (!db.objectStoreNames.contains("funding_history")) {
        db.createObjectStore("funding_history", { keyPath: "uid" });
      }

      // 4. withdrawals: keyPath "uid"
      // uid format: "${accountKey}:${String(timestampMs).padStart(15, '0')}:${id}"
      if (!db.objectStoreNames.contains("withdrawals")) {
        db.createObjectStore("withdrawals", { keyPath: "uid" });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error("Failed to open IndexedDB"));
    };

    request.onblocked = () => {
      console.warn("[IndexedDB] Database open blocked. Close other tabs of this app.");
    };
  });

  return dbPromise;
}

/**
 * Retrieves metadata for a specific account.
 */
export async function getAccountMeta(accountKey: string): Promise<AccountMetaRecord | null> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("accounts_meta", "readonly");
    const store = tx.objectStore("accounts_meta");
    const req = store.get(accountKey);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Saves or updates account metadata.
 */
export async function saveAccountMeta(meta: AccountMetaRecord): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("accounts_meta", "readwrite");
    const store = tx.objectStore("accounts_meta");
    store.put(meta);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieves all stored account metadata records.
 */
export async function getAllAccountMetas(): Promise<AccountMetaRecord[]> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("accounts_meta", "readonly");
    const store = tx.objectStore("accounts_meta");
    const req = store.getAll();

    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Batch-upserts trades for an account using a SINGLE synchronous readwrite transaction.
 * Primary key formatting guarantees natural chronological ascending order in LevelDB B-tree.
 */
export async function upsertTrades(accountKey: string, trades: LighterTrade[]): Promise<number> {
  if (trades.length === 0) return 0;
  const db = await getDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("trades", "readwrite");
    const store = tx.objectStore("trades");

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const tsMs = normalizeTimestampMs(t.timestamp);
      const tid = t.trade_id_str || String(t.trade_id);
      const uid = `${accountKey}:${String(tsMs).padStart(15, "0")}:${tid.padStart(12, "0")}`;

      const record: DbTradeRecord = {
        ...t,
        uid,
        accountKey,
        timestampMs: tsMs,
      };
      store.put(record);
    }

    tx.oncomplete = () => resolve(trades.length);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Batch-upserts hourly position funding history using a single synchronous transaction.
 */
export async function upsertFunding(
  accountKey: string,
  records: PositionFundingRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  const db = await getDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("funding_history", "readwrite");
    const store = tx.objectStore("funding_history");

    for (let i = 0; i < records.length; i++) {
      const f = records[i];
      const tsMs = normalizeTimestampMs(f.timestamp);
      const mId = String(f.market_id);
      const fId = f.funding_id != null ? String(f.funding_id) : "";
      const uid = `${accountKey}:${String(tsMs).padStart(15, "0")}:${mId}${fId ? `:${fId}` : ""}`;

      const record: DbFundingRecord = {
        ...f,
        uid,
        accountKey,
        timestampMs: tsMs,
      };
      store.put(record);
    }

    tx.oncomplete = () => resolve(records.length);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Batch-upserts withdrawals using a single synchronous transaction.
 */
export async function upsertWithdrawals(
  accountKey: string,
  records: WithdrawalRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  const db = await getDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("withdrawals", "readwrite");
    const store = tx.objectStore("withdrawals");

    for (let i = 0; i < records.length; i++) {
      const w = records[i];
      const tsMs = w.timestampMs
        ? normalizeTimestampMs(w.timestampMs)
        : normalizeTimestampMs(w.timestamp);
      const idStr = w.id || `${tsMs}_${w.amount}`;
      const uid = `${accountKey}:${String(tsMs).padStart(15, "0")}:${idStr}`;

      const record: DbWithdrawalRecord = {
        ...w,
        uid,
        accountKey,
        timestampMs: tsMs,
      };
      store.put(record);
    }

    tx.oncomplete = () => resolve(records.length);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Fast primary-key range scan for all trades of an account.
 * Naturally sorted ascending by LevelDB B-tree; calls native C++ .reverse() for instant descending order.
 */
export async function getAccountTrades(accountKey: string): Promise<LighterTrade[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound(`${accountKey}:`, `${accountKey}:\uffff`);

  return new Promise((resolve, reject) => {
    const tx = db.transaction("trades", "readonly");
    const store = tx.objectStore("trades");
    const req = store.getAll(range);

    req.onsuccess = () => {
      const list = (req.result as DbTradeRecord[]) || [];
      // Native reverse in ~1.5ms for 150k items
      list.reverse();
      resolve(list);
    };

    req.onerror = () => reject(req.error);
  });
}

/**
 * Fast primary-key range scan for all position funding of an account, sorted descending.
 */
export async function getAccountFunding(accountKey: string): Promise<PositionFundingRecord[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound(`${accountKey}:`, `${accountKey}:\uffff`);

  return new Promise((resolve, reject) => {
    const tx = db.transaction("funding_history", "readonly");
    const store = tx.objectStore("funding_history");
    const req = store.getAll(range);

    req.onsuccess = () => {
      const list = (req.result as DbFundingRecord[]) || [];
      list.reverse();
      resolve(list);
    };

    req.onerror = () => reject(req.error);
  });
}

/**
 * Fast primary-key range scan for all withdrawals of an account, sorted descending.
 */
export async function getAccountWithdrawals(accountKey: string): Promise<WithdrawalRecord[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound(`${accountKey}:`, `${accountKey}:\uffff`);

  return new Promise((resolve, reject) => {
    const tx = db.transaction("withdrawals", "readonly");
    const store = tx.objectStore("withdrawals");
    const req = store.getAll(range);

    req.onsuccess = () => {
      const list = (req.result as DbWithdrawalRecord[]) || [];
      list.reverse();
      resolve(list);
    };

    req.onerror = () => reject(req.error);
  });
}

/**
 * Clears all records (trades, funding, withdrawals) for a specific account,
 * while preserving accounts_meta.
 */
export async function clearAccountRecords(accountKey: string): Promise<void> {
  const db = await getDb();
  const range = IDBKeyRange.bound(`${accountKey}:`, `${accountKey}:\uffff`);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["trades", "funding_history", "withdrawals"], "readwrite");

    const deleteStoreRange = (storeName: "trades" | "funding_history" | "withdrawals") => {
      const store = tx.objectStore(storeName);
      store.delete(range);
    };

    deleteStoreRange("trades");
    deleteStoreRange("funding_history");
    deleteStoreRange("withdrawals");

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Clears all data for a specific account from all 4 stores.
 */
export async function clearAccount(accountKey: string): Promise<void> {
  const db = await getDb();
  const range = IDBKeyRange.bound(`${accountKey}:`, `${accountKey}:\uffff`);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ["accounts_meta", "trades", "funding_history", "withdrawals"],
      "readwrite",
    );

    tx.objectStore("accounts_meta").delete(accountKey);

    const deleteStoreRange = (storeName: "trades" | "funding_history" | "withdrawals") => {
      const store = tx.objectStore(storeName);
      store.delete(range);
    };

    deleteStoreRange("trades");
    deleteStoreRange("funding_history");
    deleteStoreRange("withdrawals");

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Completely purges all data from the database.
 */
export async function clearAllData(): Promise<void> {
  const db = await getDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ["accounts_meta", "trades", "funding_history", "withdrawals"],
      "readwrite",
    );

    tx.objectStore("accounts_meta").clear();
    tx.objectStore("trades").clear();
    tx.objectStore("funding_history").clear();
    tx.objectStore("withdrawals").clear();

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
