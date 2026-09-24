-- 1. Таблица пользователей Telegram
CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    alert_threshold REAL NOT NULL DEFAULT 1.5,
    created_at INTEGER NOT NULL
);

-- 2. Связка Many-to-Many: Пользователь <-> Отслеживаемый аккаунт Lighter (с указанием сети)
CREATE TABLE IF NOT EXISTS user_tracked_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    network TEXT NOT NULL DEFAULT 'rh',
    account_index INTEGER NOT NULL,
    alias TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(telegram_id, network, account_index)
);

CREATE INDEX IF NOT EXISTS idx_tracked_acc ON user_tracked_accounts(network, account_index);
CREATE INDEX IF NOT EXISTS idx_tracked_usr ON user_tracked_accounts(telegram_id);

-- 3. Кэш состояния аккаунта и позиций (содержит last_updated_at для справедливого Round-Robin)
CREATE TABLE IF NOT EXISTS account_positions_cache (
    network TEXT NOT NULL DEFAULT 'rh',
    account_index INTEGER NOT NULL,
    l1_address TEXT NOT NULL,
    collateral REAL NOT NULL,
    total_asset_value REAL NOT NULL,
    positions_json TEXT NOT NULL,
    last_updated_at INTEGER NOT NULL,
    PRIMARY KEY (network, account_index)
);

CREATE INDEX IF NOT EXISTS idx_cache_round_robin ON account_positions_cache(last_updated_at);

-- 4. Журнал отправленных алертов (Anti-Spam Cooldown)
-- Идентификация строго по (network, account_index, market_id, alert_tier)
CREATE TABLE IF NOT EXISTS alert_logs (
    telegram_id INTEGER NOT NULL,
    network TEXT NOT NULL DEFAULT 'rh',
    account_index INTEGER NOT NULL,
    market_id INTEGER NOT NULL,
    alert_tier TEXT NOT NULL,
    last_distance REAL NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, network, account_index, market_id, alert_tier)
);
