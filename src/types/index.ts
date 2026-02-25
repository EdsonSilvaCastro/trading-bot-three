// ============================================================
// ICT Price Action Bot - Shared TypeScript Types
// ============================================================

// --------------- Timeframes ---------------

export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d';

// --------------- Candle ---------------

export interface Candle {
  timestamp: Date;
  timeframe: Timeframe;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// --------------- Swings ---------------

export type SwingMethod = 'ICT_N3' | 'PIVOT_N3';

export interface Swing {
  id: string;
  timestamp: Date;
  timeframe: Timeframe;
  type: 'SWING_HIGH' | 'SWING_LOW';
  level: number;
  method: SwingMethod;
  isValid: boolean;
  candleIndex: number;
}

// --------------- Market Structure ---------------

export type StructureTrend = 'BULLISH' | 'BEARISH' | 'TRANSITION' | 'UNDEFINED';
export type StructureEvent =
  | 'BMS_BULLISH'
  | 'BMS_BEARISH'
  | 'CHOCH_BULLISH'
  | 'CHOCH_BEARISH'
  | 'SMS_BULLISH'
  | 'SMS_BEARISH'
  | 'NONE';

export interface StructureState {
  trend: StructureTrend;
  lastHH: Swing | null;
  lastHL: Swing | null;
  lastLH: Swing | null;
  lastLL: Swing | null;
  criticalSwing: Swing | null;
  lastEvent: StructureEvent;
}

// --------------- Liquidity ---------------

export type LiquidityType =
  | 'BSL'
  | 'SSL'
  | 'EQH'
  | 'EQL'
  | 'PDH'
  | 'PDL'
  | 'PWH'
  | 'PWL'
  | 'SESSION_HIGH'
  | 'SESSION_LOW';

export type LiquidityState = 'ACTIVE' | 'SWEPT' | 'EXPIRED';

export interface LiquidityLevel {
  id: string;
  timestamp: Date;
  level: number;
  type: LiquidityType;
  score: number; // 0-11
  state: LiquidityState;
  sweptAt?: Date;
}

// --------------- Fair Value Gaps ---------------

export type FVGType = 'BULLISH' | 'BEARISH';
export type FVGState = 'OPEN' | 'PARTIALLY_FILLED' | 'CE_TOUCHED' | 'FILLED' | 'VIOLATED';
export type FVGQuality = 'HIGH' | 'MEDIUM' | 'LOW';

export interface FairValueGap {
  id: string;
  timestamp: Date;
  timeframe: Timeframe;
  type: FVGType;
  top: number;
  bottom: number;
  ce: number; // consequent encroachment (midpoint)
  quality: FVGQuality;
  state: FVGState;
  inDisplacement: boolean;
}

// --------------- Displacement ---------------

export interface DisplacementResult {
  score: number; // 0-10
  totalRange: number;
  atrRatio: number;
  volumeRatio: number;
  fvgCount: number;
  fvgs: FairValueGap[];
  bodyRatio: number;
  direction: 'BULLISH' | 'BEARISH';
}

// --------------- Sweep ---------------

export type SweepConfirmation = 'IMMEDIATE' | 'DELAYED';

export interface Sweep {
  id: string;
  timestamp: Date;
  liquidityLevel: LiquidityLevel;
  confirmation: SweepConfirmation;
  delay: number; // candles to confirm
  score: number; // 0-10
  extreme: number; // how far price went past the level
}

// --------------- Daily Bias ---------------

export type BiasDirection = 'BULLISH' | 'BEARISH' | 'NO_TRADE';
export type FrameworkState =
  | 'RETRACEMENT_EXPECTED'
  | 'EXPANSION_EXPECTED'
  | 'WAITING_FOR_SWEEP';
export type AMDPhase = 'ACCUMULATION' | 'MANIPULATION' | 'DISTRIBUTION';
export type PremiumDiscountZone = 'PREMIUM' | 'DISCOUNT';

export interface DailyBias {
  date: Date;
  b1Framework: FrameworkState;
  b2DrawLevel: number;
  b2DrawType: LiquidityType;
  b3Zone: PremiumDiscountZone;
  b3Depth: number; // 0-1, how deep in the zone
  bias: BiasDirection;
  amdPhase: AMDPhase;
}

// --------------- Sessions ---------------

export type SessionName =
  | 'ASIAN'
  | 'LONDON'
  | 'LONDON_TO_NY'
  | 'NY_PRE_MARKET'
  | 'NY_MORNING'
  | 'NY_LUNCH'
  | 'NY_AFTERNOON'
  | 'NY_CLOSE';

export interface Session {
  name: SessionName;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  isTradeable: boolean;
  role: string;
}

// --------------- Trades ---------------

export type TradeDirection = 'LONG' | 'SHORT';
export type TradeStatus = 'OPEN' | 'TP1_HIT' | 'TP2_HIT' | 'STOPPED' | 'MANUAL' | 'TIME_EXIT';

export interface Trade {
  id: string;
  timestamp: Date;
  direction: TradeDirection;
  entryPrice: number;
  exitPrice?: number;
  sizeUsdt: number;
  leverage: number;
  stopLoss: number;
  tp1Level: number; // IRL target
  tp2Level: number; // ERL target
  tp1Hit: boolean;
  pnlUsdt?: number;
  pnlPct?: number;
  rrAchieved?: number;
  sweepId?: string;
  fvgId?: string;
  displacementScore: number;
  dailyBiasId?: string;
  status: TradeStatus;
  isPaper: boolean;
}

// --------------- Bybit API Response Types ---------------

export interface BybitKlineResponse {
  retCode: number;
  retMsg: string;
  result: {
    symbol: string;
    category: string;
    list: string[][];
  };
  time: number;
}

export interface BybitTickerResponse {
  retCode: number;
  retMsg: string;
  result: {
    category: string;
    list: Array<{
      symbol: string;
      lastPrice: string;
      bid1Price: string;
      ask1Price: string;
      highPrice24h: string;
      lowPrice24h: string;
      volume24h: string;
      turnover24h: string;
    }>;
  };
  time: number;
}
