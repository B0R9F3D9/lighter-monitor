import { describe, expect, it } from "bun:test";
import {
  analyzePositionRisk,
  formatSmartPrice,
  formatSmartPriceFast,
  computePositionsFingerprint,
  packPositions,
  unpackPosition,
} from "../src/lighter/math";
import { LighterPosition } from "../src/types";

describe("analyzePositionRisk", () => {
  it("should correctly analyze a real XAU position near liquidation", () => {
    const pos: LighterPosition = {
      market_id: 40,
      symbol: "XAU",
      sign: 1,
      position: "3.1000",
      avg_entry_price: "4282.65",
      position_value: "13229.064000",
      unrealized_pnl: "-47.162912",
      realized_pnl: "0.000000",
      liquidation_price: "4168.387237903226",
      allocated_margin: "664.354485",
    };

    const analysis = analyzePositionRisk(pos);
    expect(analysis).not.toBeNull();
    expect(analysis?.marketId).toBe(40);
    expect(analysis?.symbol).toBe("XAU");
    expect(analysis?.isLong).toBe(true);
    expect(analysis?.size).toBe(3.1);

    // Mark price = 13229.064 / 3.1 = 4267.44
    expect(analysis?.markPrice).toBeCloseTo(4267.44, 1);

    // Distance percent = |4267.44 - 4168.387| / 4267.44 * 100 ≈ 2.32%
    expect(analysis?.distancePercent).not.toBeNull();
    expect(analysis!.distancePercent!).toBeCloseTo(2.32, 1);
    expect(analysis?.tier).toBe("WARN_10");
  });

  it("should return null for zero / closed positions", () => {
    const pos: LighterPosition = {
      market_id: 0,
      symbol: "ETH",
      sign: 1,
      position: "0.0000",
      avg_entry_price: "0.00",
      position_value: "-0.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "0",
      allocated_margin: "0.000000",
    };

    const analysis = analyzePositionRisk(pos);
    expect(analysis).toBeNull();
  });

  it("should return SAFE and null distance when liquidation_price is 0", () => {
    const pos: LighterPosition = {
      market_id: 1,
      symbol: "BTC",
      sign: 1,
      position: "0.5000",
      avg_entry_price: "60000.00",
      position_value: "30000.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "0",
      allocated_margin: "30000.000000",
    };

    const analysis = analyzePositionRisk(pos);
    expect(analysis).not.toBeNull();
    expect(analysis?.distancePercent).toBeNull();
    expect(analysis?.tier).toBe("SAFE");
  });

  it("should correctly classify CRITICAL_2, DANGER_5 and WARN_10 tiers for high leverage", () => {
    // 0.8% distance -> CRITICAL_2 (< 1.0%)
    const critPos: LighterPosition = {
      market_id: 2,
      symbol: "SOL",
      sign: 1,
      position: "10.0000",
      avg_entry_price: "150.00",
      position_value: "1500.000000", // mark = 150
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "148.80", // |150 - 148.80| / 150 = 0.8%
      allocated_margin: "200.000000",
    };
    expect(analyzePositionRisk(critPos)?.tier).toBe("CRITICAL_2");

    // 1.2% distance -> DANGER_5 (< 1.5%)
    const dangerPos: LighterPosition = {
      market_id: 2,
      symbol: "SOL",
      sign: 1,
      position: "10.0000",
      avg_entry_price: "150.00",
      position_value: "1500.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "148.20", // |150 - 148.20| / 150 = 1.2%
      allocated_margin: "200.000000",
    };
    expect(analyzePositionRisk(dangerPos)?.tier).toBe("DANGER_5");

    // 2.0% distance -> WARN_10 (< 2.5%)
    const warnPos: LighterPosition = {
      market_id: 2,
      symbol: "SOL",
      sign: 1,
      position: "10.0000",
      avg_entry_price: "150.00",
      position_value: "1500.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "147.00", // |150 - 147| / 150 = 2.0%
      allocated_margin: "200.000000",
    };
    expect(analyzePositionRisk(warnPos)?.tier).toBe("WARN_10");

    // 4.0% distance -> SAFE (> 2.5%)
    const safePos: LighterPosition = {
      market_id: 2,
      symbol: "SOL",
      sign: 1,
      position: "10.0000",
      avg_entry_price: "150.00",
      position_value: "1500.000000",
      unrealized_pnl: "0.000000",
      realized_pnl: "0.000000",
      liquidation_price: "144.00", // 4% distance
      allocated_margin: "200.000000",
    };
    expect(analyzePositionRisk(safePos)?.tier).toBe("SAFE");
  });
});

describe("formatSmartPrice and formatSmartPriceFast", () => {
  it("formats large numbers with 2 decimals and commas", () => {
    expect(formatSmartPrice(4267.44)).toBe("4,267.44");
    expect(formatSmartPrice(100000)).toBe("100,000.00");
    expect(formatSmartPriceFast(4267.44)).toBe("4,267.44");
    expect(formatSmartPriceFast(100000)).toBe("100,000.00");
  });

  it("formats medium numbers with 4 decimals", () => {
    expect(formatSmartPrice(1.23456)).toBe("1.2346");
    expect(formatSmartPrice(15.5)).toBe("15.5000");
    expect(formatSmartPriceFast(1.23456)).toBe("1.2346");
    expect(formatSmartPriceFast(15.5)).toBe("15.5000");
  });

  it("formats small numbers (< 1) with 6 decimals, and micro prices with 8 decimals", () => {
    expect(formatSmartPrice(0.001234)).toBe("0.001234");
    expect(formatSmartPrice(0.00001234)).toBe("0.00001234");
    expect(formatSmartPriceFast(0.001234)).toBe("0.001234");
    expect(formatSmartPriceFast(0.00001234)).toBe("0.00001234");
  });
});

