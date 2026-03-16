-- ============================================================
-- Migration 003: MAE/MFE + Killzone fields
-- Adds analysis fields to trades table without touching existing data.
-- Run in Supabase SQL Editor BEFORE deploying the new code.
-- ============================================================

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS mae        NUMERIC,
  ADD COLUMN IF NOT EXISTS mfe        NUMERIC,
  ADD COLUMN IF NOT EXISTS killzone   TEXT CHECK (
    killzone IN (
      'ASIAN', 'LONDON', 'LONDON_TO_NY', 'NY_PRE_MARKET',
      'NY_MORNING', 'NY_LUNCH', 'NY_AFTERNOON', 'NY_CLOSE', 'OFF_SESSION'
    )
  ),
  ADD COLUMN IF NOT EXISTS day_of_week TEXT CHECK (
    day_of_week IN ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
  );

-- Índices para análisis de patrones
CREATE INDEX IF NOT EXISTS idx_trades_killzone    ON trades(killzone);
CREATE INDEX IF NOT EXISTS idx_trades_day_of_week ON trades(day_of_week);

-- Verificar resultado
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'trades'
ORDER BY ordinal_position;
