import { Injectable, Logger } from '@nestjs/common';
import { Candle, TradeSetup, OrderBlock, FairValueGap } from '../types';

export interface ScalpingConfig {
  // Entry settings
  minConfidence: number;          // Minimum confidence to enter (lower = more aggressive)
  minRiskReward: number;          // Minimum R:R ratio
  maxSpreadPips: number;          // Max spread to trade
  
  // Risk settings
  stopLossPips: number;           // Fixed SL in pips
  takeProfitPips: number;         // Fixed TP in pips
  trailingStopPips: number;       // Trailing stop distance
  
  // Scalping behavior
  usePartialTakeProfit: boolean;  // Take partial profit at 1R
  partialProfitPercent: number;   // % to close at partial TP
  breakEvenAtProfit: number;      // Move SL to BE after X pips profit
  
  // Session settings
  onlyTradeDuringKillZones: boolean;
  allowCounterTrend: boolean;     // Allow trades against HTF trend
}

// ULTRA AGGRESSIVE scalping defaults for XAU/USD
// Optimized for quick in-and-out trades with tight risk management
const AGGRESSIVE_SCALPING_CONFIG: ScalpingConfig = {
  minConfidence: 10,              // VERY LOW - take almost any setup
  minRiskReward: 1.0,             // 1:1 minimum for maximum entries
  maxSpreadPips: 50,              // Allow higher spread during volatile times
  
  stopLossPips: 25,               // TIGHT 25 pip stop - quick cut losses
  takeProfitPips: 40,             // Quick 40 pip TP - 1.6 R:R
  trailingStopPips: 15,           // Very tight trailing
  
  usePartialTakeProfit: true,
  partialProfitPercent: 50,       // Close 50% at first target
  breakEvenAtProfit: 15,          // Move to BE quickly after 15 pips
  
  onlyTradeDuringKillZones: false, // Trade any time for scalping
  allowCounterTrend: true,         // ALLOW counter-trend for more trades
};

@Injectable()
export class ScalpingStrategyService {
  private readonly logger = new Logger('ScalpingStrategy');
  private config: ScalpingConfig = AGGRESSIVE_SCALPING_CONFIG;

