import {
  LighterAccount,
  CachedPositionPayload,
  TrackedAccountKey,
  LighterNetwork,
  LighterPosition,
  ActivePositionWatchItem,
  WizardState,
  SystemStats,
} from "../types";

// 2. Обновление last_updated_at ТОЛЬКО для упавших запросов (экономия 50% квоты D1)
export async function touchFailedAccounts(
  db: D1Database,
  failedAccounts: TrackedAccountKey[],
): Promise<void> {
  if (failedAccounts.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const statements = failedAccounts.map((item) =>
    db
      .prepare(`
      INSERT INTO account_positions_cache (network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at)
      VALUES (?, ?, '', 0, 0, '[]', ?)
      ON CONFLICT(network, account_index) DO UPDATE SET last_updated_at = excluded.last_updated_at;
    `)
      .bind(item.network, item.accountIndex, now),
  );
  await db.batch(statements);
}

// 3. Пакетное обновление детального кэша для успешно опрошенных аккаунтов
export async function batchUpdatePositionsCache(
  db: D1Database,
  accountsData: Array<{
    network: LighterNetwork;
    account: LighterAccount;
    cachedPositions: CachedPositionPayload[];
  }>,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = accountsData.map((item) => {
    const acc = item.account;
    return db
      .prepare(`
      INSERT INTO account_positions_cache (
        network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(network, account_index) DO UPDATE SET
        l1_address = excluded.l1_address,
        collateral = excluded.collateral,
        total_asset_value = excluded.total_asset_value,
        positions_json = excluded.positions_json,
        last_updated_at = excluded.last_updated_at
    `)
      .bind(
        item.network,
        acc.index,
        acc.l1_address,
        parseFloat(acc.collateral || "0"),
        parseFloat(acc.total_asset_value || "0"),
        JSON.stringify(item.cachedPositions),
        now,
      );
  });

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

export async function getUserThreshold(db: D1Database, telegramId: number): Promise<number> {
  const row = await db
    .prepare("SELECT alert_threshold FROM users WHERE telegram_id = ?")
    .bind(telegramId)
    .first<{ alert_threshold: number }>();
  return row?.alert_threshold ?? 0.5;
}

export async function setUserThreshold(
  db: D1Database,
  telegramId: number,
  threshold: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET alert_threshold = ? WHERE telegram_id = ?")
    .bind(threshold, telegramId)
    .run();
}

export async function getUserSettings(
  db: D1Database,
  telegramId: number,
): Promise<{ alertThreshold: number; mutedUntil: number }> {
  const row = await db
    .prepare("SELECT alert_threshold, muted_until FROM users WHERE telegram_id = ?")
    .bind(telegramId)
    .first<{ alert_threshold: number | null; muted_until: number | null }>();
  return {
    alertThreshold: row?.alert_threshold ?? 0.5,
    mutedUntil: row?.muted_until ?? 0,
  };
}

export async function setUserMute(
  db: D1Database,
  telegramId: number,
  mutedUntil: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET muted_until = ? WHERE telegram_id = ?")
    .bind(mutedUntil, telegramId)
    .run();
}

export async function getUserWizardState(
  db: D1Database,
  telegramId: number,
): Promise<WizardState | null> {
  const row = await db
    .prepare("SELECT wizard_state FROM users WHERE telegram_id = ?")
    .bind(telegramId)
    .first<{ wizard_state: string | null }>();
  if (!row || !row.wizard_state) return null;
  try {
    const state = JSON.parse(row.wizard_state) as WizardState;
    if (state.ts && Math.floor(Date.now() / 1000) - state.ts > 900) {
      await setUserWizardState(db, telegramId, null);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

export async function setUserWizardState(
  db: D1Database,
  telegramId: number,
  state: WizardState | null,
): Promise<void> {
  const val = state
    ? JSON.stringify({ ...state, ts: state.ts || Math.floor(Date.now() / 1000) })
    : null;
  await db
    .prepare("UPDATE users SET wizard_state = ? WHERE telegram_id = ?")
    .bind(val, telegramId)
    .run();
}

export async function updateAccountAlias(
  db: D1Database,
  telegramId: number,
  network: LighterNetwork,
  accountIndex: number,
  alias: string | null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE user_tracked_accounts SET alias = ? WHERE telegram_id = ? AND network = ? AND account_index = ?",
    )
    .bind(alias, telegramId, network, accountIndex)
    .run();
}

export async function removeTrackedAccount(
  db: D1Database,
  telegramId: number,
  network: LighterNetwork,
  accountIndex: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      "DELETE FROM user_tracked_accounts WHERE telegram_id = ? AND network = ? AND account_index = ?",
    )
    .bind(telegramId, network, accountIndex)
    .run();

  await db
    .prepare(
      "DELETE FROM user_token_alerts WHERE telegram_id = ? AND network = ? AND account_index = ?",
    )
    .bind(telegramId, network, accountIndex)
    .run();

  return (res.meta.changes ?? 0) > 0;
}

// 5. Очистка заблокировавшего пользователя через явный batch (без опоры на SQLite PRAGMA foreign_keys)
export async function removeBlockedUser(db: D1Database, telegramId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM user_token_alerts WHERE telegram_id = ?").bind(telegramId),
    db.prepare("DELETE FROM user_tracked_accounts WHERE telegram_id = ?").bind(telegramId),
    db.prepare("DELETE FROM users WHERE telegram_id = ?").bind(telegramId),
  ]);
}

// 6. Адаптивный фоновый Round-Robin (приоритет новым и активным аккаунтам)
export async function getNextAccountsForSync(
  db: D1Database,
  limit: number = 2,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<TrackedAccountKey[]> {
  const query = `
    SELECT DISTINCT uta.network, uta.account_index
    FROM user_tracked_accounts uta
    LEFT JOIN account_positions_cache c
      ON uta.network = c.network AND uta.account_index = c.account_index
    LEFT JOIN (
      SELECT DISTINCT network, account_index FROM account_open_positions
    ) active
      ON uta.network = active.network AND uta.account_index = active.account_index
    ORDER BY
      CASE
        WHEN c.last_updated_at IS NULL THEN 0
        WHEN active.account_index IS NOT NULL AND (? - c.last_updated_at) >= 900 THEN 1
        WHEN c.collateral > 0 AND (? - c.last_updated_at) >= 3600 THEN 2
        WHEN (? - c.last_updated_at) >= 43200 THEN 3
        ELSE 4
      END ASC,
      COALESCE(c.last_updated_at, 0) ASC
    LIMIT ?;
  `;
  const { results } = await db
    .prepare(query)
    .bind(nowSec, nowSec, nowSec, limit)
    .all<{ network: LighterNetwork; account_index: number }>();
  if (!results || results.length === 0) return [];
  return results.map((row) => ({ network: row.network, accountIndex: row.account_index }));
}

// 7. Единый оптимизированный JOIN открытых позиций с поддержкой Reverse Indexing
export async function getActivePositionsForMonitoring(
  db: D1Database,
  filterSymbols?: string[],
): Promise<ActivePositionWatchItem[]> {
  // Защита от лимита переменных SQLite D1 (SQLITE_MAX_VARIABLE_NUMBER / too many SQL variables):
  // При волатильности рынка список filterSymbols может содержать сотни символов со всей биржи.
  // Передача > 50 переменных в IN (...) приводит к ошибке D1_ERROR: too many SQL variables.
  // В таком случае запрашиваем открытые позиции (таблица компактная) и фильтруем in-memory.
  const shouldFilterInSql = filterSymbols && filterSymbols.length > 0 && filterSymbols.length <= 50;

  let whereClause = "";
  const params: any[] = [];

  if (shouldFilterInSql) {
    const placeholders = filterSymbols.map(() => "?").join(", ");
    whereClause = `WHERE aop.symbol IN (${placeholders}) OR uta.last_price IS NULL`;
    params.push(...filterSymbols);
  }

  const query = `
    SELECT
      aop.network,
      aop.account_index,
      aop.market_id,
      aop.symbol,
      aop.is_long,
      aop.entry_price,
      aop.size,
      u.telegram_id,
      COALESCE(u.alert_threshold, 0.5) as alert_threshold,
      COALESCE(u.muted_until, 0) as muted_until,
      uta_acc.alias,
      uta.last_price,
      uta.last_alerted_at
    FROM account_open_positions aop
    JOIN user_tracked_accounts uta_acc
      ON aop.network = uta_acc.network AND aop.account_index = uta_acc.account_index
    JOIN users u
      ON uta_acc.telegram_id = u.telegram_id
    LEFT JOIN user_token_alerts uta
      ON uta.telegram_id = u.telegram_id
     AND uta.network = aop.network
     AND uta.account_index = aop.account_index
     AND uta.market_id = aop.market_id
    ${whereClause}
    ORDER BY u.telegram_id ASC, aop.network ASC, aop.account_index ASC;
  `;
  const stmt = params.length > 0 ? db.prepare(query).bind(...params) : db.prepare(query);
  const { results } = await stmt.all<ActivePositionWatchItem>();
  const items = results || [];

  // Если список символов был больше 50 и не фильтровался в SQL, фильтруем in-memory
  if (filterSymbols && filterSymbols.length > 0 && !shouldFilterInSql) {
    const filterSet = new Set(filterSymbols.map((s) => s.toUpperCase()));
    return items.filter(
      (item) => item.last_price === null || filterSet.has(item.symbol.toUpperCase()),
    );
  }

  return items;
}

// 9. Синхронизация открытых позиций аккаунта (удаление закрытых, добавление новых)
export async function syncAccountOpenPositions(
  db: D1Database,
  network: LighterNetwork,
  accountIndex: number,
  positions: LighterPosition[],
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const active = positions.filter((p) => Math.abs(parseFloat(p.position || "0")) > 0);

  if (active.length === 0) {
    await db.batch([
      db
        .prepare("DELETE FROM account_open_positions WHERE network = ? AND account_index = ?")
        .bind(network, accountIndex),
      db
        .prepare("DELETE FROM user_token_alerts WHERE network = ? AND account_index = ?")
        .bind(network, accountIndex),
    ]);
    return;
  }

  const activeMarketIds = active.map((p) => p.market_id);
  const placeholders = activeMarketIds.map(() => "?").join(",");

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`
      DELETE FROM account_open_positions
      WHERE network = ? AND account_index = ? AND market_id NOT IN (${placeholders})
    `)
      .bind(network, accountIndex, ...activeMarketIds),
    db
      .prepare(`
      DELETE FROM user_token_alerts
      WHERE network = ? AND account_index = ? AND market_id NOT IN (${placeholders})
    `)
      .bind(network, accountIndex, ...activeMarketIds),
  ];

  for (const p of active) {
    const isLong = (p.sign ?? (parseFloat(p.position) > 0 ? 1 : -1)) > 0 ? 1 : 0;
    stmts.push(
      db
        .prepare(`
      INSERT INTO account_open_positions (
        network, account_index, market_id, symbol, is_long, entry_price, size, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(network, account_index, market_id) DO UPDATE SET
        symbol = excluded.symbol,
        is_long = excluded.is_long,
        entry_price = excluded.entry_price,
        size = excluded.size,
        last_updated_at = excluded.last_updated_at
    `)
        .bind(
          network,
          accountIndex,
          p.market_id,
          p.symbol.toUpperCase(),
          isLong,
          parseFloat(p.avg_entry_price || "0"),
          Math.abs(parseFloat(p.position || "0")),
          now,
        ),
    );
  }

  await db.batch(stmts);
}

