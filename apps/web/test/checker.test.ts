import { describe, expect, it } from "bun:test";
import { formatTimestampUtc, normalizeTimestampMs, parseTradeForView } from "../src/checker/api";
import type { LighterTrade } from "../src/checker/types";

describe("Checker: API & Calculations", () => {
  const mockTrades: LighterTrade[] = [
    {
      trade_id: 101,
      trade_id_str: "101",
      tx_hash: "0xabc123",
      type: "trade",
      market_id: 1,
      size: "2.5",
      price: "2000.00",
      usd_amount: "5000.00",
      ask_id: 1,
      bid_id: 2,
      ask_account_id: 9999,
      bid_account_id: 12345, // User is BUYER
      is_maker_ask: true, // Ask is maker -> User (bid) is TAKER
      block_height: 1000,
      timestamp: 1727827200, // 2024-10-02T00:00:00Z in seconds
      taker_fee: 50, // 0.0050 USD
      maker_fee: 20,
      bid_account_pnl: "150.25",
      ask_account_pnl: "-150.25",
    },
    {
      trade_id: 102,
      trade_id_str: "102",
      tx_hash: "0xdef456",
      type: "trade",
      market_id: 2,
      size: "10.0",
      price: "150.00",
      usd_amount: "1500.00",
      ask_id: 3,
      bid_id: 4,
      ask_account_id: 12345, // User is SELLER
      bid_account_id: 8888,
      is_maker_ask: true, // Ask is maker -> User (ask) is MAKER
      block_height: 1005,
      timestamp: 1727830800000, // in milliseconds
      taker_fee: 15,
      maker_fee: 0,
      bid_account_pnl: "0.00",
      ask_account_pnl: "-25.50",
    },
  ];

  it("normalizeTimestampMs handles both seconds and milliseconds", () => {
    expect(normalizeTimestampMs(1727827200)).toBe(1727827200000);
    expect(normalizeTimestampMs(1727830800000)).toBe(1727830800000);
    expect(normalizeTimestampMs(0)).toBe(0);
  });

  it("formatTimestampUtc formats timestamp into clean UTC string", () => {
    const formatted = formatTimestampUtc(1727827200000);
    expect(formatted).toBe("2024-10-02 00:00:00");
  });

  it("parseTradeForView parses buyer trade as BUY, TAKER with positive PnL", () => {
    const marketMap = new Map<number, string>([[1, "ETH-PERP"]]);
    const parsed = parseTradeForView(mockTrades[0], 12345, marketMap);

    expect(parsed.tradeId).toBe("101");
    expect(parsed.marketSymbol).toBe("ETH-PERP");
    expect(parsed.side).toBe("BUY");
    expect(parsed.role).toBe("TAKER");
    expect(parsed.price).toBe(2000.0);
    expect(parsed.size).toBe(2.5);
    expect(parsed.usdValue).toBe(5000.0);
    expect(parsed.realizedPnl).toBe(150.25);
    expect(parsed.txHash).toBe("0xabc123");
  });

  it("parseTradeForView parses seller trade as SELL, MAKER with negative PnL", () => {
    const marketMap = new Map<number, string>([[2, "SOL-PERP"]]);
    const parsed = parseTradeForView(mockTrades[1], 12345, marketMap);

    expect(parsed.tradeId).toBe("102");
    expect(parsed.marketSymbol).toBe("SOL-PERP");
    expect(parsed.side).toBe("SELL");
    expect(parsed.role).toBe("MAKER");
    expect(parsed.realizedPnl).toBe(-25.5);
  });

  it("parseLighterToken and maskToken handle canonical ro: tokens and standard tokens", async () => {
    const { parseLighterToken, maskToken } = await import("../src/checker/sync");

    // Canonical ro token format
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    const roToken = `ro:31704:readonly:${futureExpiry}:0xabc1234567890abcdef1234567890abcdef12345`;
    const parsed = parseLighterToken(roToken);
    expect(parsed.accountIndex).toBe(31704);
    expect(parsed.expiryMs).toBe(futureExpiry * 1000);
    expect(parsed.expiryMs! > Date.now()).toBe(true);

    // Masked token verification
    const masked = maskToken(roToken);
    expect(masked).toBe("ro:31704:••••••••••••2345");
    expect(masked).not.toContain("0xabc1234567890");

    // Expired token verification
    const pastExpiry = Math.floor(Date.now() / 1000) - 3600;
    const expiredToken = `ro:31704:readonly:${pastExpiry}:0xsig`;
    const parsedExpired = parseLighterToken(expiredToken);
    expect(parsedExpired.expiryMs! < Date.now()).toBe(true);

    // Standard 4-part token: <account_index>:<key>:<expiry>:<sig>
    const standardToken = `749329:0:${futureExpiry}:0xabcdef1234567890`;
    const parsedStandard = parseLighterToken(standardToken);
    expect(parsedStandard.accountIndex).toBe(749329);
    expect(parsedStandard.keyIndex).toBe(0);
    expect(parsedStandard.expiryMs).toBe(futureExpiry * 1000);

    // Invalid token throws
    expect(() => parseLighterToken("not-a-token")).toThrow();
    expect(() => parseLighterToken("")).toThrow();
  });

  it("parseTradeForView precomputes searchIndex and tradeIdNum for instant filtering and sorting", () => {
    const marketMap = new Map<number, string>([[1, "ETH-PERP"]]);
    const parsed = parseTradeForView(mockTrades[0], 12345, marketMap);

    expect(parsed.tradeIdNum).toBe(101);
    expect(parsed.searchIndex).toBeDefined();
    expect(parsed.searchIndex).toContain("eth-perp");
    expect(parsed.searchIndex).toContain("buy");
    expect(parsed.searchIndex).toContain("taker");
    expect(parsed.searchIndex).toContain("101");
    expect(parsed.searchIndex).toContain("0xabc123");
  });

  it("sortTradesChronologicalDesc correctly sorts unsorted trades and preserves already sorted trades in O(N)", async () => {
    const { sortTradesChronologicalDesc } = await import("../src/checker/api");
    const t1 = { ...mockTrades[0], timestamp: 1000, trade_id: 1, trade_id_str: "1" };
    const t2 = { ...mockTrades[0], timestamp: 2000, trade_id: 2, trade_id_str: "2" };
    const t3 = { ...mockTrades[0], timestamp: 3000, trade_id: 3, trade_id_str: "3" };

    const unsorted = [t1, t3, t2];
    const sorted = sortTradesChronologicalDesc(unsorted);
    expect(sorted.map((t) => t.trade_id)).toEqual([3, 2, 1]);

    // Already sorted array passes O(N) fast path
    const alreadySorted = [...sorted];
    const reSorted = sortTradesChronologicalDesc(alreadySorted);
    expect(reSorted).toEqual(sorted);
  });

  it("matchHedgeTrades executes large dataset (5,000 trades) in milliseconds via O(N+M) sliding window", async () => {
    const { matchHedgeTrades } = await import("../src/checker/hedge");
    const rhTrades: any[] = [];
    const coreTrades: any[] = [];

    const baseTime = 1700000000000;
    for (let i = 0; i < 2500; i++) {
      rhTrades.push({
        raw: { trade_id: i * 2 + 1, transaction_time: (baseTime + i * 100) * 1000 },
        tradeId: `rh-${i}`,
        tradeIdNum: i * 2 + 1,
        timeFormatted: "10:00:00",
        timestampMs: baseTime + i * 100,
        marketSymbol: "BTC",
        marketId: 1,
        marketKind: "perps",
        type: "trade",
        side: "BUY",
        role: "TAKER",
        price: 50000 + (i % 10),
        size: 1.0,
        usdValue: 50000,
        realizedPnl: 0,
        feeUsd: 5.0,
        txHash: "0x1",
        txHashShort: "0x1",
      });

      coreTrades.push({
        raw: { trade_id: i * 2 + 2, transaction_time: (baseTime + i * 100 + 50) * 1000 },
        tradeId: `core-${i}`,
        tradeIdNum: i * 2 + 2,
        timeFormatted: "10:00:00",
        timestampMs: baseTime + i * 100 + 50,
        marketSymbol: "BTC",
        marketId: 1,
        marketKind: "perps",
        type: "trade",
        side: "SELL",
        role: "MAKER",
        price: 50001 + (i % 10),
        size: 1.0,
        usdValue: 50001,
        realizedPnl: 0,
        feeUsd: 2.0,
        txHash: "0x2",
        txHashShort: "0x2",
      });
    }

    const tStart = performance.now();
    const result = matchHedgeTrades(rhTrades, coreTrades, 1, 2, 600, false);
    const elapsed = performance.now() - tStart;

    expect(result.pairs.length).toBe(2500);
    expect(result.unhedged.length).toBe(0);
    // 5,000 trades matched in under 150ms thanks to O(N+M) sliding window (instead of seconds)
    expect(elapsed).toBeLessThan(150);
  });

  it("processTradesFundingHistory correctly accumulates funding and assigns proportionally to position close", async () => {
    const { processTradesFundingHistory } = await import("../src/checker/api");

    const baseTime = 1700000000000;
    const trades: any[] = [
      {
        tradeId: "t1",
        timestampMs: baseTime,
        marketId: 1,
        marketSymbol: "ETH",
        side: "BUY",
        size: 2.0,
        fundingUsd: null,
      },
      {
        tradeId: "t2",
        timestampMs: baseTime + 7200000, // 2 hours later
        marketId: 1,
        marketSymbol: "ETH",
        side: "SELL",
        size: 1.0, // Partial close: 50%
        fundingUsd: null,
      },
      {
        tradeId: "t3",
        timestampMs: baseTime + 10800000, // 3 hours later
        marketId: 1,
        marketSymbol: "ETH",
        side: "SELL",
        size: 1.0, // Full close of remaining 50%
        fundingUsd: null,
      },
    ];

    const fundingHistory: any[] = [
      {
        funding_id: 1,
        market_id: 1,
        timestamp: baseTime + 3600000, // +1 hour: paid $4 funding
        change: "-4.00",
        rate: "0.0001",
      },
      {
        funding_id: 2,
        market_id: 1,
        timestamp: baseTime + 9000000, // +2.5 hours: paid $2 funding
        change: "-2.00",
        rate: "0.0001",
      },
    ];

    const res = processTradesFundingHistory(trades, fundingHistory);

    expect(res.hasFundingHistory).toBe(true);
    // Trade 1 is OPEN -> fundingUsd is null (displays —)
    expect(trades[0].fundingUsd).toBeNull();
    expect(trades[0].isClose).toBe(false);

    // Trade 2 closes 1.0 out of 2.0 (50%). Accumulated funding before t2 was -4.00. 50% of -4.00 = -2.00.
    expect(trades[1].fundingUsd).toBeCloseTo(-2.0, 4);
    expect(trades[1].isClose).toBe(true);

    // Trade 3 closes remaining 1.0. Prior remainder was -2.00, plus new funding of -2.00 = -4.00 total remainder.
    // Closes 100% of remaining position -> -4.00.
    expect(trades[2].fundingUsd).toBeCloseTo(-4.0, 4);
    expect(trades[2].isClose).toBe(true);

    // Total funding attributed to closing trades = -2.00 + -4.00 = -6.00
    expect(res.totalFundingUsd).toBeCloseTo(-6.0, 4);
  });

  it("processTradesFundingHistory sets null funding and hasFundingHistory: false when no funding history is present", async () => {
    const { processTradesFundingHistory } = await import("../src/checker/api");

    const trades: any[] = [
      { tradeId: "t1", timestampMs: 1000, marketId: 1, side: "BUY", size: 1.0 },
      { tradeId: "t2", timestampMs: 2000, marketId: 1, side: "SELL", size: 1.0 },
    ];

    const res = processTradesFundingHistory(trades, undefined);
    expect(res.hasFundingHistory).toBe(false);
    expect(res.totalFundingUsd).toBeNull();
    expect(trades[0].fundingUsd).toBeNull();
    expect(trades[1].fundingUsd).toBeNull();
  });
});
