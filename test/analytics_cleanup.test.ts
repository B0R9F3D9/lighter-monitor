import { beforeEach, describe, expect, it } from "bun:test";
import { cleanupLegacyStorage } from "../web/src/analytics/cleanup";

describe("cleanupLegacyStorage", () => {
  let mockLocalStorage: Record<string, string>;
  let deleteDbCalls: string[];
  let listeners: Record<string, (() => void)[]>;

  beforeEach(() => {
    mockLocalStorage = {};
    deleteDbCalls = [];
    listeners = {};

    (globalThis as any).window = {};
    (globalThis as any).localStorage = {
      getItem: (key: string) => mockLocalStorage[key] || null,
      setItem: (key: string, val: string) => {
        mockLocalStorage[key] = val;
      },
    };

    (globalThis as any).indexedDB = {
      deleteDatabase: (name: string) => {
        deleteDbCalls.push(name);
        const req: any = {
          addEventListener: (event: string, fn: () => void) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(fn);
          },
        };
        return req;
      },
    };
  });

  it("should request deletion of LighterSpreadAnalyticsDB when not yet cleaned", () => {
    cleanupLegacyStorage();
    expect(deleteDbCalls).toEqual(["LighterSpreadAnalyticsDB"]);
    expect(listeners.success?.length).toBe(1);

    // Trigger success callback
    listeners.success![0]!();
    expect(mockLocalStorage["lighter_legacy_idb_cleaned_v1"]).toBe("1");
  });

  it("should skip deletion if already cleaned up according to localStorage", () => {
    mockLocalStorage["lighter_legacy_idb_cleaned_v1"] = "1";
    cleanupLegacyStorage();
    expect(deleteDbCalls.length).toBe(0);
  });

  it("should mark done even if deletion throws an error event", () => {
    cleanupLegacyStorage();
    expect(deleteDbCalls.length).toBe(1);
    expect(listeners.error?.length).toBe(1);

    listeners.error![0]!();
    expect(mockLocalStorage["lighter_legacy_idb_cleaned_v1"]).toBe("1");
  });

  it("should gracefully handle environments where indexedDB is undefined", () => {
    (globalThis as any).indexedDB = undefined;
    expect(() => cleanupLegacyStorage()).not.toThrow();
  });
});
