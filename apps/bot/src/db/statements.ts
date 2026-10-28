export interface CachedStatements {
  upsertAlertPrice: D1PreparedStatement;
  upsertAlertSent: D1PreparedStatement;
  deleteZombiePos: D1PreparedStatement;
  deleteZombieAlert: D1PreparedStatement;
  upsertOpenPos: D1PreparedStatement;
  upsertCache: D1PreparedStatement;
  touchFailed: D1PreparedStatement;
  saveMetrics: D1PreparedStatement;
  updateSpreadAlertSent: D1PreparedStatement;
  updateSpreadRearm: D1PreparedStatement;
  updateSpreadHits: D1PreparedStatement;
  resetSpreadHits: D1PreparedStatement;
}

let cachedStmts: CachedStatements | null = null;
let cachedDbRef: any = null;

export function resetCachedStatements(): void {
  cachedStmts = null;
  cachedDbRef = null;
}

export function getCronStatements(db: D1Database): CachedStatements {
  if (cachedStmts && cachedDbRef === db) return cachedStmts;

  cachedDbRef = db;
  cachedStmts = {
    upsertAlertPrice: db.prepare(`
      INSERT INTO user_token_alerts (telegram_id, network, account_index, market_id, symbol, last_price, last_alerted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id, network, account_index, market_id) DO UPDATE SET last_price = excluded.last_price
    `),
    upsertAlertSent: db.prepare(`
      INSERT INTO user_token_alerts (telegram_id, network, account_index, market_id, symbol, last_price, last_alerted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id, network, account_index, market_id) DO UPDATE SET
        last_price = excluded.last_price,
        last_alerted_at = excluded.last_alerted_at
    `),
    deleteZombiePos: db.prepare(
      "DELETE FROM account_open_positions WHERE network = ? AND account_index = ? AND market_id = ?",
    ),
    deleteZombieAlert: db.prepare(
      "DELETE FROM user_token_alerts WHERE network = ? AND account_index = ? AND market_id = ?",
    ),
    upsertOpenPos: db.prepare(`
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
    `),
    upsertCache: db.prepare(`
      INSERT INTO account_positions_cache (
        network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(network, account_index) DO UPDATE SET
        l1_address = excluded.l1_address,
        collateral = excluded.collateral,
        total_asset_value = excluded.total_asset_value,
        positions_json = excluded.positions_json,
        last_updated_at = excluded.last_updated_at
    `),
    touchFailed: db.prepare(`
      INSERT INTO account_positions_cache (network, account_index, l1_address, collateral, total_asset_value, positions_json, last_updated_at)
      VALUES (?, ?, '', 0, 0, '[]', ?)
      ON CONFLICT(network, account_index) DO UPDATE SET last_updated_at = excluded.last_updated_at;
    `),
    saveMetrics: db.prepare(`
      INSERT INTO bot_system_metrics (key, value_json, updated_at)
      VALUES ('last_cron', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `),
    updateSpreadAlertSent: db.prepare(`
      UPDATE user_spread_targets
      SET armed = 0, last_alerted_at = ?, last_spread = ?, consecutive_hits = 0
      WHERE id = ?
    `),
    updateSpreadHits: db.prepare(`
      UPDATE user_spread_targets
      SET consecutive_hits = ?
      WHERE id = ?
    `),
    resetSpreadHits: db.prepare(`
      UPDATE user_spread_targets
      SET consecutive_hits = 0
      WHERE id = ? AND consecutive_hits > 0
    `),
    updateSpreadRearm: db.prepare(`
      UPDATE user_spread_targets
      SET armed = 1, consecutive_hits = 0
      WHERE id = ?
    `),
  };

  return cachedStmts!;
}
