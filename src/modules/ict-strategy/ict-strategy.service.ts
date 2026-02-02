import { Injectable, Logger } from '@nestjs/common';
import { MarketStructureService } from './services/market-structure.service';
import { OrderBlockService } from './services/order-block.service';
import { FairValueGapService } from './services/fair-value-gap.service';
import { LiquidityService } from './services/liquidity.service';
import { KillZoneService } from './services/kill-zone.service';
import { 
  Candle, 
  IctAnalysisResult, 
  TradeSetup,
  OrderBlock,
  FairValueGap,
} from './types';

@Injectable()
export class IctStrategyService {
  private readonly logger = new Logger('SmcStrategyService');

  constructor(
    private marketStructureService: MarketStructureService,
    private orderBlockService: OrderBlockService,
    private fvgService: FairValueGapService,
    private liquidityService: LiquidityService,
    private killZoneService: KillZoneService,
  ) {}

  /**
   * Perform complete SMC (Smart Money Concepts) analysis on price data
   */
  analyzeMarket(
    candles: Candle[],
    symbol: string,
    timeframe: string,
  ): IctAnalysisResult {
    if (candles.length < 50) {
      this.logger.warn('Insufficient candles for analysis');
      return this.getEmptyAnalysis(symbol, timeframe);
    }

    const currentPrice = candles[candles.length - 1].close;

    // 1. Analyze Market Structure
    const marketStructure = this.marketStructureService.analyzeMarketStructure(candles);

    // 2. Find Order Blocks
    const orderBlocks = this.orderBlockService.findOrderBlocks(candles);
    const nearestBullishOB = this.orderBlockService.findNearestOrderBlock(
      orderBlocks,
      currentPrice,
      'BULLISH',
    );
    const nearestBearishOB = this.orderBlockService.findNearestOrderBlock(
      orderBlocks,
      currentPrice,
      'BEARISH',
    );

    // 3. Find Fair Value Gaps
    const fairValueGaps = this.fvgService.findFairValueGaps(candles);
    const unfilledFVGs = this.fvgService.getUnfilledFVGs(fairValueGaps);

    // 4. Find Liquidity Levels
    const liquidityLevels = this.liquidityService.findLiquidityLevels(candles);
    const buyLiquidity = this.liquidityService.getBuySideLiquidity(liquidityLevels, currentPrice);
    const sellLiquidity = this.liquidityService.getSellSideLiquidity(liquidityLevels, currentPrice);

    // 5. Check Kill Zones
    const currentKillZone = this.killZoneService.getCurrentKillZone();
    
    // Get Asian session range for bias
    const asianRange = this.killZoneService.getAsianSessionRange(candles);
    const sessionBias = asianRange
      ? this.killZoneService.getSessionBias(asianRange.high, asianRange.low, currentPrice)
      : 'NEUTRAL';

    // 6. Generate Trade Setup
    const tradeSetup = this.generateTradeSetup({
      candles,
      currentPrice,
      marketStructure,
      orderBlocks,
      nearestBullishOB,
      nearestBearishOB,
      fairValueGaps,
      unfilledFVGs,
      liquidityLevels,
      buyLiquidity,
      sellLiquidity,
      currentKillZone,
      sessionBias,
    });

    return {
      timestamp: new Date(),
      symbol,
      timeframe,
      marketStructure,
      orderBlocks,
      nearestBullishOB,
      nearestBearishOB,
      fairValueGaps,
      unfilledFVGs,
      liquidityLevels,
      buyLiquidity,
      sellLiquidity,
      currentKillZone,
      sessionBias,
      tradeSetup,
    };
  }