describe("computePositionsFingerprint and pack/unpack", () => {
  it("computes reproducible 32-bit integer fingerprint", () => {
    const raw = [
      { market_id: 1, position: "0.5", sign: 1 },
      { market_id: 40, position: "-3.1", sign: -1 },
    ];
    const fp1 = computePositionsFingerprint(raw);
    const fp2 = computePositionsFingerprint(raw);
    expect(typeof fp1).toBe("number");
    expect(fp1).toBe(fp2);

    // Changing size changes hash
    const changed = [
      { market_id: 1, position: "0.6", sign: 1 },
      { market_id: 40, position: "-3.1", sign: -1 },
    ];
    expect(computePositionsFingerprint(changed)).not.toBe(fp1);

    // Microlot sizes (< 0.001 BTC) produce distinct hashes
    const micro1 = [{ market_id: 1, position: "0.0004", sign: 1 }];
    const micro2 = [{ market_id: 1, position: "0.0008", sign: 1 }];
    expect(computePositionsFingerprint(micro1)).not.toBe(computePositionsFingerprint(micro2));

    // Closed positions with size 0 do not change fingerprint (identical to packPositions)
    const withClosed = [
      { market_id: 1, position: "0.5", sign: 1 },
      { market_id: 40, position: "-3.1", sign: -1 },
      { market_id: 99, position: "0.000", sign: 1 },
    ];
    expect(computePositionsFingerprint(withClosed)).toBe(fp1);

    // Order commutativity: reversed array produces identical fingerprint
    const reversed = [
      { market_id: 40, position: "-3.1", sign: -1 },
      { market_id: 1, position: "0.5", sign: 1 },
    ];
    expect(computePositionsFingerprint(reversed)).toBe(fp1);
  });

  it("packs positions to compact tuple format and unpacks correctly", () => {
    const raw = [
      {
        market_id: 1,
        symbol: "BTC",
        sign: 1,
        position: "0.5",
        avg_entry_price: "60000",
        liquidation_price: "45000",
      },
    ];
    const packed = packPositions(raw);
    expect(packed).toEqual([[1, "BTC", 1, 60000, 0.5, 45000, 60000, 0]]);

    const unpacked = unpackPosition(packed[0]);
    expect(unpacked).not.toBeNull();
    expect(unpacked?.symbol).toBe("BTC");
    expect(unpacked?.size).toBe(0.5);
    expect(unpacked?.entryPrice).toBe(60000);
    expect(unpacked?.liqPrice).toBe(45000);
    expect(unpacked?.markPrice).toBe(60000);
    expect(unpacked?.unrealizedPnl).toBe(0);
  });

  it("preserves stored markPrice and unrealizedPnl when marketPrices map is empty (Bug #1 fix)", () => {
    const raw = [
      {
        market_id: 1,
        symbol: "BTC",
        sign: 1,
        position: "0.5",
        avg_entry_price: "60000",
        liquidation_price: "45000",
        mark_price: "62000",
        unrealized_pnl: "1000",
      },
    ];
    const packed = packPositions(raw);
    expect(packed).toEqual([[1, "BTC", 1, 60000, 0.5, 45000, 62000, 1000]]);

    // Empty memory prices map (e.g. cold start or different Cloudflare isolate)
    const emptyPrices = new Map<string, number>();
    const unpackedCold = unpackPosition(packed[0], emptyPrices);
    expect(unpackedCold?.markPrice).toBe(62000);
    expect(unpackedCold?.unrealizedPnl).toBe(1000);
    expect(unpackedCold?.distancePercent).toBeCloseTo(((62000 - 45000) / 62000) * 100, 2);

    // Warm memory prices map with live price (e.g. 64000)
    const livePrices = new Map<string, number>([["BTC", 64000]]);
    const unpackedLive = unpackPosition(packed[0], livePrices);
    expect(unpackedLive?.markPrice).toBe(64000);
    expect(unpackedLive?.unrealizedPnl).toBe(2000); // (64000 - 60000) * 0.5
    expect(unpackedLive?.distancePercent).toBeCloseTo(((64000 - 45000) / 64000) * 100, 2);

    // Network-scoped live price resolution (rh vs mainnet)
    const multiNetworkPrices = new Map<string, number>([
      ["rh:BTC", 64500],
      ["mainnet:BTC", 64100],
    ]);
    const unpackedRh = unpackPosition(packed[0], "rh", multiNetworkPrices);
    expect(unpackedRh?.markPrice).toBe(64500);
    expect(unpackedRh?.unrealizedPnl).toBe(2250); // (64500 - 60000) * 0.5

    const unpackedMainnet = unpackPosition(packed[0], "mainnet", multiNetworkPrices);
    expect(unpackedMainnet?.markPrice).toBe(64100);
    expect(unpackedMainnet?.unrealizedPnl).toBe(2050); // (64100 - 60000) * 0.5
  });

  it("supports unpacking legacy 6-tuple packed positions gracefully", () => {
    const legacyTuple: any = [1, "BTC", 1, 60000, 0.5, 45000];
    const unpacked = unpackPosition(legacyTuple);
    expect(unpacked?.markPrice).toBe(60000);
    expect(unpacked?.unrealizedPnl).toBe(0);
    expect(unpacked?.distancePercent).toBeCloseTo(((60000 - 45000) / 60000) * 100, 2);

    const rePacked = packPositions([legacyTuple]);
    expect(rePacked).toEqual([[1, "BTC", 1, 60000, 0.5, 45000, 60000, 0]]);
  });
});