  /**
   * AGGRESSIVE MOMENTUM SCALPING
   * Simple strategy: Follow the short-term momentum with tight stops
   * Focus: Quick entries, small wins, cut losses fast
   */
  analyzeForScalp(
    candles: Candle[],
    currentPrice: number,
    spread: number = 0,
  ): TradeSetup | null {
    if (candles.length < 20) {
      this.logger.warn(`Not enough candles for scalping: ${candles.length} (need 20+)`);
      return null;
    }

    // Log candle data for debugging
    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    this.logger.log(`🔍 Analyzing ${candles.length} candles. Current: ${currentPrice.toFixed(2)}, Last close: ${lastCandle.close?.toFixed(2)}`);

    // Validate candle data
    if (!lastCandle.open || !lastCandle.high || !lastCandle.low || !lastCandle.close) {
      this.logger.error(`Invalid candle data`);
      return null;
    }

    // Check spread - but be lenient
    if (spread > this.config.maxSpreadPips) {
      this.logger.debug(`Spread too high: ${spread} pips`);
      return null;
    }

    const reasons: string[] = [];
    const confluences: string[] = [];
    let confidence = 0;
    let direction: 'BUY' | 'SELL' | null = null;

    // ===== SIMPLE MOMENTUM DETECTION =====
    // Look at the last 3-5 candles to determine direction
    const last5 = candles.slice(-5);
    const last3 = candles.slice(-3);
    
    // Calculate simple momentum: compare current price to 5-candle average
    const avg5 = last5.reduce((sum, c) => sum + c.close, 0) / 5;
    const avg3 = last3.reduce((sum, c) => sum + c.close, 0) / 3;
    const priceVsAvg5 = ((currentPrice - avg5) / avg5) * 100;
    const priceVsAvg3 = ((currentPrice - avg3) / avg3) * 100;

    this.logger.log(`📊 Price vs AVG5: ${priceVsAvg5.toFixed(3)}%, vs AVG3: ${priceVsAvg3.toFixed(3)}%`);

    // ===== SIGNAL 1: SIMPLE MOMENTUM (Most Important) =====
    // If price is moving away from the average, follow it
    const momentumThreshold = 0.015; // 0.015% = ~$0.75 on Gold
    
    if (priceVsAvg3 > momentumThreshold && priceVsAvg5 > 0) {
      direction = 'BUY';
      confidence += 40;
      reasons.push(`Price above 3-candle avg (+${priceVsAvg3.toFixed(3)}%)`);
      this.logger.log(`✅ BULLISH momentum: Price > AVG3`);
    } else if (priceVsAvg3 < -momentumThreshold && priceVsAvg5 < 0) {
      direction = 'SELL';
      confidence += 40;
      reasons.push(`Price below 3-candle avg (${priceVsAvg3.toFixed(3)}%)`);
      this.logger.log(`✅ BEARISH momentum: Price < AVG3`);
    }

    // ===== SIGNAL 2: CANDLE DIRECTION =====
    // Last 2-3 candles moving in same direction = confirmation
    const lastBullish = lastCandle.close > lastCandle.open;
    const prevBullish = prevCandle.close > prevCandle.open;
    
    if (lastBullish && prevBullish) {
      if (direction === 'BUY') {
        confidence += 25;
        confluences.push('2 bullish candles');
      } else if (!direction) {
        direction = 'BUY';
        confidence += 30;
        reasons.push('2 consecutive bullish candles');
      }
    } else if (!lastBullish && !prevBullish) {
      if (direction === 'SELL') {
        confidence += 25;
        confluences.push('2 bearish candles');
      } else if (!direction) {
        direction = 'SELL';
        confidence += 30;
        reasons.push('2 consecutive bearish candles');
      }
    }

    // ===== SIGNAL 3: BREAKOUT DETECTION =====
    // Price breaking recent high/low = strong momentum
    const recentHigh = Math.max(...candles.slice(-10).map(c => c.high));
    const recentLow = Math.min(...candles.slice(-10).map(c => c.low));
    const range = recentHigh - recentLow;
    
    if (currentPrice > recentHigh - (range * 0.1)) {
      // Near or breaking recent high
      if (direction === 'BUY') {
        confidence += 20;
        confluences.push('Breaking recent high');
      } else if (!direction) {
        direction = 'BUY';
        confidence += 35;
        reasons.push('Price at 10-candle high');
      }
      this.logger.log(`📈 Price near 10-candle HIGH: ${recentHigh.toFixed(2)}`);
    } else if (currentPrice < recentLow + (range * 0.1)) {
      // Near or breaking recent low
      if (direction === 'SELL') {
        confidence += 20;
        confluences.push('Breaking recent low');
      } else if (!direction) {
        direction = 'SELL';
        confidence += 35;
        reasons.push('Price at 10-candle low');
      }
      this.logger.log(`📉 Price near 10-candle LOW: ${recentLow.toFixed(2)}`);
    }

    // ===== SIGNAL 4: QUICK REVERSAL (Optional Bonus) =====
    // Pin bar or engulfing for extra confidence
    const engulfing = this.detectEngulfing(lastCandle, prevCandle);
    if (engulfing) {
      if (engulfing.direction === direction) {
        confidence += 15;
        confluences.push(`${engulfing.type} engulfing`);
      } else if (!direction) {
        direction = engulfing.direction;
        confidence += 30;
        reasons.push(`${engulfing.type} engulfing pattern`);
      }
    }

    // No direction determined
    if (!direction) {
      this.logger.log(`⏸️ No clear direction - market is ranging`);
      return null;
    }

    // Log final decision
    this.logger.log(`🎯 Direction: ${direction}, Confidence: ${confidence}%, Reasons: ${reasons.join(', ')}`);

    // Check minimum confidence (very low threshold)
    if (confidence < this.config.minConfidence) {
      this.logger.log(`❌ Confidence too low: ${confidence}% (min: ${this.config.minConfidence}%)`);
      return null;
    }

    // Calculate SL/TP
    const pipValue = 0.20; // For Gold
    
    let stopLoss: number;
    let takeProfit: number;

    if (direction === 'BUY') {
      stopLoss = currentPrice - (this.config.stopLossPips * pipValue);
      takeProfit = currentPrice + (this.config.takeProfitPips * pipValue);
    } else {
      stopLoss = currentPrice + (this.config.stopLossPips * pipValue);
      takeProfit = currentPrice - (this.config.takeProfitPips * pipValue);
    }
    
    this.logger.log(`📊 Entry: ${currentPrice.toFixed(2)}, SL: ${stopLoss.toFixed(2)}, TP: ${takeProfit.toFixed(2)}`);

    const risk = Math.abs(currentPrice - stopLoss);
    const reward = Math.abs(takeProfit - currentPrice);
    const riskRewardRatio = reward / risk;

    // Add metadata
    confluences.push(`R:R ${riskRewardRatio.toFixed(2)}`);

    return {
      direction,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: Math.round(riskRewardRatio * 100) / 100,
      confidence: Math.min(100, confidence),
      reasons,
      confluences,
    };
  }

