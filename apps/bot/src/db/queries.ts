import {
  LighterAccount,
  CachedPositionPayload,
  TrackedAccountKey,
  LighterNetwork,
  LighterPosition,
  ActivePositionWatchItem,
  WizardState,
  SystemStats,
  SpreadTargetRow,
  SpreadDirection,
  SpreadUnit,
} from "../types";
import { packPositions, computePositionsFingerprint } from "../lighter/math";
import {
  setMemoryAccount,
  getMemoryAccount,
  FastPosition,
  IN_MEMORY_RR_CHECKED,
  getLastCronMetrics,
} from "../cache/memory";

// 2. Обновление last_updated_at ТОЛЬКО для упавших запросов (экономия 50% квоты D1)
export function buildTouchFailedAccountsStmts(
  db: D1Database,
  failedAccounts: TrackedAccountKey[],
  now: number = Math.floor(Date.now() / 1000),
  preparedStmt?: D1PreparedStatement,
): D1PreparedStatement[] {
  const len = failedAccounts.length;
  if (len === 0) return [];
  const stmt =
    preparedStmt ??
    db.prepare(`
      INSERT INTO account_positions_cache (network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at)
      VALUES (?, ?, '', 0, 0, '[]', ?)
      ON CONFLICT(network, account_index) DO UPDATE SET last_updated_at = excluded.last_updated_at;
    `);
  const res: D1PreparedStatement[] = [];
  for (let i = 0; i < len; i++) {
    const item = failedAccounts[i]!;
    res.push(stmt.bind(item.network, item.accountIndex, now));
  }
  return res;
}

export async function touchFailedAccounts(
  db: D1Database,
  failedAccounts: TrackedAccountKey[],
): Promise<void> {
  const stmts = buildTouchFailedAccountsStmts(db, failedAccounts);
  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

export function updateMemoryAccountOnly(
  network: LighterNetwork,
  account: LighterAccount,
  now: number = Math.floor(Date.now() / 1000),
  alias?: string | null,
): void {
  const rawPositions = account.positions || [];
  const packed = packPositions(rawPositions);
  const collateralNum = parseFloat(account.collateral || "0");

  const fastPositions: FastPosition[] = packed.map(
    ([mId, sym, isLong, entry, size, liq, mark, pnl]) => ({
      marketId: mId,
      symbol: sym,
      isLong: isLong === 1,
      entryPrice: entry,
      size,
      liqPrice: liq,
      markPrice: mark ?? entry,
      unrealizedPnl: pnl ?? 0,
    }),
  );
  const fp = computePositionsFingerprint(fastPositions);
  const prevMem = getMemoryAccount(network, account.index);
  setMemoryAccount({
    network,
    accountIndex: account.index,
    alias: alias !== undefined ? alias : (prevMem?.alias ?? null),
    l1Address: account.l1_address,
    collateral: collateralNum,
    lastUpdated: now,
    fingerprint: fp,
    positions: fastPositions,
  });
  IN_MEMORY_RR_CHECKED.set(`${network}:${account.index}`, now);
}

// 3. Пакетное обновление детального кэша для успешно опрошенных аккаунтов (Compact Flat Tuple format)
export function buildBatchUpdatePositionsCacheStmts(
  db: D1Database,
  accountsData: Array<{
    network: LighterNetwork;
    account: LighterAccount;
    cachedPositions: CachedPositionPayload[] | any[];
    alias?: string | null;
  }>,
  now: number = Math.floor(Date.now() / 1000),
  preparedStmt?: D1PreparedStatement,
): D1PreparedStatement[] {
  const len = accountsData.length;
  if (len === 0) return [];
  const stmt =
    preparedStmt ??
    db.prepare(`
      INSERT INTO account_positions_cache (
        network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(network, account_index) DO UPDATE SET
        l1_address = excluded.l1_address,
        collateral = excluded.collateral,
        total_asset_value = excluded.total_asset_value,
        positions_json = excluded.positions_json,
        last_updated_at = excluded.last_updated_at
    `);
  const res: D1PreparedStatement[] = [];
  for (let i = 0; i < len; i++) {
    const item = accountsData[i]!;
    const acc = item.account;
    const rawPositions = item.cachedPositions || acc.positions || [];
    const packed = packPositions(rawPositions);
    const collateralNum = parseFloat(acc.collateral || "0");

    res.push(
      stmt.bind(
        item.network,
        acc.index,
        acc.l1_address ?? "0x0000000000000000000000000000000000000000",
        collateralNum,
        parseFloat(acc.total_asset_value || "0"),
        JSON.stringify(packed),
        now,
      ),
    );

    // Warm up In-Memory Fast State
    updateMemoryAccountOnly(item.network, acc, now, item.alias);
  }
  return res;
}

export async function batchUpdatePositionsCache(
  db: D1Database,
  accountsData: Array<{
    network: LighterNetwork;
    account: LighterAccount;
    cachedPositions: CachedPositionPayload[];
  }>,
): Promise<void> {
  const stmts = buildBatchUpdatePositionsCacheStmts(db, accountsData);
  if (stmts.length > 0) {
    await db.batch(stmts);
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
    db.prepare("DELETE FROM user_spread_targets WHERE telegram_id = ?").bind(telegramId),
    db.prepare("DELETE FROM spread_symbol_mutes WHERE telegram_id = ?").bind(telegramId),
    db.prepare("DELETE FROM users WHERE telegram_id = ?").bind(telegramId),
  ]);
}