  /**
   * Generate trade setup based on SMC (Smart Money Concepts) analysis
   * SMC focuses on: Liquidity sweeps, Order Blocks, Market Structure, FVGs
   */
  private generateTradeSetup(params: {
    candles: Candle[];
    currentPrice: number;
    marketStructure: any;
    orderBlocks: OrderBlock[];
    nearestBullishOB: OrderBlock | null;
    nearestBearishOB: OrderBlock | null;
    fairValueGaps: FairValueGap[];
    unfilledFVGs: FairValueGap[];
    liquidityLevels: any[];
    buyLiquidity: any[];
    sellLiquidity: any[];
    currentKillZone: any;
    sessionBias: string;
  }): TradeSetup | null {
    const {
      candles,
      currentPrice,
      marketStructure,
      nearestBullishOB,
      nearestBearishOB,
      unfilledFVGs,
      buyLiquidity,
      sellLiquidity,
      currentKillZone,
      sessionBias,
    } = params;

    const reasons: string[] = [];
    const confluences: string[] = [];
    let confidence = 0;

    // SMC Core Concept 1: Check for liquidity sweep (stop hunt)
    const recentCandles = candles.slice(-10);
    const liquiditySweep = this.detectLiquiditySweep(recentCandles, candles.slice(-50));
    
    if (liquiditySweep) {
      reasons.push(`Liquidity sweep detected (${liquiditySweep.type})`);
      confidence += 25;
    }

    // SMC Core Concept 2: Market Structure - BOS or CHoCH
    if (marketStructure.breakOfStructure) {
      reasons.push('Break of Structure (BOS) confirmed');
      confidence += 20;
    }
    
    if (marketStructure.changeOfCharacter) {
      reasons.push('Change of Character (CHoCH) detected');
      confidence += 25;
    }

    // SMC Core Concept 3: Premium/Discount zone
    const priceRange = this.calculatePriceRange(candles.slice(-100));
    const zone = this.getPremiumDiscountZone(currentPrice, priceRange);
    
    if (zone !== 'EQUILIBRIUM') {
      confluences.push(`Price in ${zone} zone`);
      confidence += 10;
    }

    // Determine trade direction based on SMC concepts
    let direction: 'BUY' | 'SELL' | null = null;

    // Primary: Use liquidity sweep direction
    if (liquiditySweep) {
      // After sweeping lows, smart money buys (price reverses up)
      // After sweeping highs, smart money sells (price reverses down)
      direction = liquiditySweep.type === 'LOW_SWEEP' ? 'BUY' : 'SELL';
      
      // Extra confidence if sweep aligns with CHoCH
      if (marketStructure.changeOfCharacter) {
        confidence += 15;
        confluences.push('Liquidity sweep + CHoCH alignment');
      }
    }
    // Secondary: Use market structure trend
    else if (marketStructure.trend !== 'RANGING') {
      if (marketStructure.trend === 'BULLISH' && zone === 'DISCOUNT') {
        direction = 'BUY';
        reasons.push('Bullish trend + Discount zone');
        confidence += 15;
      } else if (marketStructure.trend === 'BEARISH' && zone === 'PREMIUM') {
        direction = 'SELL';
        reasons.push('Bearish trend + Premium zone');
        confidence += 15;
      } else {
        // Follow the trend
        direction = marketStructure.trend === 'BULLISH' ? 'BUY' : 'SELL';
        reasons.push(`Following ${marketStructure.trend} trend`);
        confidence += 10;
      }
    }

    // Tertiary: Use session bias
    if (!direction && sessionBias !== 'NEUTRAL') {
      direction = sessionBias === 'BULLISH' ? 'BUY' : 'SELL';
      reasons.push(`${sessionBias} session bias`);
      confidence += 10;
    }

    if (!direction) {
      return null; // No clear SMC setup
    }

    // SMC Core Concept 4: Order Block confluence
    if (direction === 'BUY' && nearestBullishOB) {
      const distanceToOB = (currentPrice - nearestBullishOB.high) / currentPrice;
      if (distanceToOB < 0.005) { // Within 0.5% of OB
        confluences.push('Price at Demand zone (Bullish OB)');
        confidence += 15;
      }
    } else if (direction === 'SELL' && nearestBearishOB) {
      const distanceToOB = (nearestBearishOB.low - currentPrice) / currentPrice;
      if (distanceToOB < 0.005) {
        confluences.push('Price at Supply zone (Bearish OB)');
        confidence += 15;
      }
    }

    // SMC Core Concept 5: Imbalance/FVG confluence
    const relevantFVG = unfilledFVGs.find(fvg => {
      if (direction === 'BUY' && fvg.type === 'BULLISH') {
        return fvg.high < currentPrice && (currentPrice - fvg.high) / currentPrice < 0.003;
      } else if (direction === 'SELL' && fvg.type === 'BEARISH') {
        return fvg.low > currentPrice && (fvg.low - currentPrice) / currentPrice < 0.003;
      }
      return false;
    });
    
    if (relevantFVG) {
      confluences.push('Unfilled imbalance (FVG) nearby');
      confidence += 10;
    }

    // Bonus: Kill zone timing
    if (currentKillZone) {
      confluences.push(`Active session: ${currentKillZone.name}`);
      confidence += 10;
    }

    // Calculate entry, SL, and TP using SMC principles
    let entryPrice = currentPrice;
    let stopLoss: number;
    let takeProfit: number;

    if (direction === 'BUY') {
      // SL below recent swing low or OB
      const swingLow = marketStructure.currentSwingLow?.price || currentPrice * 0.995;
      const obLow = nearestBullishOB?.low || swingLow;
      stopLoss = Math.min(swingLow, obLow) * 0.999; // Slight buffer

      // TP at liquidity above or 2:1 minimum
      const riskAmount = entryPrice - stopLoss;
      const liquidityTarget = buyLiquidity[0]?.price;
      
      if (liquidityTarget && liquidityTarget > entryPrice + riskAmount * 1.5) {
        takeProfit = liquidityTarget;
        confluences.push('Targeting buy-side liquidity');
      } else {
        takeProfit = entryPrice + (riskAmount * 2);
      }
    } else {
      // SELL
      const swingHigh = marketStructure.currentSwingHigh?.price || currentPrice * 1.005;
      const obHigh = nearestBearishOB?.high || swingHigh;
      stopLoss = Math.max(swingHigh, obHigh) * 1.001;

      const riskAmount = stopLoss - entryPrice;
      const liquidityTarget = sellLiquidity[0]?.price;
      
      if (liquidityTarget && liquidityTarget < entryPrice - riskAmount * 1.5) {
        takeProfit = liquidityTarget;
        confluences.push('Targeting sell-side liquidity');
      } else {
        takeProfit = entryPrice - (riskAmount * 2);
      }
    }

    // Calculate risk-reward ratio
    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(takeProfit - entryPrice);
    const riskRewardRatio = reward / risk;

    // SMC minimum requirements - more lenient for smart money setups
    if (confidence < 25) {
      return null;
    }

    if (riskRewardRatio < 1.0) {
      return null;
    }

    // Cap confidence at 100
    confidence = Math.min(100, confidence);

    return {
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: Math.round(riskRewardRatio * 100) / 100,
      confidence,
      reasons,
      confluences,
    };
  }

