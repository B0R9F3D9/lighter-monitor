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

const CONFIG = {
  USERS_COUNT: 50,
  START_USER_ID: 10001,
  ACCOUNTS_COUNT: 200,
  START_ACCOUNT_INDEX: 200001,
  POSITIONS_COUNT: 500,
  NETWORKS: ["rh", "mainnet"] as const,
  WHALE_ACCOUNTS_COUNT: 3,
  WHALE_USERS_OVERLAP: 10,
};

function generateSql(): string {
  const now = Math.floor(Date.now() / 1000);
  const sqlLines: string[] = [];

  sqlLines.push("-- ========================================================");
  sqlLines.push("-- SYNTHETIC SEED DATA FOR STRESS TESTING LIGHTER MONITOR");
  sqlLines.push(`-- Generated at: ${new Date().toISOString()}`);
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

  // 2. Генерация users (50 юзеров с разными порогами и mute)
  sqlLines.push("-- 2. Вставка пользователей");
  const userRows: string[] = [];
  const thresholds = [0.3, 0.4, 0.5, 0.8, 1.0, 1.5, 2.0];

  for (let i = 0; i < CONFIG.USERS_COUNT; i++) {
    const userId = CONFIG.START_USER_ID + i;
    const username = `stress_user_${i + 1}`;
    const firstName = `Trader ${i + 1}`;
    const threshold = thresholds[i % thresholds.length]!;

    // КРАЕВЫЕ СЛУЧАИ MUTE:
    // • Юзер 0 (10001): АКТИВНЫЙ (без мута, порог 0.3%) для теста мульти-алертов и троттлинга
    // • Юзеры 1..3 (3 юзера): активный mute на 1 час (фильтруются из алертов)
    // • Юзеры 4..6 (3 юзера): mute истек 60 секунд назад (ДОЛЖНЫ получать алерты)
    // • Остальные юзеры: mute выключен (0)
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

  // Пакетная вставка users
  sqlLines.push(
    `INSERT INTO users (telegram_id, username, first_name, alert_threshold, wizard_state, muted_until, created_at) VALUES\n` +
      userRows.join(",\n") +
      ";",
  );
  sqlLines.push("");

  // 3. Создаем 200 уникальных аккаунтов
  interface AccountItem {
    network: "rh" | "mainnet";
    accountIndex: number;
    group: "NEW" | "HOT" | "FRESH" | "DEAD";
    collateral: number;
    lastUpdated: number | null;
  }

  const accounts: AccountItem[] = [];
  for (let i = 0; i < CONFIG.ACCOUNTS_COUNT; i++) {
    const accountIndex = CONFIG.START_ACCOUNT_INDEX + i;
    const network = CONFIG.NETWORKS[i % CONFIG.NETWORKS.length]!;

    // Распределяем по 4 группам Round-Robin
    let group: "NEW" | "HOT" | "FRESH" | "DEAD";
    let lastUpdated: number | null;
    let collateral: number;

    if (i < 5) {
      // Группа 1: «Новые» — last_updated_at IS NULL (приоритет 0 в Round-Robin)
      group = "NEW";
      lastUpdated = null;
      collateral = 1000.0;
    } else if (i < 40) {
      // Группа 2: «Горячие» — обновлялись 20 мин назад (должны забираться кроном, приоритет 1)
      group = "HOT";
      lastUpdated = now - 1200;
      collateral = 2500.0;
    } else if (i < 150) {
      // Группа 3: «Свежие» — обновлялись 60 сек назад (крон ДОЛЖЕН их пропускать по minStalenessSec)
      group = "FRESH";
      lastUpdated = now - 60;
      collateral = 500.0;
    } else {
      // Группа 4: «Мертвые» — обновлялись сутки назад, нулевой залог
      group = "DEAD";
      lastUpdated = now - 86400;
      collateral = 0.0;
    }

    accounts.push({ network, accountIndex, group, collateral, lastUpdated });
  }

  // 4. Вставка account_positions_cache (для группы NEW запись отсутствует, чтобы LEFT JOIN давал NULL)
  sqlLines.push("-- 3. Вставка кэша аккаунтов (account_positions_cache)");
  const cacheRows: string[] = [];
  for (const acc of accounts) {
    if (acc.lastUpdated === null) continue;
    const l1Addr = `0x${acc.accountIndex.toString(16).padStart(40, "a")}`;
    cacheRows.push(
      `('${acc.network}', ${acc.accountIndex}, '${l1Addr}', ${acc.collateral.toFixed(2)}, ${acc.collateral.toFixed(2)}, '[]', ${acc.lastUpdated})`,
    );
  }

  // Разбиваем вставки на чанки по 100 строк
  for (let i = 0; i < cacheRows.length; i += 100) {
    const chunk = cacheRows.slice(i, i + 100);
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

  const addTracked = (tgId: number, net: string, idx: number, alias: string | null) => {
    const key = `${tgId}:${net}:${idx}`;
    if (seenTracked.has(key)) return;
    seenTracked.add(key);
    const aliasVal = alias ? `'${alias}'` : "NULL";
    trackedRows.push(`(${tgId}, '${net}', ${idx}, ${aliasVal}, ${now})`);
  };

  // 5.1. Три китовых кошелька, отслеживаемых сразу 10 пользователями каждый
  for (let w = 0; w < CONFIG.WHALE_ACCOUNTS_COUNT; w++) {
    const whaleAcc = accounts[w]!;
    for (let u = 0; u < CONFIG.WHALE_USERS_OVERLAP; u++) {
      const tgId = CONFIG.START_USER_ID + u;
      addTracked(tgId, whaleAcc.network, whaleAcc.accountIndex, `Whale #${w + 1}`);
    }
  }

  // 5.2. Распределяем остальные аккаунты по пользователям (по 2-4 на юзера)
  let accCursor = CONFIG.WHALE_ACCOUNTS_COUNT;
  for (let u = 0; u < CONFIG.USERS_COUNT; u++) {
    const tgId = CONFIG.START_USER_ID + u;
    const countForUser = 2 + (u % 3);
    for (let c = 0; c < countForUser && accCursor < accounts.length; c++) {
      const acc = accounts[accCursor++]!;
      addTracked(tgId, acc.network, acc.accountIndex, `SubWallet ${c + 1}`);
    }
  }

  for (let i = 0; i < trackedRows.length; i += 100) {
    const chunk = trackedRows.slice(i, i + 100);
    sqlLines.push(
      `INSERT INTO user_tracked_accounts (telegram_id, network, account_index, alias, created_at) VALUES\n` +
        chunk.join(",\n") +
        ";",
    );
  }
  sqlLines.push("");

  // 6. Генерация 500 открытых сделок (account_open_positions)
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

  for (let i = 0; i < CONFIG.POSITIONS_COUNT; i++) {
    // Выбираем аккаунт (в приоритете первые 150 с залогом > 0)
    const acc = accounts[i % 150]!;
    const market = MARKETS[i % MARKETS.length]!;

    const posKey = `${acc.network}:${acc.accountIndex}:${market.marketId}`;
    if (seenPos.has(posKey)) continue;
    seenPos.add(posKey);

    const isLong = i % 2 === 0 ? 1 : 0;
    // Цена входа близка к текущей (+- 0.5% .. 1.5%)
    const priceOffset = ((i % 11) - 5) * 0.003;
    const decimals = market.currentPrice < 0.001 ? 8 : 4;
    const entryPrice = parseFloat((market.currentPrice * (1 + priceOffset)).toFixed(decimals));
    const size = parseFloat((1.0 + (i % 10) * 0.5).toFixed(2));

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
      `('${acc.network}', ${acc.accountIndex}, ${market.marketId}, '${market.symbol}', ${isLong}, ${entryPrice}, ${size}, ${now})`,
    );
  }

  for (let i = 0; i < posRows.length; i += 100) {
    const chunk = posRows.slice(i, i + 100);
    sqlLines.push(
      `INSERT INTO account_open_positions (network, account_index, market_id, symbol, is_long, entry_price, size, last_updated_at) VALUES\n` +
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

  // Связываем позиции с пользователями, которые отслеживают эти аккаунты
  for (const pos of generatedPositions) {
    // Находим пользователей, которые отслеживают этот аккаунт
    for (let u = 0; u < CONFIG.USERS_COUNT; u++) {
      const tgId = CONFIG.START_USER_ID + u;
      const trackKey = `${tgId}:${pos.network}:${pos.accountIndex}`;
      if (!seenTracked.has(trackKey)) continue;

      const alertKey = `${tgId}:${pos.network}:${pos.accountIndex}:${pos.marketId}`;
      if (seenAlerts.has(alertKey)) continue;
      seenAlerts.add(alertKey);

      const market = MARKETS.find((m) => m.marketId === pos.marketId)!;
      let hash = (tgId + pos.accountIndex + pos.marketId) % 100;

      // Для пользователя 10001: создаем ровно 4 алерта для стресс-теста троттлинга Telegram (850 мс)
      let lastPrice: number;
      let lastAlertedAt: number;
      const priceDecimals = market.currentPrice < 0.001 ? 8 : 4;

      if (tgId === CONFIG.START_USER_ID && user10001AlertCount < 4) {
        // Сильный импульс 4.5% гарантирует первое место в сортировке по срочности
        const delta = 0.045;
        lastPrice = parseFloat((market.currentPrice * (1 - delta)).toFixed(priceDecimals));
        lastAlertedAt = now - 600;
        user10001AlertCount++;
      } else if (hash < 15) {
        // Сценарий 1 (15%): Первый тик -> вообще НЕ создаем запись
        continue;
      } else if (hash >= 15 && hash < 40) {
        // Сценарий 2 (25%): Кандидат на алерт -> импульс цены 1.5% - 2.5%
        const delta = hash % 2 === 0 ? 0.022 : -0.018; // +2.2% или -1.8%
        lastPrice = parseFloat((market.currentPrice * (1 - delta)).toFixed(priceDecimals));
        lastAlertedAt = now - 600; // 10 минут назад (кулдаун уже прошел)
      } else {
        // Сценарий 3 (60%): Спокойная позиция -> цена почти не изменилась (отсекается in-memory)
        lastPrice = market.currentPrice;
        lastAlertedAt = now - 120;
      }

      alertRows.push(
        `(${tgId}, '${pos.network}', ${pos.accountIndex}, ${pos.marketId}, '${pos.symbol}', ${lastPrice}, ${lastAlertedAt})`,
      );
    }
  }

  for (let i = 0; i < alertRows.length; i += 100) {
    const chunk = alertRows.slice(i, i + 100);
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