// 6. Адаптивный фоновый Round-Robin (приоритет новым и активным аккаунтам, опрос по 5 аккаунтов без задержки)
export async function getNextAccountsForSync(
  db: D1Database,
  limit: number = 5,
  nowSec: number = Math.floor(Date.now() / 1000),
  minStalenessSec: number = 0, // 0 = без задержки, проверяем пачку на каждом тике
): Promise<TrackedAccountKey[]> {
  const query = `
    SELECT DISTINCT uta.network, uta.account_index, c.positions_json, c.last_updated_at, c.collateral
    FROM user_tracked_accounts uta
    LEFT JOIN account_positions_cache c
      ON uta.network = c.network AND uta.account_index = c.account_index
    LEFT JOIN account_open_positions aop
      ON uta.network = aop.network AND uta.account_index = aop.account_index
    WHERE (c.last_updated_at IS NULL OR (? - c.last_updated_at) >= ?)
      AND (c.last_updated_at IS NULL OR aop.account_index IS NOT NULL OR c.collateral > 0)
    ORDER BY
      CASE
        WHEN c.last_updated_at IS NULL THEN 0
        WHEN aop.account_index IS NOT NULL THEN 1
        WHEN c.collateral > 0 THEN 2
        ELSE 3
      END ASC,
      COALESCE(c.last_updated_at, 0) ASC
    LIMIT 50;
  `;
  const { results } = await db.prepare(query).bind(nowSec, minStalenessSec).all<{
    network: LighterNetwork;
    account_index: number;
    positions_json: string | null;
    last_updated_at: number | null;
    collateral: number | null;
  }>();
  if (!results || results.length === 0) return [];

  // Sort candidates by in-memory effective last synced timestamp
  const sorted = results
    .map((row) => {
      const key = `${row.network}:${row.account_index}`;
      const inMemTime = IN_MEMORY_RR_CHECKED.get(key);
      const effectiveTime = inMemTime !== undefined ? inMemTime : (row.last_updated_at ?? 0);
      return {
        network: row.network,
        accountIndex: row.account_index,
        positionsJson: row.positions_json,
        lastUpdatedAt: row.last_updated_at,
        collateral: row.collateral,
        effectiveTime,
      };
    })
    .toSorted((a, b) => a.effectiveTime - b.effectiveTime);

  return sorted.slice(0, limit).map((c) => ({
    network: c.network,
    accountIndex: c.accountIndex,
    positionsJson: c.positionsJson,
    lastUpdatedAt: c.lastUpdatedAt,
    collateral: c.collateral,
  }));
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
  } else if (filterSymbols && filterSymbols.length === 0) {
    whereClause = `WHERE uta.last_price IS NULL`;
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
      COALESCE(aop.liquidation_price, 0) as liquidation_price,
      aop.last_updated_at,
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

// 7b. Выборка уникальных активных символов для предикатной фильтрации цен
export async function getDistinctActiveSymbols(db: D1Database): Promise<string[]> {
  try {
    const { results } = await db
      .prepare(`
        SELECT DISTINCT UPPER(symbol) as symbol FROM account_open_positions
        UNION
        SELECT DISTINCT UPPER(symbol) as symbol FROM user_spread_targets WHERE is_active = 1
      `)
      .all<{ symbol: string }>();
    if (!results || results.length === 0) return [];
    return results.map((r) => r.symbol);
  } catch (err: any) {
    console.warn("[db] Fallback in getDistinctActiveSymbols:", err?.message || err);
    try {
      const { results } = await db
        .prepare(`SELECT DISTINCT UPPER(symbol) as symbol FROM account_open_positions`)
        .all<{ symbol: string }>();
      return results ? results.map((r) => r.symbol) : [];
    } catch {
      return [];
    }
  }
}

// 8. Авто-миграция схемы базы данных для безопасного запуска
let isSchemaEnsured = false;
export function resetSchemaEnsured(): void {
  isSchemaEnsured = false;
}

export async function ensureDatabaseSchema(db: D1Database): Promise<void> {
  if (isSchemaEnsured) return;
  try {
    await db
      .prepare("ALTER TABLE account_open_positions ADD COLUMN liquidation_price REAL DEFAULT 0")
      .run();
  } catch {}
  try {
    await db
      .prepare(
        "ALTER TABLE account_positions_cache ADD COLUMN fingerprint INTEGER NOT NULL DEFAULT 0",
      )
      .run();
  } catch {}
  try {
    await db
      .prepare("CREATE INDEX IF NOT EXISTS idx_open_pos_symbol ON account_open_positions(symbol)")
      .run();
  } catch {}
  try {
    await db
      .prepare(`
        CREATE TABLE IF NOT EXISTS bot_system_metrics (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      .run();
  } catch {}
  try {
    await db
      .prepare("ALTER TABLE users ADD COLUMN spread_muted_until INTEGER NOT NULL DEFAULT 0")
      .run();
  } catch {}
  try {
    await db
      .prepare(`
        CREATE TABLE IF NOT EXISTS user_spread_targets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_id INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('rh_cheaper', 'rh_expensive')),
          target_delta REAL NOT NULL CHECK (target_delta > 0),
          unit TEXT NOT NULL DEFAULT 'usd' CHECK (unit IN ('usd', 'bps')),
          is_active INTEGER NOT NULL DEFAULT 1,
          armed INTEGER NOT NULL DEFAULT 1,
          muted_until INTEGER NOT NULL DEFAULT 0,
          last_alerted_at INTEGER DEFAULT NULL,
          last_spread REAL DEFAULT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(telegram_id, symbol, direction, target_delta, unit)
        )
      `)
      .run();
  } catch {}
  try {
    await db.prepare("DROP INDEX IF EXISTS idx_spread_targets_user").run();
  } catch {}
  try {
    await db.prepare("DROP INDEX IF EXISTS idx_open_pos_market").run();
  } catch {}
  try {
    await db.prepare("DROP INDEX IF EXISTS idx_spread_targets_active").run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_spread_targets_active_v2 ON user_spread_targets(is_active, symbol)",
      )
      .run();
  } catch {}
  try {
    await db
      .prepare(`
        CREATE TABLE IF NOT EXISTS spread_symbol_mutes (
          telegram_id INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          muted_until INTEGER NOT NULL,
          PRIMARY KEY (telegram_id, symbol)
        )
      `)
      .run();
  } catch {}

  isSchemaEnsured = true;
}

// 9. Синхронизация открытых позиций аккаунта (удаление закрытых, добавление новых)
export function buildSyncAccountOpenPositionsStmts(
  db: D1Database,
  network: LighterNetwork,
  accountIndex: number,
  positions: LighterPosition[],
  now: number = Math.floor(Date.now() / 1000),
  preparedUpsertStmt?: D1PreparedStatement,
): D1PreparedStatement[] {
  const active = positions.filter((p) => Math.abs(parseFloat(p.position || "0")) > 0);

  if (active.length === 0) {
    return [
      db
        .prepare("DELETE FROM account_open_positions WHERE network = ? AND account_index = ?")
        .bind(network, accountIndex),
      db
        .prepare("DELETE FROM user_token_alerts WHERE network = ? AND account_index = ?")
        .bind(network, accountIndex),
    ];
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

  const upsertStmt =
    preparedUpsertStmt ??
    db.prepare(`
      INSERT INTO account_open_positions (
        network, account_index, market_id, symbol, is_long, entry_price, size, liquidation_price, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(network, account_index, market_id) DO UPDATE SET
        symbol = excluded.symbol,
        is_long = excluded.is_long,
        entry_price = excluded.entry_price,
        size = excluded.size,
        liquidation_price = excluded.liquidation_price,
        last_updated_at = excluded.last_updated_at
      WHERE account_open_positions.size != excluded.size
         OR account_open_positions.entry_price != excluded.entry_price
         OR account_open_positions.is_long != excluded.is_long
         OR ABS(account_open_positions.liquidation_price - excluded.liquidation_price) > 0.01
    `);

  for (let i = 0; i < active.length; i++) {
    const p = active[i]!;
    const isLong = (p.sign ?? (parseFloat(p.position) > 0 ? 1 : -1)) > 0 ? 1 : 0;
    const liqPrice = parseFloat(p.liquidation_price || "0");
    stmts.push(
      upsertStmt.bind(
        network,
        accountIndex,
        p.market_id,
        p.symbol.toUpperCase(),
        isLong,
        parseFloat(p.avg_entry_price || "0"),
        Math.abs(parseFloat(p.position || "0")),
        liqPrice,
        now,
      ),
    );
  }

  return stmts;
}

export async function syncAccountOpenPositions(
  db: D1Database,
  network: LighterNetwork,
  accountIndex: number,
  positions: LighterPosition[],
): Promise<void> {
  const stmts = buildSyncAccountOpenPositionsStmts(db, network, accountIndex, positions);
  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

// 10. Системные и бизнес-метрики для админ-панели (/stats) — 1 сетевой round-trip через db.batch
export async function getSystemStats(db: D1Database): Promise<SystemStats> {
  const now = Math.floor(Date.now() / 1000);

  const [summaryRes, tokensRes, metricsRes] = await db.batch([
    db
      .prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE created_at >= ? - 86400) as users_24h,
        (SELECT COUNT(*) FROM user_tracked_accounts) as total_tracked,
        (SELECT COUNT(*) FROM user_tracked_accounts WHERE network = 'rh') as tracked_rh,
        (SELECT COUNT(*) FROM user_tracked_accounts WHERE network = 'mainnet') as tracked_mainnet,
        (SELECT COUNT(DISTINCT network || ':' || account_index) FROM account_open_positions) as active_accounts_count,
        (SELECT COUNT(*) FROM account_open_positions) as active_positions,
        (SELECT COUNT(*) FROM account_open_positions WHERE is_long = 1) as total_longs,
        (SELECT COUNT(*) FROM account_open_positions WHERE is_long = 0) as total_shorts,
        (SELECT COALESCE(SUM(size * entry_price), 0) FROM account_open_positions) as total_open_interest,
        (SELECT COALESCE(SUM(collateral), 0) FROM account_positions_cache) as total_collateral,
        (SELECT MIN(c.last_updated_at)
         FROM account_positions_cache c
         JOIN user_tracked_accounts uta ON c.network = uta.network AND c.account_index = uta.account_index
         WHERE c.collateral > 0
            OR EXISTS (
              SELECT 1 FROM account_open_positions aop
              WHERE aop.network = c.network AND aop.account_index = c.account_index
            )
        ) as oldest_cache,
        (SELECT MAX(c.last_updated_at)
         FROM account_positions_cache c
         JOIN user_tracked_accounts uta ON c.network = uta.network AND c.account_index = uta.account_index
         WHERE c.collateral > 0
            OR EXISTS (
              SELECT 1 FROM account_open_positions aop
              WHERE aop.network = c.network AND aop.account_index = c.account_index
            )
        ) as newest_cache,
        (SELECT AVG(c.last_updated_at)
         FROM account_positions_cache c
         JOIN user_tracked_accounts uta ON c.network = uta.network AND c.account_index = uta.account_index
         WHERE c.collateral > 0
            OR EXISTS (
              SELECT 1 FROM account_open_positions aop
              WHERE aop.network = c.network AND aop.account_index = c.account_index
            )
        ) as avg_cache
    `)
      .bind(now),
    db.prepare(`
      SELECT symbol, COUNT(*) as count 
      FROM account_open_positions 
      GROUP BY symbol 
      ORDER BY count DESC 
      LIMIT 5
    `),
    db.prepare(`
      SELECT key, value_json, updated_at FROM bot_system_metrics WHERE key IN ('last_cron', 'last_cron_error')
    `),
  ]);

  const summary = ((summaryRes as any)?.results?.[0] || {}) as any;
  const topTokens = ((tokensRes as any)?.results || []) as Array<{ symbol: string; count: number }>;
  const metricsRows = ((metricsRes as any)?.results || []) as Array<{
    key: string;
    value_json: string;
    updated_at: number;
  }>;

  let lastCron: any = null;
  let lastCronError: any = null;
  for (const row of metricsRows) {
    if (row.key === "last_cron" && row.value_json) {
      try {
        lastCron = JSON.parse(row.value_json);
      } catch {}
    } else if (row.key === "last_cron_error" && row.value_json) {
      try {
        lastCronError = JSON.parse(row.value_json);
      } catch {}
    }
  }

  const memCron = getLastCronMetrics();
  if (memCron && (!lastCron || (memCron.timestamp ?? 0) >= (lastCron.timestamp ?? 0))) {
    lastCron = memCron;
  }

  const oldest = summary.oldest_cache;
  const newest = summary.newest_cache;
  const avg = summary.avg_cache;

  const maxLagMinutes = oldest && oldest > 0 ? Math.round((now - oldest) / 60) : 0;
  const minLagMinutes = newest && newest > 0 ? Math.round((now - newest) / 60) : 0;
  const avgLagMinutes = avg && avg > 0 ? Math.round((now - avg) / 60) : 0;

  return {
    totalUsers: summary.total_users || 0,
    users24h: summary.users_24h || 0,
    totalTracked: summary.total_tracked || 0,
    trackedRh: summary.tracked_rh || 0,
    trackedMainnet: summary.tracked_mainnet || 0,
    activeAccountsCount: summary.active_accounts_count || 0,
    activePositionsCount: summary.active_positions || 0,
    totalLongs: summary.total_longs || 0,
    totalShorts: summary.total_shorts || 0,
    totalOpenInterestUsd: summary.total_open_interest || 0,
    totalCollateralUsd: summary.total_collateral || 0,
    minQueueLagMinutes: minLagMinutes,
    avgQueueLagMinutes: avgLagMinutes,
    maxQueueLagMinutes: maxLagMinutes,
    topTokens,
    lastCron,
    lastCronError,
  };
}