  /**
   * Detect liquidity sweep (stop hunt) - core SMC concept
   */
  private detectLiquiditySweep(
    recentCandles: Candle[],
    lookbackCandles: Candle[],
  ): { type: 'HIGH_SWEEP' | 'LOW_SWEEP'; price: number } | null {
    if (recentCandles.length < 3 || lookbackCandles.length < 20) return null;

    const lookbackHigh = Math.max(...lookbackCandles.slice(0, -5).map(c => c.high));
    const lookbackLow = Math.min(...lookbackCandles.slice(0, -5).map(c => c.low));
    
    const lastCandle = recentCandles[recentCandles.length - 1];
    const prevCandle = recentCandles[recentCandles.length - 2];

    // High sweep: Price wicks above previous high then closes back below
    if (lastCandle.high > lookbackHigh && lastCandle.close < lookbackHigh) {
      return { type: 'HIGH_SWEEP', price: lookbackHigh };
    }
    
    // Also check if previous candle swept and current is reversing
    if (prevCandle.high > lookbackHigh && lastCandle.close < prevCandle.open) {
      return { type: 'HIGH_SWEEP', price: lookbackHigh };
    }

    // Low sweep: Price wicks below previous low then closes back above
    if (lastCandle.low < lookbackLow && lastCandle.close > lookbackLow) {
      return { type: 'LOW_SWEEP', price: lookbackLow };
    }
    
    if (prevCandle.low < lookbackLow && lastCandle.close > prevCandle.open) {
      return { type: 'LOW_SWEEP', price: lookbackLow };
    }

    return null;
  }

