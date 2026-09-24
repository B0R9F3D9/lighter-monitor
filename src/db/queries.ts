import { 
  LighterAccount, 
  CachedPositionPayload, 
  TrackedAccountKey, 
  LighterNetwork, 
  LighterPosition, 
  ActivePositionWatchItem 
} from "../types";

// 2. Обновление last_updated_at ТОЛЬКО для упавших запросов (экономия 50% квоты D1)
export async function touchFailedAccounts(db: D1Database, failedAccounts: TrackedAccountKey[]): Promise<void> {
  if (failedAccounts.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const statements = failedAccounts.map(item =>
    db.prepare(`
      INSERT INTO account_positions_cache (network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at)
      VALUES (?, ?, '', 0, 0, '[]', ?)
      ON CONFLICT(network, account_index) DO UPDATE SET last_updated_at = excluded.last_updated_at;
    `).bind(item.network, item.accountIndex, now)
  );
  await db.batch(statements);
}

// 3. Пакетное обновление детального кэша для успешно опрошенных аккаунтов
export async function batchUpdatePositionsCache(
  db: D1Database, 
  accountsData: Array<{ network: LighterNetwork; account: LighterAccount; cachedPositions: CachedPositionPayload[] }>
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = accountsData.map(item => {
    const acc = item.account;
    return db.prepare(`
      INSERT INTO account_positions_cache (
        network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(network, account_index) DO UPDATE SET
        l1_address = excluded.l1_address,
        collateral = excluded.collateral,
        total_asset_value = excluded.total_asset_value,
        positions_json = excluded.positions_json,
        last_updated_at = excluded.last_updated_at
    `).bind(
      item.network,
      acc.index,
      acc.l1_address,
      parseFloat(acc.collateral || "0"),
      parseFloat(acc.total_asset_value || "0"),
      JSON.stringify(item.cachedPositions),
      now
    );
  });

  if (statements.length > 0) {
    await db.batch(statements);
  }
}


export async function getUserThreshold(db: D1Database, telegramId: number): Promise<number> {
  const row = await db.prepare("SELECT alert_threshold FROM users WHERE telegram_id = ?")
    .bind(telegramId)
    .first<{ alert_threshold: number }>();
  return row?.alert_threshold ?? 0.5;
}

export async function setUserThreshold(db: D1Database, telegramId: number, threshold: number): Promise<void> {
  await db.prepare("UPDATE users SET alert_threshold = ? WHERE telegram_id = ?")
    .bind(threshold, telegramId)
    .run();
}

// 5. Очистка заблокировавшего пользователя через явный batch (без опоры на SQLite PRAGMA foreign_keys)
export async function removeBlockedUser(db: D1Database, telegramId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM user_token_alerts WHERE telegram_id = ?").bind(telegramId),
    db.prepare("DELETE FROM user_tracked_accounts WHERE telegram_id = ?").bind(telegramId),
    db.prepare("DELETE FROM users WHERE telegram_id = ?").bind(telegramId)
  ]);
}

// 6. Тихий фоновый Round-Robin (до N аккаунтов за тик крона)
export async function getNextAccountsForSync(db: D1Database, limit: number = 2): Promise<TrackedAccountKey[]> {
  const query = `
    SELECT DISTINCT uta.network, uta.account_index
    FROM user_tracked_accounts uta
    LEFT JOIN account_positions_cache c 
      ON uta.network = c.network AND uta.account_index = c.account_index
    ORDER BY COALESCE(c.last_updated_at, 0) ASC
    LIMIT ?;
  `;
  const { results } = await db.prepare(query).bind(limit).all<{ network: LighterNetwork; account_index: number }>();
  if (!results || results.length === 0) return [];
  return results.map(row => ({ network: row.network, accountIndex: row.account_index }));
}

export async function getNextAccountForSync(db: D1Database): Promise<TrackedAccountKey | null> {
  const list = await getNextAccountsForSync(db, 1);
  return list[0] || null;
}

// 7. Единый оптимизированный JOIN всех открытых позиций с подписчиками и порогами
export async function getActivePositionsForMonitoring(db: D1Database): Promise<ActivePositionWatchItem[]> {
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
    ORDER BY u.telegram_id ASC, aop.network ASC, aop.account_index ASC;
  `;
  const { results } = await db.prepare(query).all<ActivePositionWatchItem>();
  return results || [];
}

// 9. Синхронизация открытых позиций аккаунта (удаление закрытых, добавление новых)
export async function syncAccountOpenPositions(
  db: D1Database,
  network: LighterNetwork,
  accountIndex: number,
  positions: LighterPosition[]
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const active = positions.filter(p => Math.abs(parseFloat(p.position || "0")) > 0);

  if (active.length === 0) {
    await db.batch([
      db.prepare("DELETE FROM account_open_positions WHERE network = ? AND account_index = ?").bind(network, accountIndex),
      db.prepare("DELETE FROM user_token_alerts WHERE network = ? AND account_index = ?").bind(network, accountIndex)
    ]);
    return;
  }

  const activeMarketIds = active.map(p => p.market_id);
  const placeholders = activeMarketIds.map(() => "?").join(",");

  const stmts: D1PreparedStatement[] = [
    db.prepare(`
      DELETE FROM account_open_positions 
      WHERE network = ? AND account_index = ? AND market_id NOT IN (${placeholders})
    `).bind(network, accountIndex, ...activeMarketIds),
    db.prepare(`
      DELETE FROM user_token_alerts 
      WHERE network = ? AND account_index = ? AND market_id NOT IN (${placeholders})
    `).bind(network, accountIndex, ...activeMarketIds)
  ];

  for (const p of active) {
    const isLong = (p.sign ?? (parseFloat(p.position) > 0 ? 1 : -1)) > 0 ? 1 : 0;
    stmts.push(db.prepare(`
      INSERT INTO account_open_positions (
        network, account_index, market_id, symbol, is_long, entry_price, size, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(network, account_index, market_id) DO UPDATE SET
        symbol = excluded.symbol,
        is_long = excluded.is_long,
        entry_price = excluded.entry_price,
        size = excluded.size,
        last_updated_at = excluded.last_updated_at
    `).bind(
      network,
      accountIndex,
      p.market_id,
      p.symbol.toUpperCase(),
      isLong,
      parseFloat(p.avg_entry_price || "0"),
      Math.abs(parseFloat(p.position || "0")),
      now
    ));
  }

  await db.batch(stmts);
}

