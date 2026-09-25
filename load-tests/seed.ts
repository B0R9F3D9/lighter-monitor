/**
 * Synthetic Data Generator for Load Testing & Edge-Case Verification
 * Generates seed.sql with realistic data to stress test Cloudflare Workers & D1.
 */

interface MarketDef {
  symbol: string;
  marketId: number;
  currentPrice: number;
}

const MARKETS: MarketDef[] = [
  { symbol: "XAU", marketId: 40, currentPrice: 4280.0 },
  { symbol: "BTC", marketId: 1, currentPrice: 83850.0 },
  { symbol: "ETH", marketId: 2, currentPrice: 2670.0 },
  { symbol: "SOL", marketId: 3, currentPrice: 116.0 },
  { symbol: "DOGE", marketId: 4, currentPrice: 0.095 },
  { symbol: "AVAX", marketId: 5, currentPrice: 10.1 },
  { symbol: "LINK", marketId: 6, currentPrice: 13.4 },
  { symbol: "PEPE", marketId: 7, currentPrice: 0.00001234 },
];

const SCALE = Math.max(1, parseFloat(process.env.SCALE || process.argv[2] || "1"));

const CONFIG = {
  USERS_COUNT: Math.round(50 * SCALE),
  START_USER_ID: 10001,
  ACCOUNTS_COUNT: Math.round(200 * SCALE),
  START_ACCOUNT_INDEX: 200001,
  POSITIONS_COUNT: Math.round(500 * SCALE),
  NETWORKS: ["rh", "mainnet"] as const,
  WHALE_ACCOUNTS_COUNT: Math.min(50, Math.max(3, Math.round(3 * Math.sqrt(SCALE)))),
  WHALE_USERS_OVERLAP: Math.min(200, Math.max(10, Math.round(10 * Math.sqrt(SCALE)))),
};