  /**
   * Original analyzeForScalp - kept for reference but renamed
   */
  analyzeForScalpOriginal(
    candles: Candle[],
    currentPrice: number,
    spread: number = 0,
  ): TradeSetup | null {
    if (candles.length < 30) {
      this.logger.warn(`Not enough candles for scalping: ${candles.length} (need 30+)`);
      return null;
    }

    // Log candle data for debugging
    const lastCandle = candles[candles.length - 1];
    const currentBody = Math.abs(current.close - current.open);
    const previousBody = Math.abs(previous.close - previous.open);

    // Bullish engulfing: current green candle completely engulfs previous red
    if (
      current.close > current.open && // Current is green
      previous.close < previous.open && // Previous is red
      current.open <= previous.close && // Current opens at/below prev close
      current.close >= previous.open && // Current closes at/above prev open
      currentBody > previousBody * 1.2 // Current body is significantly larger
    ) {
      return { direction: 'BUY', type: 'Bullish' };
    }

    // Bearish engulfing
    if (
      current.close < current.open && // Current is red
      previous.close > previous.open && // Previous is green
      current.open >= previous.close && // Current opens at/above prev close
      current.close <= previous.open && // Current closes at/below prev open
      currentBody > previousBody * 1.2
    ) {
      return { direction: 'SELL', type: 'Bearish' };
    }

    return null;
  }

  /**
   * Detect pin bar / hammer / shooting star
   */
  private detectPinBar(candle: Candle): { direction: 'BUY' | 'SELL'; type: string } | null {
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const totalRange = candle.high - candle.low;

    if (totalRange === 0) return null;

    // Bullish pin bar (hammer): Long lower wick, small body at top
    if (lowerWick > body * 2 && lowerWick > upperWick * 2 && body / totalRange < 0.3) {
      return { direction: 'BUY', type: 'Hammer' };
    }

    // Bearish pin bar (shooting star): Long upper wick, small body at bottom
    if (upperWick > body * 2 && upperWick > lowerWick * 2 && body / totalRange < 0.3) {
      return { direction: 'SELL', type: 'Shooting Star' };
    }

    return null;
  }

  /**
   * Detect strong momentum based on actual price movement, not just candle colors
   * Looks at higher highs/higher lows for BUY, lower highs/lower lows for SELL
   */
  private detectMomentum(
    candles: Candle[],
  ): { direction: 'BUY' | 'SELL'; strength: number } | null {
    if (candles.length < 5) return null;

    // Calculate net price change over the period
    const firstPrice = candles[0].close;
    const lastPrice = candles[candles.length - 1].close;
    const netChange = lastPrice - firstPrice;
    const netChangePercent = (netChange / firstPrice) * 100;

    // Count higher highs/lows vs lower highs/lows
    let higherHighs = 0;
    let lowerLows = 0;
    let lowerHighs = 0;
    let higherLows = 0;

    for (let i = 1; i < candles.length; i++) {
      if (candles[i].high > candles[i - 1].high) higherHighs++;
      else lowerHighs++;
      
      if (candles[i].low > candles[i - 1].low) higherLows++;
      else lowerLows++;
    }

    this.logger.log(`Momentum check: Net change ${netChange.toFixed(2)} (${netChangePercent.toFixed(3)}%), HH=${higherHighs}, LL=${lowerLows}, LH=${lowerHighs}, HL=${higherLows}`);

    // AGGRESSIVE: Lower thresholds for more trades
    // BULLISH momentum: net positive change AND more higher highs than lower highs
    if (netChangePercent > 0.02 && higherHighs >= 2 && higherHighs > lowerHighs) {
      this.logger.log(`✅ BULLISH momentum confirmed: +${netChangePercent.toFixed(3)}%`);
      return { direction: 'BUY', strength: netChange };
    }
    
    // BEARISH momentum: net negative change AND more lower lows than higher lows
    if (netChangePercent < -0.02 && lowerLows >= 2 && lowerLows > higherLows) {
      this.logger.log(`✅ BEARISH momentum confirmed: ${netChangePercent.toFixed(3)}%`);
      return { direction: 'SELL', strength: Math.abs(netChange) };
    }

    return null;
  }