export interface UserTrackedAccountRow {
  network: LighterNetwork;
  account_index: number;
  alias: string | null;
}

export async function getUserTrackedAccounts(
  db: D1Database,
  telegramId: number,
): Promise<UserTrackedAccountRow[]> {
  const { results } = await db
    .prepare(
      "SELECT network, account_index, alias FROM user_tracked_accounts WHERE telegram_id = ? ORDER BY network ASC, id ASC",
    )
    .bind(telegramId)
    .all<UserTrackedAccountRow>();
  return results || [];
}

export interface UserPositionFullStateRow {
  network: LighterNetwork;
  account_index: number;
  alias: string | null;
  l1_address: string | null;
  collateral: number | string | null;
  positions_json: string | null;
  last_updated_at: number | null;
  alert_threshold: number | null;
}

export async function getUserPositionsFullState(
  db: D1Database,
  telegramId: number,
  filterIndex?: number,
  filterNetwork?: LighterNetwork,
): Promise<{
  rows: UserPositionFullStateRow[];
  userThreshold?: number;
}> {
  let query: string;
  let params: any[];

  if (filterIndex) {
    if (filterNetwork) {
      query = `
        SELECT 
          uta.network, 
          uta.account_index, 
          uta.alias,
          c.l1_address,
          c.collateral,
          c.positions_json,
          c.last_updated_at,
          u.alert_threshold
        FROM user_tracked_accounts uta
        LEFT JOIN users u ON uta.telegram_id = u.telegram_id
        LEFT JOIN account_positions_cache c 
          ON uta.network = c.network AND uta.account_index = c.account_index
        WHERE uta.telegram_id = ? AND uta.network = ? AND uta.account_index = ?
      `;
      params = [telegramId, filterNetwork, filterIndex];
    } else {
      query = `
        SELECT 
          uta.network, 
          uta.account_index, 
          uta.alias,
          c.l1_address,
          c.collateral,
          c.positions_json,
          c.last_updated_at,
          u.alert_threshold
        FROM user_tracked_accounts uta
        LEFT JOIN users u ON uta.telegram_id = u.telegram_id
        LEFT JOIN account_positions_cache c 
          ON uta.network = c.network AND uta.account_index = c.account_index
        WHERE uta.telegram_id = ? AND uta.account_index = ?
      `;
      params = [telegramId, filterIndex];
    }
  } else {
    query = `
      SELECT 
        uta.network, 
        uta.account_index, 
        uta.alias,
        c.l1_address,
        c.collateral,
        c.positions_json,
        c.last_updated_at,
        u.alert_threshold
      FROM user_tracked_accounts uta
      LEFT JOIN users u ON uta.telegram_id = u.telegram_id
      LEFT JOIN account_positions_cache c 
        ON uta.network = c.network AND uta.account_index = c.account_index
      WHERE uta.telegram_id = ?
      ORDER BY uta.network ASC, uta.id ASC
    `;
    params = [telegramId];
  }

  const { results } = await db
    .prepare(query)
    .bind(...params)
    .all<UserPositionFullStateRow>();
  const rows = results || [];
  const userThreshold = rows[0]?.alert_threshold ?? undefined;

  return { rows, userThreshold };
}