  /**
   * Calculate price range for premium/discount zones
   */
  private calculatePriceRange(candles: Candle[]): { high: number; low: number; equilibrium: number } {
    const high = Math.max(...candles.map(c => c.high));
    const low = Math.min(...candles.map(c => c.low));
    return {
      high,
      low,
      equilibrium: (high + low) / 2,
    };
  }

  /**
   * Determine if price is in premium, discount, or equilibrium zone
   */
  private getPremiumDiscountZone(
    currentPrice: number,
    range: { high: number; low: number; equilibrium: number },
  ): 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' {
    const rangeSize = range.high - range.low;
    const upperThreshold = range.equilibrium + rangeSize * 0.2;
    const lowerThreshold = range.equilibrium - rangeSize * 0.2;

    if (currentPrice > upperThreshold) return 'PREMIUM';
    if (currentPrice < lowerThreshold) return 'DISCOUNT';
    return 'EQUILIBRIUM';
  }

  /**
   * Check if HTF (Higher Time Frame) confirms the trade direction
   * This significantly improves win rate by trading with the bigger trend
   */
  getHTFConfirmation(
    htfCandles: Candle[],
    tradeDirection: 'BUY' | 'SELL',
  ): { confirmed: boolean; htfTrend: string; confluenceBonus: number } {
    const htfStructure = this.marketStructureService.analyzeMarketStructure(htfCandles);
    const htfTrend = htfStructure.trend;

    // BUY needs bullish HTF, SELL needs bearish HTF
    const confirmed = 
      (tradeDirection === 'BUY' && htfTrend === 'BULLISH') ||
      (tradeDirection === 'SELL' && htfTrend === 'BEARISH');

    // Extra bonus if HTF has BOS or CHoCH
    let confluenceBonus = 0;
    if (confirmed) {
      confluenceBonus = 15;
      if (htfStructure.breakOfStructure) confluenceBonus += 10;
      if (htfStructure.changeOfCharacter) confluenceBonus += 10;
    }

    return { confirmed, htfTrend, confluenceBonus };
  }

  /**
   * Check if it's a high-impact news time (avoid trading)
   * XAU/USD major news: FOMC, NFP, CPI
   */
  isHighImpactNewsTime(): boolean {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    const hour = now.getUTCHours();
    const date = now.getUTCDate();

    // Skip NFP day (first Friday of month)
    if (dayOfWeek === 5 && date <= 7) {
      if (hour >= 12 && hour <= 15) { // 12:30-15:30 UTC
        return true;
      }
    }

    // Skip FOMC days (Wednesday 18:00-20:00 UTC) - simplified check
    if (dayOfWeek === 3 && hour >= 17 && hour <= 20) {
      return true;
    }

    return false;
  }

  /**
   * Calculate optimal position size based on ATR
   * Bigger stop for volatile markets, smaller for calm markets
   */
  getATRBasedStopLoss(
    candles: Candle[],
    direction: 'BUY' | 'SELL',
    currentPrice: number,
    multiplier: number = 1.5,
  ): { stopLoss: number; atr: number } {
    // Calculate ATR (Average True Range) for last 14 candles
    const atrPeriod = 14;
    const recentCandles = candles.slice(-atrPeriod - 1);
    
    let atrSum = 0;
    for (let i = 1; i < recentCandles.length; i++) {
      const high = recentCandles[i].high;
      const low = recentCandles[i].low;
      const prevClose = recentCandles[i - 1].close;
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose),
      );
      atrSum += tr;
    }
    
    const atr = atrSum / atrPeriod;
    const stopDistance = atr * multiplier;

    const stopLoss = direction === 'BUY'
      ? currentPrice - stopDistance
      : currentPrice + stopDistance;

    return { stopLoss, atr };
  }

  /**
   * Get empty analysis result
   */
  private getEmptyAnalysis(symbol: string, timeframe: string): IctAnalysisResult {
    return {
      timestamp: new Date(),
      symbol,
      timeframe,
      marketStructure: {
        trend: 'RANGING',
        lastHigherHigh: null,
        lastHigherLow: null,
        lastLowerHigh: null,
        lastLowerLow: null,
        breakOfStructure: false,
        changeOfCharacter: false,
        currentSwingHigh: null,
        currentSwingLow: null,
      },
      orderBlocks: [],
      nearestBullishOB: null,
      nearestBearishOB: null,
      fairValueGaps: [],
      unfilledFVGs: [],
      liquidityLevels: [],
      buyLiquidity: [],
      sellLiquidity: [],
      currentKillZone: null,
      sessionBias: 'NEUTRAL',
      tradeSetup: null,
    };
  }

  /**
   * Quick check if conditions are favorable for trading
   */
  shouldTrade(candles: Candle[]): { 
    shouldTrade: boolean; 
    reason: string;
  } {
    // Check if we have enough data
    if (candles.length < 50) {
      return { shouldTrade: false, reason: 'Insufficient data' };
    }

    // Check for high-impact news
    if (this.isHighImpactNewsTime()) {
      return { shouldTrade: false, reason: 'High-impact news time - avoiding market' };
    }

    // Check trading day
    if (!this.killZoneService.isHighProbabilityDay()) {
      return { shouldTrade: false, reason: 'Low probability trading day' };
    }

    // Check kill zone
    const killZone = this.killZoneService.getCurrentKillZone();
    if (!killZone) {
      const nextKillZone = this.killZoneService.getTimeToNextKillZone();
      if (nextKillZone) {
        return { 
          shouldTrade: false, 
          reason: `Outside kill zone. Next: ${nextKillZone.name} in ${nextKillZone.minutes} minutes` 
        };
      }
      return { shouldTrade: false, reason: 'Outside kill zone' };
    }

    return { shouldTrade: true, reason: `In ${killZone.name}` };
  }

  /**
   * Calculate partial take profit levels (scale out strategy)
   * Take 50% profit at TP1, let rest run to TP2
   */
  getPartialTakeProfits(
    entryPrice: number,
    stopLoss: number,
    direction: 'BUY' | 'SELL',
  ): { tp1: number; tp2: number; tp3: number } {
    const risk = Math.abs(entryPrice - stopLoss);

    if (direction === 'BUY') {
      return {
        tp1: entryPrice + risk * 1.5,  // 1.5 RR - Take 50% profit
        tp2: entryPrice + risk * 2.5,  // 2.5 RR - Take 30% profit
        tp3: entryPrice + risk * 4.0,  // 4.0 RR - Let 20% run
      };
    } else {
      return {
        tp1: entryPrice - risk * 1.5,
        tp2: entryPrice - risk * 2.5,
        tp3: entryPrice - risk * 4.0,
      };
    }
  }

  /**
   * Get breakeven level - move SL to entry after hitting TP1
   */
  getBreakevenLevel(
    entryPrice: number,
    direction: 'BUY' | 'SELL',
    spreadBuffer: number = 1.0, // In price points (e.g., $1 for gold)
  ): number {
    // Add small buffer for spread to ensure BE
    return direction === 'BUY'
      ? entryPrice + spreadBuffer
      : entryPrice - spreadBuffer;
  }
}
