-- ============================================================
-- Migration 002: Trades Table (Phase 3)
-- ============================================================

CREATE TABLE IF NOT EXISTS trades (
  id            UUID PRIMARY KEY,
  timestamp     TIMESTAMPTZ NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry_price   NUMERIC,
  exit_price    NUMERIC,
  size_usdt     NUMERIC NOT NULL,
  leverage      INTEGER NOT NULL,
  stop_loss     NUMERIC NOT NULL,
  tp1_level     NUMERIC NOT NULL,
  tp2_level     NUMERIC NOT NULL,
  tp1_hit       BOOLEAN DEFAULT false,
  pnl_usdt      NUMERIC,
  pnl_pct       NUMERIC,
  rr_achieved   NUMERIC,
  status        TEXT NOT NULL,
  displacement_score INTEGER,
  confidence    INTEGER,
  sweep_id      TEXT,
  fvg_id        TEXT,
  is_paper      BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_status    ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_is_paper  ON trades(is_paper);
