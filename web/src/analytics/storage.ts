import type { LiveSpreadTick } from "./types";

const DB_NAME = "LighterSpreadAnalyticsDB";
const DB_VERSION = 1;
const STORE_NAME = "live_ticks";

class TicksDatabase {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("IndexedDB is not available in this environment"));
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, {
              keyPath: "id",
              autoIncrement: true,
            });
            store.createIndex("symbol", "symbol", { unique: false });
            store.createIndex("timestampMs", "timestampMs", { unique: false });
            store.createIndex("symbol_ts", ["symbol", "timestampMs"], { unique: false });
          }
        };
        req.addEventListener("success", () => resolve(req.result));
        req.addEventListener("error", () => reject(req.error));
      });
    }
    return this.dbPromise;
  }

  public async saveTick(tick: LiveSpreadTick): Promise<void> {
    try {
      const db = await this.getDb();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.add(tick);
    } catch {
      // Gracefully ignore write failures in private/sandboxed browsers
    }
  }

  public async getTicks(
    symbol: string,
    fromTsMs: number,
    toTsMs: number = Date.now(),
  ): Promise<LiveSpreadTick[]> {
    try {
      const db = await this.getDb();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("symbol_ts");
        const range = IDBKeyRange.bound([symbol, fromTsMs], [symbol, toTsMs]);
        const req = index.getAll(range);

        req.addEventListener("success", () => {
          resolve((req.result as LiveSpreadTick[]) || []);
        });
        req.addEventListener("error", () => resolve([]));
      });
    } catch {
      return [];
    }
  }

  public async pruneOldTicks(maxAgeMs = 30 * 24 * 3600 * 1000): Promise<void> {
    try {
      const db = await this.getDb();
      const cutoff = Date.now() - maxAgeMs;
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("timestampMs");
      const range = IDBKeyRange.upperBound(cutoff);
      const req = index.openKeyCursor(range);

      req.addEventListener("success", (e) => {
        const cursor = (e.target as IDBRequest).result as IDBCursor;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      });
    } catch {}
  }
}

export const ticksStorage = new TicksDatabase();
