import { describe, expect, it } from "bun:test";
import {
  calculateTradeMetrics,
  detectUserAccounts,
  parseImportedTradesJson,
  parseTradeForView,
  stitchTradeBatches,
} from "../web/src/checker/api";
import { matchHedgeTrades } from "../web/src/checker/hedge";
import type { LighterTrade } from "../web/src/checker/types";

describe("Raw Lighter API Ingestion & Multi-Account Stitching", () => {
  const rawApiUserPayload = {
    code: 200,
    next_cursor: "eyJpbmRleCI6MTA4NzI0NDYwMn0=",
    trades: [
      {
        trade_id: 1255011511,
        trade_id_str: "1255011511",
        tx_hash: "0000000132d3ac69000001a0fd77b897000000000000000000000000000000000000000000000000",
        type: "trade",
        market_id: 15,
        size: "21.1919",
        price: "236.30",
        usd_amount: "5007.645970",
        ask_id: 4503599644828471,
        ask_id_str: "4503599644828471",
        bid_id: 4785074583384364,
        bid_id_str: "4785074583384364",
        ask_client_id: 96763109170455,
        ask_client_id_str: "96763109170455",
        bid_client_id: 34728209528168,
        bid_client_id_str: "34728209528168",
        ask_account_id: 31704,
        bid_account_id: 281474976710551,
        is_maker_ask: false,
        block_height: 32018848,
        timestamp: 1790958876823,
        taker_position_size_before: "21.1919",
        taker_entry_quote_before: "4983.363110",
        taker_initial_margin_fraction_before: 500,
        taker_position_sign_changed: true,
        maker_position_size_before: "0.0000",
        maker_entry_quote_before: "0.000000",
        maker_position_sign_changed: true,
        transaction_time: 1790958876888348,
        ask_account_pnl: "24.282860",
        taker_allocated_margin_usdc_before: 249718220,
        ask_order_version: 0,
        bid_order_version: 0,
      },
    ],
  };

  it("parses zero-trust raw Lighter API JSON with pagination cursor and no root account_index", () => {
    const rawJsonStr = JSON.stringify(rawApiUserPayload);
    const result = parseImportedTradesJson(rawJsonStr, "f12_network_export.json");

    expect(result.trades.length).toBe(1);
    expect(result.nextCursor).toBe("eyJpbmRleCI6MTA4NzI0NDYwMn0=");
    // Auto-detected account from ask_account_pnl and ask_account_id:
    expect(result.accountIndex).toBe(31704);
    expect(result.accountIndices).toEqual([31704]);
    // System counterparty pool 281474976710551 must be excluded from user accounts
    expect(result.accountIndices).not.toContain(281474976710551);
  });

  it("correctly identifies side SELL, role TAKER, and realized PnL for auto-detected account", () => {
    const rawTrade = rawApiUserPayload.trades[0] as LighterTrade;
    const view = parseTradeForView(rawTrade, 31704);

    expect(view.tradeId).toBe("1255011511");
    expect(view.userAccountId).toBe(31704);
    expect(view.side).toBe("SELL"); // ask_account_id = 31704
    expect(view.role).toBe("TAKER"); // is_maker_ask = false -> ask is taker
    expect(view.price).toBe(236.3);
    expect(view.size).toBe(21.1919);
    expect(view.realizedPnl).toBeCloseTo(24.28286, 4);
  });

  it("filters out system liquidity pools and picks true queried user account", () => {
    const trades: LighterTrade[] = [
      {
        trade_id: 1,
        ask_account_id: 31704,
        bid_account_id: 281474976710551, // system pool
        ask_account_pnl: "10.00",
        is_maker_ask: false,
        size: "1",
        price: "100",
        usd_amount: "100",
        market_id: 1,
        timestamp: 1700000000000,
      } as any,
      {
        trade_id: 2,
        ask_account_id: 281474976710551, // system pool
        bid_account_id: 31704,
        bid_account_pnl: "5.50",
        is_maker_ask: true,
        size: "1",
        price: "100",
        usd_amount: "100",
        market_id: 1,
        timestamp: 1700000001000,
      } as any,
    ];

    const detected = detectUserAccounts(trades);
    expect(detected).toEqual([31704]);
    expect(detected).not.toContain(281474976710551);
  });

  it("stitches and deduplicates multiple pagination JSON files across cursor boundaries", () => {
    const page1Trades: LighterTrade[] = [
      {
        trade_id: 101,
        trade_id_str: "101",
        ask_account_id: 31704,
        bid_account_id: 999,
        ask_account_pnl: "1.0",
        is_maker_ask: false,
        size: "2",
        price: "100",
        usd_amount: "200",
        market_id: 1,
        timestamp: 1700000002000,
      } as any,
      {
        trade_id: 102,
        trade_id_str: "102",
        ask_account_id: 31704,
        bid_account_id: 999,
        ask_account_pnl: "2.0",
        is_maker_ask: false,
        size: "1",
        price: "100",
        usd_amount: "100",
        market_id: 1,
        timestamp: 1700000001000,
      } as any,
    ];

    // Page 2 shares trade 102 (pagination cursor overlap) and introduces trade 103
    const page2Trades: LighterTrade[] = [
      {
        trade_id: 102,
        trade_id_str: "102",
        ask_account_id: 31704,
        bid_account_id: 999,
        ask_account_pnl: "2.0",
        is_maker_ask: false,
        size: "1",
        price: "100",
        usd_amount: "100",
        market_id: 1,
        timestamp: 1700000001000,
      } as any,
      {
        trade_id: 103,
        trade_id_str: "103",
        ask_account_id: 31704,
        bid_account_id: 999,
        ask_account_pnl: "3.0",
        is_maker_ask: false,
        size: "3",
        price: "100",
        usd_amount: "300",
        market_id: 1,
        timestamp: 1700000000000,
      } as any,
    ];

    const batch1 = parseImportedTradesJson(
      JSON.stringify({ code: 200, trades: page1Trades }),
      "page1.json",
    );
    const batch2 = parseImportedTradesJson(
      JSON.stringify({ code: 200, trades: page2Trades }),
      "page2.json",
    );

    const stitched = stitchTradeBatches([batch1, batch2]);

    expect(stitched.fileCount).toBe(2);
    expect(stitched.totalRawTradesCount).toBe(4);
    expect(stitched.duplicateTradesCount).toBe(1);
    expect(stitched.trades.length).toBe(3);
    // Deduplicated IDs:
    const ids = stitched.trades.map((t) => t.trade_id);
    expect(ids).toEqual([101, 102, 103]);
  });

  it("stitches multiple accounts in a single window and calculates aggregate metrics", () => {
    // User runs two subaccounts: #31704 and #45000 on RH
    const subaccount1Trades: LighterTrade[] = [
      {
        trade_id: 201,
        trade_id_str: "201",
        ask_account_id: 31704,
        bid_account_id: 9999,
        ask_account_pnl: "12.50",
        is_maker_ask: false,
        size: "5",
        price: "200",
        usd_amount: "1000",
        market_id: 1,
        taker_fee: 5, // 5 bps
        timestamp: 1700000010000,
      } as any,
    ];

    const subaccount2Trades: LighterTrade[] = [
      {
        trade_id: 202,
        trade_id_str: "202",
        ask_account_id: 9999,
        bid_account_id: 45000,
        bid_account_pnl: "8.25",
        is_maker_ask: false,
        size: "10",
        price: "150",
        usd_amount: "1500",
        market_id: 2,
        taker_fee: 5, // 5 bps
        timestamp: 1700000020000,
      } as any,
    ];

    const batchA = parseImportedTradesJson(
      JSON.stringify({ code: 200, trades: subaccount1Trades }),
      "subacc1.json",
    );
    const batchB = parseImportedTradesJson(
      JSON.stringify({ code: 200, trades: subaccount2Trades }),
      "subacc2.json",
    );

    const stitched = stitchTradeBatches([batchA, batchB]);

    expect(stitched.accountIndices).toContain(31704);
    expect(stitched.accountIndices).toContain(45000);
    expect(stitched.trades.length).toBe(2);

    // Parsing views with multi-account query Set/Array:
    const views = stitched.trades.map((t) => parseTradeForView(t, stitched.accountIndices));

    const view202 = views.find((v) => v.tradeId === "202")!;
    expect(view202.userAccountId).toBe(45000);
    expect(view202.side).toBe("BUY");
    expect(view202.realizedPnl).toBeCloseTo(8.25, 2);

    const view201 = views.find((v) => v.tradeId === "201")!;
    expect(view201.userAccountId).toBe(31704);
    expect(view201.side).toBe("SELL");
    expect(view201.realizedPnl).toBeCloseTo(12.5, 2);

    // Summary metrics across all accounts:
    const metrics = calculateTradeMetrics(stitched.trades, stitched.accountIndices);
    expect(metrics.totalTrades).toBe(2);
    expect(metrics.totalVolumeUsd).toBe(2500); // 1000 + 1500
    expect(metrics.totalRealizedPnl).toBeCloseTo(20.75, 2); // 12.50 + 8.25
    expect(metrics.buyTradesCount).toBe(1);
    expect(metrics.sellTradesCount).toBe(1);
  });

  it("matches hedges between multi-account stitched RH stream and Core stream", () => {
    // Stitched RH trades across accounts #31704 and #31705
    const rhTrades: LighterTrade[] = [
      {
        trade_id: 301,
        trade_id_str: "301",
        ask_account_id: 9999,
        bid_account_id: 31704, // BUY 10 BTC @ 60,000 on RH
        is_maker_ask: true,
        size: "10.0",
        price: "60000.0",
        usd_amount: "600000.0",
        market_id: 1,
        timestamp: 1700000000000,
      } as any,
      {
        trade_id: 302,
        trade_id_str: "302",
        ask_account_id: 9999,
        bid_account_id: 31705, // BUY 5 ETH @ 3,000 on RH
        is_maker_ask: true,
        size: "5.0",
        price: "3000.0",
        usd_amount: "15000.0",
        market_id: 2,
        timestamp: 1700000005000,
      } as any,
    ];

    // Core trades from account #70000
    const coreTrades: LighterTrade[] = [
      {
        trade_id: 401,
        trade_id_str: "401",
        ask_account_id: 70000, // SELL 10 BTC @ 60,050 on Core (hedge profit +$500)
        bid_account_id: 9999,
        is_maker_ask: false,
        size: "10.0",
        price: "60050.0",
        usd_amount: "600500.0",
        market_id: 1,
        timestamp: 1700000001000,
      } as any,
      {
        trade_id: 402,
        trade_id_str: "402",
        ask_account_id: 70000, // SELL 5 ETH @ 2,990 on Core (hedge loss -$50)
        bid_account_id: 9999,
        is_maker_ask: false,
        size: "5.0",
        price: "2990.0",
        usd_amount: "14950.0",
        market_id: 2,
        timestamp: 1700000006000,
      } as any,
    ];

    const marketMap = new Map([
      [1, "BTC"],
      [2, "ETH"],
    ]);

    const rhViews = rhTrades.map((t) => parseTradeForView(t, [31704, 31705], marketMap));
    const coreViews = coreTrades.map((t) => parseTradeForView(t, 70000, marketMap));

    const result = matchHedgeTrades(rhViews, coreViews, [31704, 31705], 70000);

    expect(result.pairs.length).toBe(2);
    expect(result.unhedged.length).toBe(0);

    // Verify preservation of multi-account user IDs on pairs:
    const btcPair = result.pairs.find((p) => p.marketSymbol === "BTC")!;
    expect(btcPair.rhUserAccountId).toBe(31704);
    expect(btcPair.coreUserAccountId).toBe(70000);
    expect(btcPair.matchedSize).toBe(10.0);
    expect(btcPair.pricePnlUsd).toBe(500); // 60,050 - 60,000 = +50 * 10 = +500

    const ethPair = result.pairs.find((p) => p.marketSymbol === "ETH")!;
    expect(ethPair.rhUserAccountId).toBe(31705);
    expect(ethPair.coreUserAccountId).toBe(70000);
    expect(ethPair.matchedSize).toBe(5.0);
    expect(ethPair.pricePnlUsd).toBe(-50); // 2,990 - 3,000 = -10 * 5 = -50

    expect(result.metrics.rhAccountIndices).toEqual([31704, 31705]);
    expect(result.metrics.coreAccountIndices).toEqual([70000]);
  });

  it("handles bookmarklet format with counterparties without phantom account pollution in hedge audit", () => {
    // Bookmarklet export from RH (#31704) with trades against various counterparties
    const rhExport = {
      version: "1.0",
      network: "rh",
      account_index: 31704,
      trades: [
        {
          trade_id: 1001,
          ask_account_id: 39,
          bid_account_id: 31704, // User BUY 1 ETH @ 3000
          is_maker_ask: false,
          size: "1.0",
          price: "3000.0",
          usd_amount: "3000.0",
          market_id: 1,
          timestamp: 1700000000000,
          ask_account_pnl: "0",
          bid_account_pnl: "0",
        },
      ],
    };

    // Bookmarklet export from Core (#749329) with trades against various counterparties
    const coreExport = {
      version: "1.0",
      network: "mainnet",
      account_index: 749329,
      trades: [
        {
          trade_id: 2001,
          ask_account_id: 749329, // User SELL 1 ETH @ 3005
          bid_account_id: 702389,
          is_maker_ask: false,
          size: "1.0",
          price: "3005.0",
          usd_amount: "3005.0",
          market_id: 1,
          timestamp: 1700000001000,
          ask_account_pnl: "0",
          bid_account_pnl: "0",
        },
      ],
    };

    const parsedRh = parseImportedTradesJson(JSON.stringify(rhExport));
    const parsedCore = parseImportedTradesJson(JSON.stringify(coreExport));

    // Must NOT contain counterparties #39 or #702389
    expect(parsedRh.accountIndex).toBe(31704);
    expect(parsedRh.accountIndices).toEqual([31704]);
    expect(parsedCore.accountIndex).toBe(749329);
    expect(parsedCore.accountIndices).toEqual([749329]);

    const rhViews = parsedRh.trades.map((t) => parseTradeForView(t, parsedRh.accountIndices));
    const coreViews = parsedCore.trades.map((t) => parseTradeForView(t, parsedCore.accountIndices));

    expect(rhViews[0].side).toBe("BUY");
    expect(coreViews[0].side).toBe("SELL");

    const matchResult = matchHedgeTrades(
      rhViews,
      coreViews,
      parsedRh.accountIndices,
      parsedCore.accountIndices,
    );

    expect(matchResult.pairs.length).toBe(1);
    expect(matchResult.unhedged.length).toBe(0);
    expect(matchResult.pairs[0].matchedSize).toBe(1.0);
    expect(matchResult.pairs[0].pricePnlUsd).toBe(5.0);
  });

  it("collapses raw Lighter API multi-fill orders into (2 fills) during hedge matching", () => {
    // User account #31704 sells 21.1919 AAPL in 2 execution slices (different transaction_time)
    const rawRhApi = {
      code: 200,
      trades: [
        {
          trade_id: 101,
          trade_id_str: "101",
          type: "trade",
          market_id: 15,
          size: "10.0",
          price: "236.30",
          usd_amount: "2363.0",
          ask_id: 4503599644828471,
          bid_id: 4785074583384364,
          ask_account_id: 31704,
          bid_account_id: 281474976710551,
          is_maker_ask: false,
          timestamp: 1790958876823,
          transaction_time: 1790958876888348,
          ask_account_pnl: "10.0",
        },
        {
          trade_id: 102,
          trade_id_str: "102",
          type: "trade",
          market_id: 15,
          size: "11.1919",
          price: "236.30",
          usd_amount: "2644.64597",
          ask_id: 4503599644828471, // same ask_id
          bid_id: 4785074583384365,
          ask_account_id: 31704,
          bid_account_id: 281474976710552,
          is_maker_ask: false,
          timestamp: 1790958876823,
          transaction_time: 1790958876888350,
          ask_account_pnl: "14.28286",
        },
      ],
    };

    // User account #749329 buys 21.1919 AAPL on Core
    const rawCoreApi = {
      code: 200,
      trades: [
        {
          trade_id: 201,
          trade_id_str: "201",
          type: "trade",
          market_id: 15,
          size: "21.1919",
          price: "236.25",
          usd_amount: "5006.586375",
          ask_id: 5000000000000001,
          bid_id: 6000000000000001,
          ask_account_id: 281474976710551,
          bid_account_id: 749329,
          is_maker_ask: false,
          timestamp: 1790958876900,
          transaction_time: 1790958876950000,
          bid_account_pnl: "5.0",
        },
      ],
    };

    const parsedRh = parseImportedTradesJson(JSON.stringify(rawRhApi));
    const parsedCore = parseImportedTradesJson(JSON.stringify(rawCoreApi));

    expect(parsedRh.accountIndices).toEqual([31704]);
    expect(parsedCore.accountIndices).toEqual([749329]);

    const rhViews = parsedRh.trades.map((t) => parseTradeForView(t, parsedRh.accountIndices));
    const coreViews = parsedCore.trades.map((t) => parseTradeForView(t, parsedCore.accountIndices));

    expect(rhViews[0].side).toBe("SELL");
    expect(rhViews[1].side).toBe("SELL");
    expect(coreViews[0].side).toBe("BUY");

    const matchResult = matchHedgeTrades(
      rhViews,
      coreViews,
      parsedRh.accountIndices,
      parsedCore.accountIndices,
      600,
      true, // aggregateFills = true
    );

    expect(matchResult.pairs.length).toBe(1);
    expect(matchResult.unhedged.length).toBe(0);
    expect(matchResult.pairs[0].matchedSize).toBeCloseTo(21.1919, 4);
    expect(matchResult.pairs[0].rhFillsCount).toBe(2);
    expect(matchResult.pairs[0].coreFillsCount).toBe(1);
    expect(matchResult.pairs[0].status).toBe("HEDGED");
  });
});
