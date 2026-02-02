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
  private readonly logger = new Logger(IctStrategyService.name);

  constructor(
    private marketStructureService: MarketStructureService,
    private orderBlockService: OrderBlockService,
    private fvgService: FairValueGapService,
    private liquidityService: LiquidityService,
    private killZoneService: KillZoneService,
  ) {}

  /**
   * Perform complete ICT analysis on price data
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
   * Generate trade setup based on ICT analysis
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

    // Check if we're in a kill zone (higher probability)
    const inKillZone = currentKillZone !== null;
    if (inKillZone) {
      confluences.push(`In ${currentKillZone.name}`);
      confidence += 20;
    }

    // Bonus for clear trending market
    if (marketStructure.trend !== 'RANGING') {
      confluences.push(`Clear ${marketStructure.trend} trend`);
      confidence += 10;
    }

    // Check if it's a high probability trading day
    if (!this.killZoneService.isHighProbabilityDay()) {
      return null; // Don't trade on low probability days
    }

    // Determine trade direction based on confluences
    let direction: 'BUY' | 'SELL' | null = null;

    // 1. Check Market Structure
    if (marketStructure.trend === 'BULLISH' && !marketStructure.breakOfStructure) {
      reasons.push('Bullish market structure');
      confidence += 20;
      direction = 'BUY';
    } else if (marketStructure.trend === 'BEARISH' && !marketStructure.breakOfStructure) {
      reasons.push('Bearish market structure');
      confidence += 20;
      direction = 'SELL';
    }

    // 2. Check for Change of Character (reversal signal)
    if (marketStructure.changeOfCharacter) {
      reasons.push('Change of Character detected');
      confidence += 10;
      // CHoCH indicates potential reversal
      direction = marketStructure.trend === 'BULLISH' ? 'SELL' : 'BUY';
    }

    // 3. Session bias alignment
    if (sessionBias !== 'NEUTRAL') {
      if ((sessionBias === 'BULLISH' && direction === 'BUY') ||
          (sessionBias === 'BEARISH' && direction === 'SELL')) {
        confluences.push('Session bias aligned');
        confidence += 10;
      } else if (direction === null) {
        direction = sessionBias === 'BULLISH' ? 'BUY' : 'SELL';
        reasons.push(`${sessionBias} session bias`);
        confidence += 15;
      }
    }

    if (!direction) {
      return null; // No clear direction
    }

    // Calculate entry, SL, and TP based on direction
    let entryPrice = currentPrice;
    let stopLoss: number;
    let takeProfit: number;

    if (direction === 'BUY') {
      // Look for entry at bullish OB or bullish FVG
      if (nearestBullishOB) {
        // Check if price is at or near the OB
        const obDistance = (currentPrice - nearestBullishOB.high) / currentPrice;
        if (obDistance < 0.002) { // Within 0.2%
          entryPrice = nearestBullishOB.midpoint;
          stopLoss = nearestBullishOB.low - (nearestBullishOB.high - nearestBullishOB.low) * 0.5;
          confluences.push('Entry at bullish Order Block');
          confidence += 15;
        } else {
          entryPrice = currentPrice;
          stopLoss = nearestBullishOB.low;
        }
        reasons.push('Bullish Order Block support');
      } else {
        // Use swing low for stop loss
        const swingLow = marketStructure.currentSwingLow;
        stopLoss = swingLow ? swingLow.price : currentPrice * 0.995;
      }

      // Check for bullish FVG confluence
      const bullishFVG = unfilledFVGs.find(fvg => 
        fvg.type === 'BULLISH' && 
        fvg.high < currentPrice &&
        (currentPrice - fvg.high) / currentPrice < 0.003
      );
      if (bullishFVG) {
        confluences.push('Unfilled bullish FVG below');
        confidence += 10;
      }

      // Set take profit at nearest sell-side liquidity or 2:1 RR
      const riskAmount = entryPrice - stopLoss;
      const targetLiquidity = buyLiquidity[0];
      
      if (targetLiquidity && targetLiquidity.price > entryPrice) {
        takeProfit = targetLiquidity.price;
        confluences.push('Targeting buy-side liquidity');
      } else {
        takeProfit = entryPrice + (riskAmount * 2); // 2:1 RR
      }

    } else {
      // SELL setup
      if (nearestBearishOB) {
        const obDistance = (nearestBearishOB.low - currentPrice) / currentPrice;
        if (obDistance < 0.002) {
          entryPrice = nearestBearishOB.midpoint;
          stopLoss = nearestBearishOB.high + (nearestBearishOB.high - nearestBearishOB.low) * 0.5;
          confluences.push('Entry at bearish Order Block');
          confidence += 15;
        } else {
          entryPrice = currentPrice;
          stopLoss = nearestBearishOB.high;
        }
        reasons.push('Bearish Order Block resistance');
      } else {
        const swingHigh = marketStructure.currentSwingHigh;
        stopLoss = swingHigh ? swingHigh.price : currentPrice * 1.005;
      }

      // Check for bearish FVG confluence
      const bearishFVG = unfilledFVGs.find(fvg =>
        fvg.type === 'BEARISH' &&
        fvg.low > currentPrice &&
        (fvg.low - currentPrice) / currentPrice < 0.003
      );
      if (bearishFVG) {
        confluences.push('Unfilled bearish FVG above');
        confidence += 10;
      }

      const riskAmount = stopLoss - entryPrice;
      const targetLiquidity = sellLiquidity[0];
      
      if (targetLiquidity && targetLiquidity.price < entryPrice) {
        takeProfit = targetLiquidity.price;
        confluences.push('Targeting sell-side liquidity');
      } else {
        takeProfit = entryPrice - (riskAmount * 2);
      }
    }

    // Calculate risk-reward ratio
    const risk = Math.abs(entryPrice - stopLoss);
    const reward = Math.abs(takeProfit - entryPrice);
    const riskRewardRatio = reward / risk;

    // Minimum requirements for trade
    if (confidence < 30) {
      return null; // Not enough confidence
    }

    if (riskRewardRatio < 1.2) {
      return null; // RR too low
    }

    if (reasons.length < 1) {
      return null; // Not enough reasons
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
}
