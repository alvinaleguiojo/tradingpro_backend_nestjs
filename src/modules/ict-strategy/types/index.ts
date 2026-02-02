// Common types for ICT analysis
export interface Candle {
  time: string | Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
  time: string | Date;
  broken: boolean;
}

export interface OrderBlock {
  index: number;
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  midpoint: number;
  time: string | Date;
  valid: boolean;
  tested: boolean;
  strength: number; // 1-10
}

export interface FairValueGap {
  index: number;
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  midpoint: number;
  time: string | Date;
  filled: boolean;
  fillPercentage: number;
}

export interface LiquidityLevel {
  price: number;
  type: 'BUY_SIDE' | 'SELL_SIDE';
  strength: number;
  swept: boolean;
  time: string | Date;
}

export interface MarketStructure {
  trend: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastHigherHigh: SwingPoint | null;
  lastHigherLow: SwingPoint | null;
  lastLowerHigh: SwingPoint | null;
  lastLowerLow: SwingPoint | null;
  breakOfStructure: boolean;
  changeOfCharacter: boolean;
  currentSwingHigh: SwingPoint | null;
  currentSwingLow: SwingPoint | null;
}

export interface KillZone {
  name: string;
  active: boolean;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  startHour: number;
  endHour: number;
}

export interface IctAnalysisResult {
  timestamp: Date;
  symbol: string;
  timeframe: string;
  
  // Market Structure
  marketStructure: MarketStructure;
  
  // Order Blocks
  orderBlocks: OrderBlock[];
  nearestBullishOB: OrderBlock | null;
  nearestBearishOB: OrderBlock | null;
  
  // Fair Value Gaps
  fairValueGaps: FairValueGap[];
  unfilledFVGs: FairValueGap[];
  
  // Liquidity
  liquidityLevels: LiquidityLevel[];
  buyLiquidity: LiquidityLevel[];
  sellLiquidity: LiquidityLevel[];
  
  // Kill Zones
  currentKillZone: KillZone | null;
  sessionBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  
  // Trade Setup
  tradeSetup: TradeSetup | null;
}

export interface TradeSetup {
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  confidence: number; // 0-100
  reasons: string[];
  confluences: string[];
}
