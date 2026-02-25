// ============================================================
// Risk Management Configuration
// ============================================================

export const RISK_CONFIG = {
  /** 1% of account per trade */
  maxRiskPerTrade: 0.01,
  /** 0.5% after a single loss */
  postLossRisk: 0.005,
  /** 0.25% after two consecutive losses */
  post2LossRisk: 0.0025,
  /** 2% max daily drawdown cap */
  maxDailyLoss: 0.02,
  /** 5% max weekly drawdown cap */
  maxWeeklyDrawdown: 0.05,
  /** 15% from peak triggers kill switch (pause bot) */
  killSwitchDrawdown: 0.15,
  /** Only 1 trade per day */
  maxTradesPerDay: 1,
  /** Minimum required risk:reward ratio to enter */
  minRR: 2.0,
  /** Default leverage (conservative) */
  defaultLeverage: 3,
  /** Maximum allowed leverage */
  maxLeverage: 5,
  /** Close 50% of position at TP1 */
  tp1ClosePercent: 0.5,
  /** 0.1% structural SL buffer beyond swing */
  slBufferPercent: 0.001,
} as const;
