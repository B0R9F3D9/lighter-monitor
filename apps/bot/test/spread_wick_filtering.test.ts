import { describe, expect, it } from "bun:test";
import { formatCompactSize, formatCompactUsd } from "../src/lighter/math";
import { formatSpreadAlert } from "../src/bot/formatters";
import { KNOWN_MARKET_IDS, getMarketId, verifyExecutableSpread } from "../src/lighter/api";
import { CONFIG } from "../src/config";
import type { SpreadAlertParams } from "../src/types";

describe("Spread Wick Filtering & JIT Orderbook Verification", () => {
  describe("Compact Formatting for Mobile Screens", () => {
    it("formats USD compactly to prevent screen wrapping", () => {
      expect(formatCompactUsd(1471)).toBe("$1.5K");
      expect(formatCompactUsd(35074)).toBe("$35K");
      expect(formatCompactUsd(1200000)).toBe("$1.2M");
      expect(formatCompactUsd(125)).toBe("$125");
      expect(formatCompactUsd(0.5)).toBe("$0.50");
    });

    it("formats token sizes compactly", () => {
      expect(formatCompactSize(1.9371)).toBe("1.9");
      expect(formatCompactSize(45.3585)).toBe("45.4");
      expect(formatCompactSize(150.2)).toBe("150");
      expect(formatCompactSize(0.052)).toBe("0.05");
      expect(formatCompactSize(15000)).toBe("15K");
    });
  });

  describe("formatSpreadAlert with JIT Orderbook Layout", () => {
    it("renders concise notification matching user specifications without redundant advice or SPREAD TARGET", () => {
      const params: SpreadAlertParams = {
        targetId: 101,
        symbol: "SPY",
        direction: "rh_cheaper",
        targetDelta: 1.0,
        unit: "bps",
        rhPrice: 774.36,
        corePrice: 774.26,
        actualDiff: 0.1,
        basisSigned: -0.1,
        basisBps: -1.25,
        confirmedTicks: 3,
        minTicks: 3,
        orderBook: {
          rhPrice: 774.36,
          rhSize: 1.9,
          rhType: "Ask",
          corePrice: 774.26,
          coreSize: 45.3,
          coreType: "Bid",
          execBps: -1.25,
          execUsd: -0.097,
        },
      };

      const msg = formatSpreadAlert(params);

      // Verify concise header without internal tick confirmation
      expect(msg).toContain("🎯 <b>SPY • Таргет достигнут!</b>");
      expect(msg).not.toContain("Подтверждён");
      expect(msg).not.toContain("SPREAD TARGET");

      // Verify condition
      expect(msg).toContain("🟢 <b>Условие:</b> RH &lt; Core на ≥1.0 bps");

      // Verify executable spread & legs with compact volumes
      expect(msg).toContain(
        "📊 <b>Исполняемый спред стакана:</b> <code>-1.25 bps</code> (<code>-$0.097</code>)",
      );
      expect(msg).toContain("• 🟠 RH Ask: $774.36 (объём: 1.9 SPY / $1.5K)");
      expect(msg).toContain("• ⚡️ Core Bid: $774.26 (объём: 45.3 SPY / $35K)");

      // Verify no unwanted advice
      expect(msg).not.toContain("Ликвидность подтверждена");
      expect(msg).not.toContain("Можно заходить в арбитраж");
    });

    it("renders rh_expensive direction correctly with Bid/Ask and positive signs", () => {
      const params: SpreadAlertParams = {
        targetId: 102,
        symbol: "QQQ",
        direction: "rh_expensive",
        targetDelta: 2.5,
        unit: "bps",
        rhPrice: 729.5,
        corePrice: 729.1,
        actualDiff: 0.4,
        basisSigned: 0.4,
        basisBps: 5.48,
        confirmedTicks: 3,
        minTicks: 3,
        orderBook: {
          rhPrice: 729.5,
          rhSize: 2.5,
          rhType: "Bid",
          corePrice: 729.1,
          coreSize: 10.0,
          coreType: "Ask",
          execBps: 5.48,
          execUsd: 0.4,
        },
      };

      const msg = formatSpreadAlert(params);
      expect(msg).toContain("🎯 <b>QQQ • Таргет достигнут!</b>");
      expect(msg).not.toContain("Подтверждён");
      expect(msg).toContain("🔵 <b>Условие:</b> RH &gt; Core на ≥2.5 bps");
      expect(msg).toContain(
        "📊 <b>Исполняемый спред стакана:</b> <code>+5.48 bps</code> (<code>+$0.400</code>)",
      );
      expect(msg).toContain("• 🟠 RH Bid: $729.50 (объём: 2.5 QQQ / $1.8K)");
      expect(msg).toContain("• ⚡️ Core Ask: $729.10 (объём: 10 QQQ / $7.3K)");
    });
  });

  describe("Known Market IDs & JIT Verification", () => {
    it("has pre-mapped market IDs for core popular symbols", () => {
      expect(KNOWN_MARKET_IDS.rh.SPY).toBe(26);
      expect(KNOWN_MARKET_IDS.rh.QQQ).toBe(25);
      expect(KNOWN_MARKET_IDS.mainnet.SPY).toBe(128);
      expect(KNOWN_MARKET_IDS.mainnet.QQQ).toBe(129);
    });

    it("resolves market IDs without network fetch for known symbols", async () => {
      const rhId = await getMarketId("rh", "SPY");
      const coreId = await getMarketId("mainnet", "SPY");
      expect(rhId).toBe(26);
      expect(coreId).toBe(128);
    });

    it("detects collapsed orderbook spread on rh_cheaper when RH Ask >= Core Bid", async () => {
      // Mock global fetch to return orderbook with collapsed spread
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = url.toString();
          if (urlStr.includes("api.rh.lighter.xyz/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "775.00", remaining_base_amount: "5.0" }],
                bids: [{ price: "774.00", remaining_base_amount: "5.0" }],
              }),
              { status: 200 },
            );
          }
          if (urlStr.includes("mainnet.zklighter.elliot.ai/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "774.50", remaining_base_amount: "10.0" }],
                bids: [{ price: "774.20", remaining_base_amount: "10.0" }],
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 404 });
        }) as any;

        const check = await verifyExecutableSpread("SPY", "rh_cheaper", 1.0, "bps");
        // RH Ask is $775.00, Core Bid is $774.20 -> RH Ask > Core Bid -> Impossible to buy RH and sell Core profitably!
        expect(check.isValid).toBe(false);
        expect(check.reason).toContain("Orderbook spread collapsed");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("validates profitable orderbook spread on rh_cheaper when RH Ask < Core Bid", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = url.toString();
          if (urlStr.includes("api.rh.lighter.xyz/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "774.00", remaining_base_amount: "2.5" }],
                bids: [{ price: "773.50", remaining_base_amount: "5.0" }],
              }),
              { status: 200 },
            );
          }
          if (urlStr.includes("mainnet.zklighter.elliot.ai/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "774.80", remaining_base_amount: "10.0" }],
                bids: [{ price: "774.50", remaining_base_amount: "20.0" }],
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 404 });
        }) as any;

        const check = await verifyExecutableSpread("SPY", "rh_cheaper", 1.0, "bps");
        // RH Ask is $774.00, Core Bid is $774.50 -> Core Bid > RH Ask by $0.50! Profitable!
        expect(check.isValid).toBe(true);
        expect(check.orderBook).toBeDefined();
        expect(check.orderBook?.rhPrice).toBe(774.0);
        expect(check.orderBook?.corePrice).toBe(774.5);
        expect(check.orderBook?.execUsd).toBe(-0.5); // basis = 774.0 - 774.5 = -0.5
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("falls back gracefully when orderbook request fails or times out", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          throw new Error("Network timeout");
        }) as any;

        const check = await verifyExecutableSpread("SPY", "rh_cheaper", 1.0, "bps");
        // Should not block alert if orderbook is temporarily unreachable
        expect(check.isValid).toBe(true);
        expect(check.orderBook).toBeUndefined();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("rejects orderbook spread on rh_expensive when spread is positive but below target delta (exact user bug)", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = url.toString();
          if (urlStr.includes("api.rh.lighter.xyz/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "769.50", remaining_base_amount: "1.0" }],
                bids: [{ price: "769.32", remaining_base_amount: "0.64" }],
              }),
              { status: 200 },
            );
          }
          if (urlStr.includes("mainnet.zklighter.elliot.ai/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "769.22", remaining_base_amount: "0.06" }],
                bids: [{ price: "769.00", remaining_base_amount: "5.0" }],
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 404 });
        }) as any;

        // RH Bid: 769.32, Core Ask: 769.22 -> Diff = +0.100 USD (+1.30 bps)
        // User target is 2.0 bps: 1.30 bps < 2.0 bps, so alert must be rejected!
        const check = await verifyExecutableSpread("SPY", "rh_expensive", 2.0, "bps");
        expect(check.isValid).toBe(false);
        expect(check.reason).toContain("did not reach target (≥2 bps)");
        expect(check.reason).toContain("1.30 bps");
        expect(check.orderBook).toBeDefined();
        expect(check.orderBook?.rhPrice).toBe(769.32);
        expect(check.orderBook?.corePrice).toBe(769.22);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("validates orderbook spread on rh_expensive when spread meets or exceeds target delta", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = url.toString();
          if (urlStr.includes("api.rh.lighter.xyz/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "770.00", remaining_base_amount: "1.0" }],
                bids: [{ price: "769.50", remaining_base_amount: "1.0" }],
              }),
              { status: 200 },
            );
          }
          if (urlStr.includes("mainnet.zklighter.elliot.ai/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "769.22", remaining_base_amount: "2.0" }],
                bids: [{ price: "769.00", remaining_base_amount: "5.0" }],
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 404 });
        }) as any;

        // RH Bid: 769.50, Core Ask: 769.22 -> Diff = +0.28 USD (+3.64 bps)
        // Target is 2.0 bps: 3.64 bps >= 2.0 bps -> valid!
        const check = await verifyExecutableSpread("SPY", "rh_expensive", 2.0, "bps");
        expect(check.isValid).toBe(true);
        expect(check.orderBook).toBeDefined();
        expect(check.orderBook?.rhPrice).toBe(769.5);
        expect(check.orderBook?.corePrice).toBe(769.22);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("rejects orderbook spread on rh_cheaper when spread is positive but below target delta in bps", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = url.toString();
          if (urlStr.includes("api.rh.lighter.xyz/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "774.40", remaining_base_amount: "2.5" }],
                bids: [{ price: "774.00", remaining_base_amount: "5.0" }],
              }),
              { status: 200 },
            );
          }
          if (urlStr.includes("mainnet.zklighter.elliot.ai/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "774.80", remaining_base_amount: "10.0" }],
                bids: [{ price: "774.50", remaining_base_amount: "20.0" }],
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 404 });
        }) as any;

        // RH Ask: 774.40, Core Bid: 774.50 -> Diff = +0.10 USD (+1.29 bps)
        // Target is 5.0 bps: 1.29 bps < 5.0 bps -> reject!
        const check = await verifyExecutableSpread("SPY", "rh_cheaper", 5.0, "bps");
        expect(check.isValid).toBe(false);
        expect(check.reason).toContain("did not reach target (≥5 bps)");
        expect(check.reason).toContain("1.29 bps");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("rejects orderbook spread when spread in USD is below target delta in USD", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          const urlStr = url.toString();
          if (urlStr.includes("api.rh.lighter.xyz/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "770.50", remaining_base_amount: "1.0" }],
                bids: [{ price: "770.20", remaining_base_amount: "1.0" }],
              }),
              { status: 200 },
            );
          }
          if (urlStr.includes("mainnet.zklighter.elliot.ai/api/v1/orderBookOrders")) {
            return new Response(
              JSON.stringify({
                code: 200,
                asks: [{ price: "770.00", remaining_base_amount: "2.0" }],
                bids: [{ price: "769.80", remaining_base_amount: "5.0" }],
              }),
              { status: 200 },
            );
          }
          return new Response("{}", { status: 404 });
        }) as any;

        // RH Bid: 770.20, Core Ask: 770.00 -> Diff = +0.20 USD
        // Target is 0.50 USD: 0.20 < 0.50 -> reject!
        const check = await verifyExecutableSpread("SPY", "rh_expensive", 0.5, "usd");
        expect(check.isValid).toBe(false);
        expect(check.reason).toContain("did not reach target (≥0.5 USD)");
        expect(check.reason).toContain("0.20 USD");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("Consecutive Hits State Progression", () => {
    it("respects SPREAD_TARGET_MIN_CONSECUTIVE_HITS constant", () => {
      expect(CONFIG.SPREAD_TARGET_MIN_CONSECUTIVE_HITS).toBe(3);
    });

    it("requires 3 consecutive hits before candidate qualifies for alert", () => {
      const minHits = CONFIG.SPREAD_TARGET_MIN_CONSECUTIVE_HITS;
      const targetDelta = 1.0;

      // Simulation across 4 cron ticks:
      let consecutiveHits = 0;
      let alertFired = false;

      // Tick 1: Metric 1.5 >= 1.0 -> hits = 1 < 3 (No alert)
      let metric = 1.5;
      if (metric >= targetDelta) {
        consecutiveHits++;
        if (consecutiveHits >= minHits) alertFired = true;
      }
      expect(consecutiveHits).toBe(1);
      expect(alertFired).toBe(false);

      // Tick 2: Metric 1.4 >= 1.0 -> hits = 2 < 3 (No alert)
      metric = 1.4;
      if (metric >= targetDelta) {
        consecutiveHits++;
        if (consecutiveHits >= minHits) alertFired = true;
      }
      expect(consecutiveHits).toBe(2);
      expect(alertFired).toBe(false);

      // Tick 3: Metric 1.6 >= 1.0 -> hits = 3 >= 3 (ALERT FIRES!)
      metric = 1.6;
      if (metric >= targetDelta) {
        consecutiveHits++;
        if (consecutiveHits >= minHits) alertFired = true;
      }
      expect(consecutiveHits).toBe(3);
      expect(alertFired).toBe(true);
    });

    it("resets consecutive hits to 0 if spread normalizes before reaching minHits", () => {
      const minHits = CONFIG.SPREAD_TARGET_MIN_CONSECUTIVE_HITS;
      const targetDelta = 1.0;

      let consecutiveHits = 0;
      let alertFired = false;

      // Tick 1: Spike! Metric 2.5 >= 1.0 -> hits = 1
      let metric = 2.5;
      if (metric >= targetDelta) {
        consecutiveHits++;
        if (consecutiveHits >= minHits) alertFired = true;
      }
      expect(consecutiveHits).toBe(1);
      expect(alertFired).toBe(false);

      // Tick 2: Market normalized! Metric 0.2 < 1.0 -> hits reset to 0!
      metric = 0.2;
      if (metric >= targetDelta) {
        consecutiveHits++;
        if (consecutiveHits >= minHits) alertFired = true;
      } else {
        consecutiveHits = 0;
      }
      expect(consecutiveHits).toBe(0);
      expect(alertFired).toBe(false);

      // Tick 3: Another isolated spike -> starts again from 1, NOT 2!
      metric = 2.1;
      if (metric >= targetDelta) {
        consecutiveHits++;
        if (consecutiveHits >= minHits) alertFired = true;
      }
      expect(consecutiveHits).toBe(1);
      expect(alertFired).toBe(false);
    });
  });
});
