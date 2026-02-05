import { Injectable, Logger } from '@nestjs/common';
import { Candle, TradeSetup, OrderBlock, FairValueGap } from '../types';

export interface ScalpingConfig {
  // Entry settings
  minConfidence: number;          // Minimum confidence to enter (lower = more aggressive)
  minRiskReward: number;          // Minimum R:R ratio
  maxSpreadPips: number;          // Max spread to trade
  
  // ATR-based Risk settings
  useAtrForSLTP: boolean;         // Use ATR-based SL/TP instead of fixed
  atrPeriod: number;              // Period for ATR calculation (default 14)
  atrSlMultiplier: number;        // SL = ATR * this multiplier
  atrTpMultiplier: number;        // TP = ATR * this multiplier
  minSlPips: number;              // Minimum SL in pips (floor)
  maxSlPips: number;              // Maximum SL in pips (cap)
  minTpPips: number;              // Minimum TP in pips (floor)
  maxTpPips: number;              // Maximum TP in pips (cap)
  
  // Fallback fixed pips (used when ATR not available)
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
// Optimized for quick in-and-out trades with ATR-based risk management
const AGGRESSIVE_SCALPING_CONFIG: ScalpingConfig = {
  minConfidence: 10,              // VERY LOW - take almost any setup
  minRiskReward: 1.0,             // 1:1 minimum for maximum entries
  maxSpreadPips: 50,              // Allow higher spread during volatile times
  
  // ATR-based SL/TP settings
  useAtrForSLTP: true,            // USE ATR for dynamic SL/TP
  atrPeriod: 14,                  // Standard 14-period ATR
  atrSlMultiplier: 1.2,           // SL = 1.2x ATR (protects against noise)
  atrTpMultiplier: 1.8,           // TP = 1.8x ATR (1.5 R:R ratio)
  minSlPips: 15,                  // Minimum 15 pips SL (floor)
  maxSlPips: 50,                  // Maximum 50 pips SL (cap)
  minTpPips: 20,                  // Minimum 20 pips TP
  maxTpPips: 80,                  // Maximum 80 pips TP
  
  // Fallback fixed pips (when ATR not available)
  stopLossPips: 25,               // Fallback 25 pip stop
  takeProfitPips: 40,             // Fallback 40 pip TP
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

    // ===== EXTENDED ANALYSIS DATA =====
    const last5 = candles.slice(-5);
    const last3 = candles.slice(-3);
    const last20 = candles.slice(-20);
    
    // Calculate averages for momentum
    const avg5 = last5.reduce((sum, c) => sum + c.close, 0) / 5;
    const avg3 = last3.reduce((sum, c) => sum + c.close, 0) / 3;
    const avg20 = last20.reduce((sum, c) => sum + c.close, 0) / 20;
    
    // Price position relative to averages
    const priceVsAvg5 = ((currentPrice - avg5) / avg5) * 100;
    const priceVsAvg3 = ((currentPrice - avg3) / avg3) * 100;
    const priceVsAvg20 = ((currentPrice - avg20) / avg20) * 100;
    
    // Calculate 20-candle high/low for overextension detection
    const high20 = Math.max(...last20.map(c => c.high));
    const low20 = Math.min(...last20.map(c => c.low));
    const range20 = high20 - low20;
    
    // Position in range (0 = at low, 100 = at high)
    const positionInRange = range20 > 0 ? ((currentPrice - low20) / range20) * 100 : 50;
    
    this.logger.log(`📊 Price vs AVG3: ${priceVsAvg3.toFixed(3)}%, vs AVG5: ${priceVsAvg5.toFixed(3)}%, vs AVG20: ${priceVsAvg20.toFixed(3)}%`);
    this.logger.log(`📊 Position in 20-candle range: ${positionInRange.toFixed(1)}% (Low: ${low20.toFixed(2)}, High: ${high20.toFixed(2)})`);

    // ===== OVEREXTENSION DETECTION =====
    // Prevent chasing moves that are already overextended
    const isOverextendedDown = positionInRange < 15 && priceVsAvg20 < -0.5; // At bottom 15% AND >0.5% below 20-period avg
    const isOverextendedUp = positionInRange > 85 && priceVsAvg20 > 0.5;    // At top 15% AND >0.5% above 20-period avg
    
    if (isOverextendedDown) {
      this.logger.log(`⚠️ OVEREXTENDED DOWN: Position ${positionInRange.toFixed(1)}% in range, ${priceVsAvg20.toFixed(2)}% below AVG20 - Looking for REVERSAL BUY`);
    }
    if (isOverextendedUp) {
      this.logger.log(`⚠️ OVEREXTENDED UP: Position ${positionInRange.toFixed(1)}% in range, ${priceVsAvg20.toFixed(2)}% above AVG20 - Looking for REVERSAL SELL`);
    }

    // ===== SIGNAL 1: REVERSAL DETECTION (Priority for overextended markets) =====
    // Look for reversal signals when market is stretched
    const lastBullish = lastCandle.close > lastCandle.open;
    const prevBullish = prevCandle.close > prevCandle.open;
    const engulfing = this.detectEngulfing(lastCandle, prevCandle);
    
    // Bullish reversal from oversold
    if (isOverextendedDown && lastBullish && !prevBullish) {
      direction = 'BUY';
      confidence += 50;
      reasons.push(`Bullish reversal from oversold (${positionInRange.toFixed(0)}% in range)`);
      this.logger.log(`🔄 BULLISH REVERSAL detected at oversold level`);
    }
    // Bearish reversal from overbought
    else if (isOverextendedUp && !lastBullish && prevBullish) {
      direction = 'SELL';
      confidence += 50;
      reasons.push(`Bearish reversal from overbought (${positionInRange.toFixed(0)}% in range)`);
      this.logger.log(`🔄 BEARISH REVERSAL detected at overbought level`);
    }
    // Bullish engulfing at oversold
    else if (isOverextendedDown && engulfing?.direction === 'BUY') {
      direction = 'BUY';
      confidence += 55;
      reasons.push(`Bullish engulfing at oversold level`);
      confluences.push('Reversal pattern');
      this.logger.log(`🔄 BULLISH ENGULFING at oversold`);
    }
    // Bearish engulfing at overbought
    else if (isOverextendedUp && engulfing?.direction === 'SELL') {
      direction = 'SELL';
      confidence += 55;
      reasons.push(`Bearish engulfing at overbought level`);
      confluences.push('Reversal pattern');
      this.logger.log(`🔄 BEARISH ENGULFING at overbought`);
    }

    // ===== SIGNAL 2: MOMENTUM (Only when NOT overextended) =====
    // Standard momentum following - but BLOCKED when overextended in same direction
    const momentumThreshold = 0.015; // 0.015% = ~$0.75 on Gold
    
    if (!direction) {
      if (priceVsAvg3 > momentumThreshold && priceVsAvg5 > 0) {
        // Don't BUY momentum when already overextended UP
        if (!isOverextendedUp) {
          direction = 'BUY';
          confidence += 40;
          reasons.push(`Price above 3-candle avg (+${priceVsAvg3.toFixed(3)}%)`);
          this.logger.log(`✅ BULLISH momentum: Price > AVG3`);
        } else {
          this.logger.log(`⛔ Blocked BUY momentum - overextended up`);
        }
      } else if (priceVsAvg3 < -momentumThreshold && priceVsAvg5 < 0) {
        // Don't SELL momentum when already overextended DOWN
        if (!isOverextendedDown) {
          direction = 'SELL';
          confidence += 40;
          reasons.push(`Price below 3-candle avg (${priceVsAvg3.toFixed(3)}%)`);
          this.logger.log(`✅ BEARISH momentum: Price < AVG3`);
        } else {
          this.logger.log(`⛔ Blocked SELL momentum - overextended down`);
        }
      }
    }

    // ===== SIGNAL 3: CANDLE DIRECTION (Confirmation) =====
    if (lastBullish && prevBullish) {
      if (direction === 'BUY') {
        confidence += 25;
        confluences.push('2 bullish candles');
      } else if (!direction && !isOverextendedUp) {
        direction = 'BUY';
        confidence += 30;
        reasons.push('2 consecutive bullish candles');
      }
    } else if (!lastBullish && !prevBullish) {
      if (direction === 'SELL') {
        confidence += 25;
        confluences.push('2 bearish candles');
      } else if (!direction && !isOverextendedDown) {
        direction = 'SELL';
        confidence += 30;
        reasons.push('2 consecutive bearish candles');
      }
    }

    // ===== SIGNAL 4: BREAKOUT DETECTION (Modified) =====
    const recentHigh = Math.max(...candles.slice(-10).map(c => c.high));
    const recentLow = Math.min(...candles.slice(-10).map(c => c.low));
    const range = recentHigh - recentLow;
    
    // Only add breakout confluence if NOT overextended
    if (currentPrice > recentHigh - (range * 0.1) && !isOverextendedUp) {
      if (direction === 'BUY') {
        confidence += 20;
        confluences.push('Breaking recent high');
      } else if (!direction) {
        direction = 'BUY';
        confidence += 35;
        reasons.push('Price at 10-candle high');
      }
      this.logger.log(`📈 Price near 10-candle HIGH: ${recentHigh.toFixed(2)}`);
    } else if (currentPrice < recentLow + (range * 0.1) && !isOverextendedDown) {
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

    // ===== SIGNAL 5: ENGULFING PATTERN (Non-reversal context) =====
    if (engulfing && !direction) {
      direction = engulfing.direction;
      confidence += 30;
      reasons.push(`${engulfing.type} engulfing pattern`);
    } else if (engulfing && engulfing.direction === direction) {
      confidence += 15;
      confluences.push(`${engulfing.type} engulfing`);
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

    // Calculate ATR-based or fixed SL/TP
    const pipValue = 0.20; // For Gold (1 pip = $0.20)
    
    let slPips: number;
    let tpPips: number;
    
    if (this.config.useAtrForSLTP && candles.length >= this.config.atrPeriod) {
      // Calculate ATR
      const atr = this.calculateATR(candles, this.config.atrPeriod);
      const atrInPips = atr / pipValue;
      
      // ATR-based SL/TP with min/max caps
      slPips = Math.min(this.config.maxSlPips, Math.max(this.config.minSlPips, atrInPips * this.config.atrSlMultiplier));
      tpPips = Math.min(this.config.maxTpPips, Math.max(this.config.minTpPips, atrInPips * this.config.atrTpMultiplier));
      
      this.logger.log(`📊 ATR(${this.config.atrPeriod}): ${atr.toFixed(2)} ($${atrInPips.toFixed(1)} pips) → SL: ${slPips.toFixed(1)} pips, TP: ${tpPips.toFixed(1)} pips`);
    } else {
      // Fallback to fixed pips
      slPips = this.config.stopLossPips;
      tpPips = this.config.takeProfitPips;
      this.logger.log(`📊 Using fixed SL/TP: SL: ${slPips} pips, TP: ${tpPips} pips`);
    }
    
    let stopLoss: number;
    let takeProfit: number;

    if (direction === 'BUY') {
      stopLoss = currentPrice - (slPips * pipValue);
      takeProfit = currentPrice + (tpPips * pipValue);
    } else {
      stopLoss = currentPrice + (slPips * pipValue);
      takeProfit = currentPrice - (tpPips * pipValue);
    }
    
    this.logger.log(`📊 Entry: ${currentPrice.toFixed(2)}, SL: ${stopLoss.toFixed(2)} (${slPips.toFixed(0)}p), TP: ${takeProfit.toFixed(2)} (${tpPips.toFixed(0)}p)`);

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
   * Detect bullish/bearish engulfing pattern
   */
  private detectEngulfing(
    current: Candle,
    previous: Candle,
  ): { direction: 'BUY' | 'SELL'; type: string } | null {
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
   * Calculate Average True Range (ATR) for dynamic SL/TP
   * ATR measures market volatility by averaging the true range over N periods
   */
  private calculateATR(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) {
      // Not enough candles, return a default based on recent range
      const recent = candles.slice(-5);
      const avgRange = recent.reduce((sum, c) => sum + (c.high - c.low), 0) / recent.length;
      return avgRange;
    }

    // Calculate True Range for each candle
    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];
      
      // True Range = max of:
      // 1. Current High - Current Low
      // 2. |Current High - Previous Close|
      // 3. |Current Low - Previous Close|
      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );
      trueRanges.push(tr);
    }

    // Take the last 'period' true ranges and average them
    const recentTRs = trueRanges.slice(-period);
    const atr = recentTRs.reduce((sum, tr) => sum + tr, 0) / recentTRs.length;
    
    return atr;
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