  /**
   * Detect double top or double bottom pattern
   */
  private detectDoubleTopBottom(
    candles: Candle[],
    currentPrice: number,
  ): { direction: 'BUY' | 'SELL'; type: string; level: number } | null {
    const highs: { price: number; index: number }[] = [];
    const lows: { price: number; index: number }[] = [];

    // Find local highs and lows
    for (let i = 2; i < candles.length - 2; i++) {
      if (
        candles[i].high > candles[i - 1].high &&
        candles[i].high > candles[i - 2].high &&
        candles[i].high > candles[i + 1].high &&
        candles[i].high > candles[i + 2].high
      ) {
        highs.push({ price: candles[i].high, index: i });
      }
      if (
        candles[i].low < candles[i - 1].low &&
        candles[i].low < candles[i - 2].low &&
        candles[i].low < candles[i + 1].low &&
        candles[i].low < candles[i + 2].low
      ) {
        lows.push({ price: candles[i].low, index: i });
      }
    }

    // Check for double top (bearish)
    if (highs.length >= 2) {
      const lastTwo = highs.slice(-2);
      const priceDiff = Math.abs(lastTwo[0].price - lastTwo[1].price);
      const avgPrice = (lastTwo[0].price + lastTwo[1].price) / 2;
      
      if (priceDiff / avgPrice < 0.002 && currentPrice < avgPrice) {
        return { direction: 'SELL', type: 'Double Top', level: avgPrice };
      }
    }

    // Check for double bottom (bullish)
    if (lows.length >= 2) {
      const lastTwo = lows.slice(-2);
      const priceDiff = Math.abs(lastTwo[0].price - lastTwo[1].price);
      const avgPrice = (lastTwo[0].price + lastTwo[1].price) / 2;
      
      if (priceDiff / avgPrice < 0.002 && currentPrice > avgPrice) {
        return { direction: 'BUY', type: 'Double Bottom', level: avgPrice };
      }
    }

    return null;
  }

  /**
   * Detect quick liquidity grab (sweep and reverse)
   */
  private detectQuickLiquidityGrab(
    candles: Candle[],
  ): { direction: 'BUY' | 'SELL'; type: string } | null {
    if (candles.length < 5) return null;

    const last = candles[candles.length - 1];
    const prevHigh = Math.max(...candles.slice(0, -1).map(c => c.high));
    const prevLow = Math.min(...candles.slice(0, -1).map(c => c.low));

    // Sweep high and close back below (bearish grab)
    if (last.high > prevHigh && last.close < prevHigh && last.close < last.open) {
      return { direction: 'SELL', type: 'High swept' };
    }

    // Sweep low and close back above (bullish grab)
    if (last.low < prevLow && last.close > prevLow && last.close > last.open) {
      return { direction: 'BUY', type: 'Low swept' };
    }

    return null;
  }

  /**
   * Get overall trend direction based on price position relative to EMA20
   * EMA20 on M5 timeframe = ~1.5 hours - FAST trend detection for aggressive scalping
   * This is used as a trend filter to avoid trading against the main trend
   */
  private getTrendDirection(candles: Candle[]): { direction: 'BULLISH' | 'BEARISH'; position: string; distancePercent: number } | null {
    if (candles.length < 20) {
      this.logger.warn(`Not enough candles for trend filter: ${candles.length} (need 20+)`);
      return null;
    }

    const closes = candles.map(c => c.close);
    const ema20 = this.calculateEMA(closes, 20);
    
    if (ema20.length === 0) return null;

    const currentPrice = closes[closes.length - 1];
    const currentEMA = ema20[ema20.length - 1];
    
    // Calculate how far price is from EMA (as percentage)
    const distancePercent = ((currentPrice - currentEMA) / currentEMA) * 100;
    
    this.logger.log(`📈 EMA20 trend check: Price=${currentPrice.toFixed(2)}, EMA20=${currentEMA.toFixed(2)}, Distance=${distancePercent.toFixed(3)}%`);
    
    // AGGRESSIVE: Only require 0.03% distance from EMA for trend confirmation
    if (Math.abs(distancePercent) < 0.03) {
      this.logger.log(`⏸️ Price too close to EMA20 (${distancePercent.toFixed(3)}%) - no clear trend`);
      return null; // Price is too close to EMA, no clear trend
    }

    if (currentPrice > currentEMA) {
      return { direction: 'BULLISH', position: 'ABOVE', distancePercent };
    } else {
      return { direction: 'BEARISH', position: 'BELOW', distancePercent };
    }
  }