// 10. Системные и бизнес-метрики для админ-панели (/stats) — 1 сетевой round-trip через db.batch
export async function getSystemStats(db: D1Database): Promise<SystemStats> {
  const now = Math.floor(Date.now() / 1000);

  const [summaryRes, tokensRes] = await db.batch([
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM user_tracked_accounts) as total_tracked,
        (SELECT COUNT(*) FROM user_tracked_accounts WHERE network = 'rh') as tracked_rh,
        (SELECT COUNT(*) FROM user_tracked_accounts WHERE network = 'mainnet') as tracked_mainnet,
        (SELECT COUNT(*) FROM account_open_positions) as active_positions,
        (SELECT MIN(last_updated_at) FROM account_positions_cache) as oldest_cache
    `),
    db.prepare(`
      SELECT symbol, COUNT(*) as count 
      FROM account_open_positions 
      GROUP BY symbol 
      ORDER BY count DESC 
      LIMIT 5
    `),
  ]);

  const summary = ((summaryRes as any)?.results?.[0] || {}) as {
    total_users?: number;
    total_tracked?: number;
    tracked_rh?: number;
    tracked_mainnet?: number;
    active_positions?: number;
    oldest_cache?: number | null;
  };

  const topTokens = ((tokensRes as any)?.results || []) as Array<{ symbol: string; count: number }>;

  const oldest = summary.oldest_cache;
  const lagSeconds = oldest && oldest > 0 ? now - oldest : 0;

  return {
    totalUsers: summary.total_users || 0,
    totalTracked: summary.total_tracked || 0,
    trackedRh: summary.tracked_rh || 0,
    trackedMainnet: summary.tracked_mainnet || 0,
    activePositionsCount: summary.active_positions || 0,
    maxQueueLagMinutes: Math.round(lagSeconds / 60),
    topTokens,
  };
}