export async function getAccountsPositionsCache(
  db: D1Database,
  accounts: Array<{ network: LighterNetwork; account_index: number }>,
): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (accounts.length === 0) return map;

  const rows = await Promise.all(
    accounts.map((item) =>
      db
        .prepare("SELECT * FROM account_positions_cache WHERE network = ? AND account_index = ?")
        .bind(item.network, item.account_index)
        .first<any>(),
    ),
  );
  for (const row of rows) {
    if (row) {
      map.set(`${row.network}:${row.account_index}`, row);
    }
  }
  return map;
}

export interface UserAccountCardDetails {
  alias: string | null;
  l1_address: string | null;
  collateral: number | null;
  positions_json: string | null;
}

export async function getUserAccountCardDetails(
  db: D1Database,
  telegramId: number,
  network: LighterNetwork,
  accountIndex: number,
): Promise<UserAccountCardDetails | null> {
  const cardData = await db
    .prepare(`
      SELECT 
        uta.alias,
        c.l1_address,
        c.collateral,
        c.positions_json
      FROM user_tracked_accounts uta
      LEFT JOIN account_positions_cache c 
        ON uta.network = c.network AND uta.account_index = c.account_index
      WHERE uta.telegram_id = ? AND uta.network = ? AND uta.account_index = ?
    `)
    .bind(telegramId, network, accountIndex)
    .first<UserAccountCardDetails>();

  return cardData || null;
}

