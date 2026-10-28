-- 1. Таблица пользователей Telegram
CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    alert_threshold REAL NOT NULL DEFAULT 0.5,
    wizard_state TEXT DEFAULT NULL,
    muted_until INTEGER NOT NULL DEFAULT 0,
    spread_muted_until INTEGER NOT NULL DEFAULT 0,
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

-- 4. Открытые позиции пользователей (актуализируются при /positions, /add_* и фоновом Round-Robin)
CREATE TABLE IF NOT EXISTS account_open_positions (
    network TEXT NOT NULL,
    account_index INTEGER NOT NULL,
    market_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    is_long INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    size REAL NOT NULL,
    liquidation_price REAL NOT NULL DEFAULT 0,
    last_updated_at INTEGER NOT NULL,
    PRIMARY KEY (network, account_index, market_id)
);

CREATE INDEX IF NOT EXISTS idx_open_pos_market ON account_open_positions(network, market_id);
CREATE INDEX IF NOT EXISTS idx_open_pos_symbol ON account_open_positions(symbol);

-- 5. Базовые отметки цен и анти-флаппинг кулдаун (Price-Driven Alerting)
CREATE TABLE IF NOT EXISTS user_token_alerts (
    telegram_id INTEGER NOT NULL,
    network TEXT NOT NULL,
    account_index INTEGER NOT NULL,
    market_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    last_price REAL NOT NULL,
    last_alerted_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, network, account_index, market_id)
);

-- 6. Системные и операционные метрики для обсервабилити (/stats и дашборд)
CREATE TABLE IF NOT EXISTS bot_system_metrics (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 7. Таргеты спреда Robinhood Lighter vs Lighter Core
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
);

CREATE INDEX IF NOT EXISTS idx_spread_targets_active 
    ON user_spread_targets(is_active, armed, symbol);
CREATE INDEX IF NOT EXISTS idx_spread_targets_user 
    ON user_spread_targets(telegram_id, symbol);

-- 8. Мьюты алертов по отдельным символам
CREATE TABLE IF NOT EXISTS spread_symbol_mutes (
    telegram_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    muted_until INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, symbol)
);