function generateSql(): string {
  const now = Math.floor(Date.now() / 1000);
  const sqlLines: string[] = [];

  sqlLines.push("-- ========================================================");
  sqlLines.push(`-- SYNTHETIC SEED DATA FOR STRESS TESTING (SCALE = ${SCALE}x)`);
  sqlLines.push(`-- Generated at: ${new Date().toISOString()}`);
  sqlLines.push(
    `-- Users: ${CONFIG.USERS_COUNT}, Accounts: ${CONFIG.ACCOUNTS_COUNT}, Positions: ${CONFIG.POSITIONS_COUNT}`,
  );
  sqlLines.push("-- ========================================================");
  sqlLines.push("");

  // 1. Очистка синтетических данных (сохраняя живых юзеров < 10000)
  sqlLines.push("-- 1. Очистка старых синтетических данных");
  sqlLines.push("DELETE FROM user_token_alerts WHERE telegram_id >= 10000;");
  sqlLines.push("DELETE FROM account_open_positions WHERE account_index >= 200000;");
  sqlLines.push("DELETE FROM account_positions_cache WHERE account_index >= 200000;");
  sqlLines.push(
    "DELETE FROM user_tracked_accounts WHERE telegram_id >= 10000 OR account_index >= 200000;",
  );
  sqlLines.push("DELETE FROM users WHERE telegram_id >= 10000;");
  sqlLines.push("");

  // 2. Генерация users (с разными порогами и mute)
  sqlLines.push("-- 2. Вставка пользователей");
  const userRows: string[] = [];
  const thresholds = [0.3, 0.4, 0.5, 0.8, 1.0, 1.5, 2.0];

  for (let i = 0; i < CONFIG.USERS_COUNT; i++) {
    const userId = CONFIG.START_USER_ID + i;
    const username = `stress_user_${i + 1}`;
    const firstName = `Trader ${i + 1}`;
    const threshold = thresholds[i % thresholds.length]!;

    let mutedUntil = 0;
    if (i >= 1 && i <= 3) {
      mutedUntil = now + 3600;
    } else if (i >= 4 && i <= 6) {
      mutedUntil = now - 60;
    }

    const createdAt = now - 86400 * (1 + (i % 30));

    userRows.push(
      `(${userId}, '${username}', '${firstName}', ${threshold}, NULL, ${mutedUntil}, ${createdAt})`,
    );
  }

  // Пакетная вставка users чанками по 250
  for (let i = 0; i < userRows.length; i += 250) {
    const chunk = userRows.slice(i, i + 250);
    sqlLines.push(
      `INSERT INTO users (telegram_id, username, first_name, alert_threshold, wizard_state, muted_until, created_at) VALUES\n` +
        chunk.join(",\n") +
        ";",
    );
  }
  sqlLines.push("");

  // 3. Создаем уникальные аккаунты
  interface AccountItem {
    network: "rh" | "mainnet";
    accountIndex: number;
    group: "NEW" | "HOT" | "FRESH" | "DEAD";
    collateral: number;
    lastUpdated: number | null;
  }

  const newThreshold = Math.max(5, Math.floor(CONFIG.ACCOUNTS_COUNT * 0.025));
  const hotThreshold = newThreshold + Math.max(35, Math.floor(CONFIG.ACCOUNTS_COUNT * 0.175));
  const freshThreshold = hotThreshold + Math.max(110, Math.floor(CONFIG.ACCOUNTS_COUNT * 0.55));

  const accounts: AccountItem[] = [];
  for (let i = 0; i < CONFIG.ACCOUNTS_COUNT; i++) {
    const accountIndex = CONFIG.START_ACCOUNT_INDEX + i;
    const network = CONFIG.NETWORKS[i % CONFIG.NETWORKS.length]!;

    let group: "NEW" | "HOT" | "FRESH" | "DEAD";
    let lastUpdated: number | null;
    let collateral: number;

    if (i < newThreshold) {
      group = "NEW";
      lastUpdated = null;
      collateral = 1000.0;
    } else if (i < hotThreshold) {
      group = "HOT";
      lastUpdated = now - 1200;
      collateral = 2500.0;
    } else if (i < freshThreshold) {
      group = "FRESH";
      lastUpdated = now - 60;
      collateral = 500.0;
    } else {
      group = "DEAD";
      lastUpdated = now - 86400;
      collateral = 0.0;
    }

    accounts.push({ network, accountIndex, group, collateral, lastUpdated });
  }

  // 4. Вставка account_positions_cache
  sqlLines.push("-- 3. Вставка кэша аккаунтов (account_positions_cache)");
  const cacheRows: string[] = [];
  for (const acc of accounts) {
    if (acc.lastUpdated === null) continue;
    const l1Addr = `0x${acc.accountIndex.toString(16).padStart(40, "a")}`;
    cacheRows.push(
      `('${acc.network}', ${acc.accountIndex}, '${l1Addr}', ${acc.collateral.toFixed(2)}, ${acc.collateral.toFixed(2)}, '[]', ${acc.lastUpdated})`,
    );
  }

  for (let i = 0; i < cacheRows.length; i += 250) {
    const chunk = cacheRows.slice(i, i + 250);
    sqlLines.push(
      `INSERT INTO account_positions_cache (network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at) VALUES\n` +
        chunk.join(",\n") +
        ";",
    );
  }
  sqlLines.push("");

  // 5. Связка user_tracked_accounts
  sqlLines.push("-- 4. Вставка отслеживаемых аккаунтов (user_tracked_accounts)");
  const trackedRows: string[] = [];
  const seenTracked = new Set<string>();
  const accountToUsersMap = new Map<string, number[]>();

  const addTracked = (tgId: number, net: string, idx: number, alias: string | null) => {
    const key = `${tgId}:${net}:${idx}`;
    if (seenTracked.has(key)) return;
    seenTracked.add(key);
    const accKey = `${net}:${idx}`;
    const trackers = accountToUsersMap.get(accKey) || [];
    trackers.push(tgId);
    accountToUsersMap.set(accKey, trackers);
    const aliasVal = alias ? `'${alias}'` : "NULL";
    trackedRows.push(`(${tgId}, '${net}', ${idx}, ${aliasVal}, ${now})`);
  };

  // 5.1. Китовые кошельки
  for (let w = 0; w < CONFIG.WHALE_ACCOUNTS_COUNT && w < accounts.length; w++) {
    const whaleAcc = accounts[w]!;
    for (let u = 0; u < CONFIG.WHALE_USERS_OVERLAP && u < CONFIG.USERS_COUNT; u++) {
      const tgId = CONFIG.START_USER_ID + u;
      addTracked(tgId, whaleAcc.network, whaleAcc.accountIndex, `Whale #${w + 1}`);
    }
  }

  // 5.2. Распределяем остальные аккаунты по пользователям (по 2-4 на юзера)
  let accCursor = CONFIG.WHALE_ACCOUNTS_COUNT;
  for (let u = 0; u < CONFIG.USERS_COUNT; u++) {
    const tgId = CONFIG.START_USER_ID + u;
    const countForUser = 2 + (u % 3);
    for (let c = 0; c < countForUser; c++) {
      const acc = accounts[accCursor % accounts.length]!;
      accCursor++;
      addTracked(tgId, acc.network, acc.accountIndex, `SubWallet ${c + 1}`);
    }
  }

  for (let i = 0; i < trackedRows.length; i += 250) {
    const chunk = trackedRows.slice(i, i + 250);
    sqlLines.push(
      `INSERT INTO user_tracked_accounts (telegram_id, network, account_index, alias, created_at) VALUES\n` +
        chunk.join(",\n") +
        ";",
    );
  }
  sqlLines.push("");

  // 6. Генерация открытых сделок (account_open_positions)
  sqlLines.push("-- 5. Вставка открытых позиций (account_open_positions)");
  const posRows: string[] = [];
  const generatedPositions: Array<{
    network: string;
    accountIndex: number;
    marketId: number;
    symbol: string;
    isLong: number;
    entryPrice: number;
    size: number;
  }> = [];

  const seenPos = new Set<string>();
  const fundedAccountsCount = Math.max(1, Math.floor(accounts.length * 0.75));

  for (let i = 0; i < CONFIG.POSITIONS_COUNT; i++) {
    const acc = accounts[i % fundedAccountsCount]!;
    const market = MARKETS[i % MARKETS.length]!;

    const posKey = `${acc.network}:${acc.accountIndex}:${market.marketId}`;
    if (seenPos.has(posKey)) continue;
    seenPos.add(posKey);

    const isLong = i % 2 === 0 ? 1 : 0;
    const priceOffset = ((i % 11) - 5) * 0.003;
    const decimals = market.currentPrice < 0.001 ? 8 : 4;
    const entryPrice = parseFloat((market.currentPrice * (1 + priceOffset)).toFixed(decimals));
    const size = parseFloat((1.0 + (i % 10) * 0.5).toFixed(2));
    const liqPrice = parseFloat((entryPrice * (isLong ? 0.85 : 1.15)).toFixed(decimals));

    generatedPositions.push({
      network: acc.network,
      accountIndex: acc.accountIndex,
      marketId: market.marketId,
      symbol: market.symbol,
      isLong,
      entryPrice,
      size,
    });

    posRows.push(
      `('${acc.network}', ${acc.accountIndex}, ${market.marketId}, '${market.symbol}', ${isLong}, ${entryPrice}, ${size}, ${liqPrice}, ${now})`,
    );
  }

  for (let i = 0; i < posRows.length; i += 250) {
    const chunk = posRows.slice(i, i + 250);
    sqlLines.push(
      `INSERT INTO account_open_positions (network, account_index, market_id, symbol, is_long, entry_price, size, liquidation_price, last_updated_at) VALUES\n` +
        chunk.join(",\n") +
        ";",
    );
  }
  sqlLines.push("");

  // 7. Базовые засечки цен в user_token_alerts
  sqlLines.push("-- 6. Вставка базовых отметок цен (user_token_alerts)");
  const alertRows: string[] = [];
  const seenAlerts = new Set<string>();
  let user10001AlertCount = 0;

  for (const pos of generatedPositions) {
    const accKey = `${pos.network}:${pos.accountIndex}`;
    const trackers = accountToUsersMap.get(accKey) || [];

    for (const tgId of trackers) {
      const alertKey = `${tgId}:${pos.network}:${pos.accountIndex}:${pos.marketId}`;
      if (seenAlerts.has(alertKey)) continue;
      seenAlerts.add(alertKey);

      const market = MARKETS.find((m) => m.marketId === pos.marketId)!;
      let hash = (tgId + pos.accountIndex + pos.marketId) % 100;

      let lastPrice: number;
      let lastAlertedAt: number;
      const priceDecimals = market.currentPrice < 0.001 ? 8 : 4;

      if (tgId === CONFIG.START_USER_ID && user10001AlertCount < 4) {
        const delta = 0.045;
        lastPrice = parseFloat((market.currentPrice * (1 - delta)).toFixed(priceDecimals));
        lastAlertedAt = now - 600;
        user10001AlertCount++;
      } else if (hash < 15) {
        continue;
      } else if (hash >= 15 && hash < 40) {
        const delta = hash % 2 === 0 ? 0.022 : -0.018;
        lastPrice = parseFloat((market.currentPrice * (1 - delta)).toFixed(priceDecimals));
        lastAlertedAt = now - 600;
      } else {
        lastPrice = market.currentPrice;
        lastAlertedAt = now - 120;
      }

      alertRows.push(
        `(${tgId}, '${pos.network}', ${pos.accountIndex}, ${pos.marketId}, '${pos.symbol}', ${lastPrice}, ${lastAlertedAt})`,
      );
    }
  }

  for (let i = 0; i < alertRows.length; i += 250) {
    const chunk = alertRows.slice(i, i + 250);
    sqlLines.push(
      `INSERT INTO user_token_alerts (telegram_id, network, account_index, market_id, symbol, last_price, last_alerted_at) VALUES\n` +
        chunk.join(",\n") +
        ";",
    );
  }
  sqlLines.push("");

  return sqlLines.join("\n");
}

console.log(generateSql());