// ==========================================
// 17. ТАРГЕТЫ СПРЕДА RH vs CORE (MAINNET)
// ==========================================

export async function getUserSpreadTargets(
  db: D1Database,
  telegramId: number,
): Promise<SpreadTargetRow[]> {
  const { results } = await db
    .prepare(`
      SELECT 
        t.id, t.telegram_id, t.symbol, t.direction, t.target_delta, t.unit,
        t.is_active, t.armed, t.muted_until, t.last_alerted_at, t.last_spread, t.created_at,
        COALESCE(sm.muted_until, 0) as symbol_muted_until
      FROM user_spread_targets t
      LEFT JOIN spread_symbol_mutes sm ON t.telegram_id = sm.telegram_id AND t.symbol = sm.symbol
      WHERE t.telegram_id = ?
      ORDER BY t.symbol ASC, t.direction ASC, t.target_delta ASC
    `)
    .bind(telegramId)
    .all<SpreadTargetRow>();

  return results || [];
}

export async function getUserSpreadStats(
  db: D1Database,
  telegramId: number,
): Promise<{ tokenCount: number; totalTargets: number }> {
  const row = await db
    .prepare(`
      SELECT 
        COUNT(DISTINCT symbol) as token_count,
        COUNT(*) as total_targets
      FROM user_spread_targets
      WHERE telegram_id = ?
    `)
    .bind(telegramId)
    .first<{ token_count: number | null; total_targets: number | null }>();

  return {
    tokenCount: row?.token_count ?? 0,
    totalTargets: row?.total_targets ?? 0,
  };
}

