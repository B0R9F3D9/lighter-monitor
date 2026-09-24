import { LighterAccount, CachedPositionPayload, SubscriberRecord } from "../types";

// 1. Выборка аккаунтов по честному Round-Robin
export async function getAccountsForCronBatch(db: D1Database, limit: number): Promise<number[]> {
  const query = `
    SELECT DISTINCT u.account_index 
    FROM user_tracked_accounts u
    LEFT JOIN account_positions_cache c ON u.account_index = c.account_index
    ORDER BY COALESCE(c.last_updated_at, 0) ASC
    LIMIT ?;
  `;
  const { results } = await db.prepare(query).bind(limit).all<{ account_index: number }>();
  return results ? results.map(r => r.account_index) : [];
}

// 2. Обновление last_updated_at ТОЛЬКО для упавших запросов (экономия 50% квоты D1)
export async function touchFailedAccounts(db: D1Database, failedIndices: number[]): Promise<void> {
  if (failedIndices.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const values = failedIndices.map(id => `(${id}, '', 0, 0, '[]', ${now})`).join(",");
  const query = `
    INSERT INTO account_positions_cache (account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at)
    VALUES ${values}
    ON CONFLICT(account_index) DO UPDATE SET last_updated_at = excluded.last_updated_at;
  `;
  await db.prepare(query).run();
}

// 3. Пакетное обновление детального кэша для успешно опрошенных аккаунтов
export async function batchUpdatePositionsCache(
  db: D1Database, 
  accountsData: Array<{ account: LighterAccount; cachedPositions: CachedPositionPayload[] }>
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = accountsData.map(item => {
    const acc = item.account;
    return db.prepare(`
      INSERT INTO account_positions_cache (
        account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_index) DO UPDATE SET
        l1_address = excluded.l1_address,
        collateral = excluded.collateral,
        total_asset_value = excluded.total_asset_value,
        positions_json = excluded.positions_json,
        last_updated_at = excluded.last_updated_at
    `).bind(
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

// 4. Подписчики аккаунта с их индивидуальными порогами алертов
export async function getAccountSubscribers(
  db: D1Database, 
  accountIndex: number
): Promise<SubscriberRecord[]> {
  const query = `
    SELECT u.telegram_id, uta.alias, COALESCE(u.alert_threshold, 1.5) as alert_threshold
    FROM user_tracked_accounts uta
    JOIN users u ON uta.telegram_id = u.telegram_id
    WHERE uta.account_index = ?;
  `;
  const { results } = await db.prepare(query).bind(accountIndex).all<SubscriberRecord>();
  return results || [];
}

export async function getUserThreshold(db: D1Database, telegramId: number): Promise<number> {
  const row = await db.prepare("SELECT alert_threshold FROM users WHERE telegram_id = ?")
    .bind(telegramId)
    .first<{ alert_threshold: number }>();
  return row?.alert_threshold ?? 1.5;
}

export async function setUserThreshold(db: D1Database, telegramId: number, threshold: number): Promise<void> {
  await db.prepare("UPDATE users SET alert_threshold = ? WHERE telegram_id = ?")
    .bind(threshold, telegramId)
    .run();
}

// 5. Очистка заблокировавшего пользователя через явный batch (без опоры на SQLite PRAGMA foreign_keys)
export async function removeBlockedUser(db: D1Database, telegramId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM alert_logs WHERE telegram_id = ?").bind(telegramId),
    db.prepare("DELETE FROM user_tracked_accounts WHERE telegram_id = ?").bind(telegramId),
    db.prepare("DELETE FROM users WHERE telegram_id = ?").bind(telegramId)
  ]);
}

// 6. Сброс кулдаунов при выходе в безопасную зону (> 12%)
export async function clearSafeAlerts(db: D1Database, accountIndex: number, marketId: number): Promise<void> {
  await db.prepare(`
    DELETE FROM alert_logs 
    WHERE account_index = ? AND market_id = ?
  `).bind(accountIndex, marketId).run();
}