  /**
   * Detect EMA crossover (fast EMA crosses slow EMA)
   */
  private detectEMACross(candles: Candle[]): { direction: 'BUY' | 'SELL' } | null {
    if (candles.length < 12) return null;

    const closes = candles.map(c => c.close);
    const ema5 = this.calculateEMA(closes, 5);
    const ema10 = this.calculateEMA(closes, 10);

    // Need at least 2 values to detect cross
    if (ema5.length < 2 || ema10.length < 2) return null;

    const currentFast = ema5[ema5.length - 1];
    const currentSlow = ema10[ema10.length - 1];
    const prevFast = ema5[ema5.length - 2];
    const prevSlow = ema10[ema10.length - 2];

    // Bullish cross: fast EMA crosses above slow EMA
    if (prevFast <= prevSlow && currentFast > currentSlow) {
      return { direction: 'BUY' };
    }

    // Bearish cross: fast EMA crosses below slow EMA
    if (prevFast >= prevSlow && currentFast < currentSlow) {
      return { direction: 'SELL' };
    }

    return null;
  }

  /**
   * Calculate EMA array
   */
  private calculateEMA(data: number[], period: number): number[] {
    if (data.length < period) return [];

    const multiplier = 2 / (period + 1);
    const ema: number[] = [];

    // First EMA is SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += data[i];
    }
    ema.push(sum / period);

    // Calculate remaining EMAs
    for (let i = period; i < data.length; i++) {
      ema.push((data[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }

    return ema;
  }

  /**
   * Check RSI for overbought/oversold conditions
   */
  private checkRSI(
    candles: Candle[],
  ): { direction: 'BUY' | 'SELL'; condition: string; value: number } | null {
    if (candles.length < 14) return null;

    const closes = candles.map(c => c.close);
    const rsi = this.calculateRSI(closes, 14);

    if (rsi === null) return null;

    // Oversold - potential buy
    if (rsi < 30) {
      return { direction: 'BUY', condition: 'oversold', value: rsi };
    }

    // Overbought - potential sell
    if (rsi > 70) {
      return { direction: 'SELL', condition: 'overbought', value: rsi };
    }

    return null;
  }

  /**
   * Calculate RSI
   */
  private calculateRSI(closes: number[], period: number = 14): number | null {
    if (closes.length < period + 1) return null;

    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Calculate smoothed RSI
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
      }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Update scalping configuration
   */
  setConfig(config: Partial<ScalpingConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.log('Scalping config updated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): ScalpingConfig {
    return { ...this.config };
  }

  /**
   * Get break-even price for position management
   */
  getBreakEvenPrice(entryPrice: number, direction: 'BUY' | 'SELL'): number {
    const pipValue = 0.1;
    if (direction === 'BUY') {
      return entryPrice + (this.config.breakEvenAtProfit * pipValue);
    } else {
      return entryPrice - (this.config.breakEvenAtProfit * pipValue);
    }
  }

  /**
   * Get trailing stop price
   */
  getTrailingStopPrice(currentPrice: number, direction: 'BUY' | 'SELL'): number {
    const pipValue = 0.1;
    if (direction === 'BUY') {
      return currentPrice - (this.config.trailingStopPips * pipValue);
    } else {
      return currentPrice + (this.config.trailingStopPips * pipValue);
    }
  }

  /**
   * Get partial take profit price (at 1R)
   */
  getPartialTPPrice(entryPrice: number, stopLoss: number, direction: 'BUY' | 'SELL'): number {
    const risk = Math.abs(entryPrice - stopLoss);
    if (direction === 'BUY') {
      return entryPrice + risk;
    } else {
      return entryPrice - risk;
    }
  }
}