export async function addSpreadTarget(
  db: D1Database,
  telegramId: number,
  symbol: string,
  direction: SpreadDirection,
  targetDelta: number,
  unit: SpreadUnit = "usd",
  armed: number = 1,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const res = await db
    .prepare(`
      INSERT INTO user_spread_targets (
        telegram_id, symbol, direction, target_delta, unit, is_active, armed, muted_until, created_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)
      ON CONFLICT(telegram_id, symbol, direction, target_delta, unit) DO UPDATE SET
        is_active = 1,
        armed = excluded.armed,
        muted_until = 0
    `)
    .bind(telegramId, normalizedSymbol, direction, targetDelta, unit, armed, nowSec)
    .run();

  return (res.meta.changes ?? 0) > 0;
}

export async function deleteSpreadTarget(
  db: D1Database,
  telegramId: number,
  targetId: number,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM user_spread_targets WHERE id = ? AND telegram_id = ?")
    .bind(targetId, telegramId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function deleteSpreadTargetsBySymbol(
  db: D1Database,
  telegramId: number,
  symbol: string,
): Promise<number> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const res = await db
    .prepare("DELETE FROM user_spread_targets WHERE telegram_id = ? AND symbol = ?")
    .bind(telegramId, normalizedSymbol)
    .run();
  return res.meta.changes ?? 0;
}

export async function toggleSpreadTargetActive(
  db: D1Database,
  telegramId: number,
  targetId: number,
  isActive: number,
): Promise<boolean> {
  if (isActive === 1) {
    const target = await db
      .prepare("SELECT symbol FROM user_spread_targets WHERE id = ? AND telegram_id = ?")
      .bind(targetId, telegramId)
      .first<{ symbol: string }>();

    const stmts: D1PreparedStatement[] = [
      db
        .prepare(
          "UPDATE user_spread_targets SET is_active = 1, muted_until = 0 WHERE id = ? AND telegram_id = ?",
        )
        .bind(targetId, telegramId),
    ];
    if (target?.symbol) {
      stmts.push(
        db
          .prepare("DELETE FROM spread_symbol_mutes WHERE telegram_id = ? AND symbol = ?")
          .bind(telegramId, target.symbol),
      );
    }
    if (db.batch) {
      const res = await db.batch(stmts);
      return (res[0].meta.changes ?? 0) > 0;
    } else {
      let changed = false;
      for (const stmt of stmts) {
        const res = await stmt.run();
        if ((res.meta.changes ?? 0) > 0) changed = true;
      }
      return changed;
    }
  }

  const res = await db
    .prepare("UPDATE user_spread_targets SET is_active = ? WHERE id = ? AND telegram_id = ?")
    .bind(isActive, targetId, telegramId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function updateSpreadTarget(
  db: D1Database,
  telegramId: number,
  targetId: number,
  direction: SpreadDirection,
  targetDelta: number,
  unit: SpreadUnit,
  armed: number = 1,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE OR REPLACE user_spread_targets SET direction = ?, target_delta = ?, unit = ?, armed = ?, is_active = 1, muted_until = 0 WHERE id = ? AND telegram_id = ?",
    )
    .bind(direction, targetDelta, unit, armed, targetId, telegramId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function updateSpreadTargetThreshold(
  db: D1Database,
  telegramId: number,
  targetId: number,
  targetDelta: number,
  unit: SpreadUnit,
  armed: number = 1,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE OR REPLACE user_spread_targets SET target_delta = ?, unit = ?, armed = ?, is_active = 1, muted_until = 0 WHERE id = ? AND telegram_id = ?",
    )
    .bind(targetDelta, unit, armed, targetId, telegramId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function updateSpreadTargetDirection(
  db: D1Database,
  telegramId: number,
  targetId: number,
  direction: SpreadDirection,
  armed: number = 1,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE OR REPLACE user_spread_targets SET direction = ?, armed = ?, is_active = 1, muted_until = 0 WHERE id = ? AND telegram_id = ?",
    )
    .bind(direction, armed, targetId, telegramId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function setSpreadTargetMute(
  db: D1Database,
  telegramId: number,
  targetId: number,
  mutedUntil: number,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE user_spread_targets SET muted_until = ? WHERE id = ? AND telegram_id = ?")
    .bind(mutedUntil, targetId, telegramId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function setSpreadSymbolMute(
  db: D1Database,
  telegramId: number,
  symbol: string,
  mutedUntil: number,
): Promise<void> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  await db
    .prepare(`
      INSERT INTO spread_symbol_mutes (telegram_id, symbol, muted_until)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id, symbol) DO UPDATE SET muted_until = excluded.muted_until
    `)
    .bind(telegramId, normalizedSymbol, mutedUntil)
    .run();
}

export async function setUserSpreadMute(
  db: D1Database,
  telegramId: number,
  mutedUntil: number,
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare("UPDATE users SET spread_muted_until = ? WHERE telegram_id = ?")
      .bind(mutedUntil, telegramId),
  ];
  if (mutedUntil === 0) {
    stmts.push(
      db.prepare("DELETE FROM spread_symbol_mutes WHERE telegram_id = ?").bind(telegramId),
    );
  }
  if (db.batch) {
    await db.batch(stmts);
  } else {
    for (const stmt of stmts) {
      await stmt.run();
    }
  }
}

export async function getUserSpreadMute(db: D1Database, telegramId: number): Promise<number> {
  const row = await db
    .prepare("SELECT spread_muted_until FROM users WHERE telegram_id = ?")
    .bind(telegramId)
    .first<{ spread_muted_until: number | null }>();
  return row?.spread_muted_until ?? 0;
}

export async function getActiveSpreadTargetsForMonitoring(
  db: D1Database,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<SpreadTargetRow[]> {
  try {
    const { results } = await db
      .prepare(`
        SELECT 
          t.id,
          t.telegram_id,
          t.symbol,
          t.direction,
          t.target_delta,
          t.unit,
          t.is_active,
          t.armed,
          t.muted_until,
          t.last_alerted_at,
          t.last_spread,
          t.created_at,
          COALESCE(u.spread_muted_until, 0) as user_spread_muted_until,
          COALESCE(sm.muted_until, 0) as symbol_muted_until
        FROM user_spread_targets t
        JOIN users u ON t.telegram_id = u.telegram_id
        LEFT JOIN spread_symbol_mutes sm ON t.telegram_id = sm.telegram_id AND t.symbol = sm.symbol
        WHERE t.is_active = 1
          AND (
            t.armed = 0
            OR (
              t.muted_until <= ?
              AND COALESCE(u.spread_muted_until, 0) <= ?
              AND COALESCE(sm.muted_until, 0) <= ?
            )
          )
        ORDER BY COALESCE(t.last_alerted_at, 0) ASC, t.id ASC
      `)
      .bind(nowSec, nowSec, nowSec)
      .all<SpreadTargetRow>();

    return results || [];
  } catch (err: any) {
    console.warn("[db] Error in getActiveSpreadTargetsForMonitoring:", err?.message || err);
    return [];
  }
}
