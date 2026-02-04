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

// Aggressive scalping defaults for XAU/USD
const AGGRESSIVE_SCALPING_CONFIG: ScalpingConfig = {
  minConfidence: 20,              // Minimum confidence to trade (more aggressive)
  minRiskReward: 1.5,             // Increased from 1.2 - better reward
  maxSpreadPips: 30,              // Max 30 pips spread for gold
  
  stopLossPips: 50,               // Tight 50 pip stop (5 dollars on 0.01 lot)
  takeProfitPips: 100,            // Increased from 80 - allow more profit on winners
  trailingStopPips: 40,           // Increased from 30 - give more room
  
  usePartialTakeProfit: true,
  partialProfitPercent: 50,       // Close 50% at first target
  breakEvenAtProfit: 40,          // Increased from 30 - move to BE after 40 pips
  
  onlyTradeDuringKillZones: false, // Trade any time for scalping
  allowCounterTrend: false,        // Changed to false - only trade with trend
};

@Injectable()
export class ScalpingStrategyService {
  private readonly logger = new Logger('ScalpingStrategy');
  private config: ScalpingConfig = AGGRESSIVE_SCALPING_CONFIG;

  /**
   * Analyze for aggressive scalping opportunities
   * Focuses on momentum, quick reversals, and tight entries
   */
  analyzeForScalp(
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
    this.logger.log(`Analyzing ${candles.length} candles. Last candle: O=${lastCandle.open?.toFixed(2)} H=${lastCandle.high?.toFixed(2)} L=${lastCandle.low?.toFixed(2)} C=${lastCandle.close?.toFixed(2)}`);

    // Validate candle data
    if (!lastCandle.open || !lastCandle.high || !lastCandle.low || !lastCandle.close) {
      this.logger.error(`Invalid candle data - missing OHLC values: ${JSON.stringify(lastCandle)}`);
      return null;
    }

    // Check spread
    if (spread > this.config.maxSpreadPips) {
      this.logger.debug(`Spread too high: ${spread} pips (max: ${this.config.maxSpreadPips})`);
      return null;
    }

    const reasons: string[] = [];
    const confluences: string[] = [];
    let confidence = 0;

    const prevCandle = candles[candles.length - 2];
    const prev2Candle = candles[candles.length - 3];

    // Collect all signals first, then determine direction by priority/weight
    const buySignals: { name: string; weight: number }[] = [];
    const sellSignals: { name: string; weight: number }[] = [];

    // === SCALPING SIGNAL 1: Engulfing Pattern (Strong reversal - HIGH PRIORITY) ===
    const engulfing = this.detectEngulfing(lastCandle, prevCandle);
    if (engulfing) {
      if (engulfing.direction === 'BUY') {
        buySignals.push({ name: `${engulfing.type} engulfing pattern`, weight: 35 });
      } else {
        sellSignals.push({ name: `${engulfing.type} engulfing pattern`, weight: 35 });
      }
      this.logger.log(`✓ Engulfing detected: ${engulfing.type} ${engulfing.direction}`);
    }

    // === SCALPING SIGNAL 2: Pin Bar / Rejection (HIGH PRIORITY - reversal signal) ===
    const pinBar = this.detectPinBar(lastCandle);
    if (pinBar) {
      if (pinBar.direction === 'BUY') {
        buySignals.push({ name: `Pin bar rejection (${pinBar.type})`, weight: 30 });
      } else {
        sellSignals.push({ name: `Pin bar rejection (${pinBar.type})`, weight: 30 });
      }
      this.logger.log(`✓ Pin bar detected: ${pinBar.type} ${pinBar.direction}`);
    }

    // === SCALPING SIGNAL 3: Three Candle Momentum (LOWER PRIORITY - often lagging) ===
    const momentum = this.detectMomentum(candles.slice(-5));
    if (momentum) {
      if (momentum.direction === 'BUY') {
        buySignals.push({ name: `Strong BUY momentum`, weight: 20 });
      } else {
        sellSignals.push({ name: `Strong SELL momentum`, weight: 20 });
      }
      this.logger.log(`✓ Momentum detected: ${momentum.direction}`);
    }

    // === SCALPING SIGNAL 4: Double Top/Bottom (Quick reversal - HIGH PRIORITY) ===
    const doublePattern = this.detectDoubleTopBottom(candles.slice(-20), currentPrice);
    if (doublePattern) {
      if (doublePattern.direction === 'BUY') {
        buySignals.push({ name: `${doublePattern.type} pattern at ${doublePattern.level.toFixed(2)}`, weight: 30 });
      } else {
        sellSignals.push({ name: `${doublePattern.type} pattern at ${doublePattern.level.toFixed(2)}`, weight: 30 });
      }
    }

    // === SCALPING SIGNAL 5: Quick Liquidity Grab (HIGHEST PRIORITY - institutional) ===
    const liquidityGrab = this.detectQuickLiquidityGrab(candles.slice(-10));
    if (liquidityGrab) {
      if (liquidityGrab.direction === 'BUY') {
        buySignals.push({ name: `Liquidity grab ${liquidityGrab.type}`, weight: 35 });
      } else {
        sellSignals.push({ name: `Liquidity grab ${liquidityGrab.type}`, weight: 35 });
      }
    }

    // === SCALPING SIGNAL 6: EMA Cross (confirmation signal) ===
    const emaCross = this.detectEMACross(candles.slice(-20));
    if (emaCross) {
      if (emaCross.direction === 'BUY') {
        buySignals.push({ name: `EMA crossover`, weight: 10 });
      } else {
        sellSignals.push({ name: `EMA crossover`, weight: 10 });
      }
    }

    // === TREND FILTER: Check if price is above/below EMA50 ===
    // Use full candle data for better trend detection (EMA50 on M5 = ~4 hours of data)
    const trendDirection = this.getTrendDirection(candles);
    if (trendDirection) {
      this.logger.log(`📊 Trend direction: ${trendDirection.direction} (price ${trendDirection.position} EMA50, distance: ${trendDirection.distancePercent.toFixed(2)}%)`);
    }

    // === SCALPING SIGNAL 7: RSI Extremes (reversal signal) ===
    const rsiSignal = this.checkRSI(candles.slice(-14));
    if (rsiSignal) {
      if (rsiSignal.direction === 'BUY') {
        buySignals.push({ name: `RSI ${rsiSignal.condition} (${rsiSignal.value.toFixed(0)})`, weight: 20 });
      } else {
        sellSignals.push({ name: `RSI ${rsiSignal.condition} (${rsiSignal.value.toFixed(0)})`, weight: 20 });
      }
    }

    // Calculate total weight for each direction
    const buyWeight = buySignals.reduce((sum, s) => sum + s.weight, 0);
    const sellWeight = sellSignals.reduce((sum, s) => sum + s.weight, 0);

    this.logger.log(`Signal weights - BUY: ${buyWeight} (${buySignals.length} signals), SELL: ${sellWeight} (${sellSignals.length} signals)`);

    // Determine direction based on which side has more weight
    // Require a minimum difference to avoid conflicting signals
    const minWeightDifference = 10;
    let direction: 'BUY' | 'SELL' | null = null;
    
    if (buyWeight > sellWeight + minWeightDifference) {
      direction = 'BUY';
      reasons.push(...buySignals.map(s => s.name));
      confidence = buyWeight;
    } else if (sellWeight > buyWeight + minWeightDifference) {
      direction = 'SELL';
      reasons.push(...sellSignals.map(s => s.name));
      confidence = sellWeight;
    } else if (buyWeight > 0 || sellWeight > 0) {
      // Conflicting signals - no clear direction
      this.logger.log(`⏸️ Conflicting signals - BUY weight: ${buyWeight}, SELL weight: ${sellWeight}`);
      return null;
    }

    // No signals at all
    if (!direction) {
      this.logger.log(`No scalping signal - no pattern detected. Checked: engulfing, pinBar, momentum, doublePattern, liquidityGrab, emaCross, rsi`);
      return null;
    }

    // === TREND FILTER (Critical) ===
    // Block trades that go against the main trend (price above/below EMA20)
    if (trendDirection && !this.config.allowCounterTrend) {
      if (direction === 'BUY' && trendDirection.direction === 'BEARISH') {
        this.logger.log(`🚫 BUY signal BLOCKED - Price is BELOW EMA20 (bearish trend). Not taking BUY in downtrend.`);
        return null;
      }
      if (direction === 'SELL' && trendDirection.direction === 'BULLISH') {
        this.logger.log(`🚫 SELL signal BLOCKED - Price is ABOVE EMA20 (bullish trend). Not taking SELL in uptrend.`);
        return null;
      }
      // Add trend confirmation to confluences
      confluences.push(`Trend aligned (${trendDirection.direction})`);
    }

    // Add EMA as confluence if it confirms direction
    if (emaCross && emaCross.direction === direction) {
      confluences.push(`EMA crossover confirmation`);
    } else if (emaCross && emaCross.direction !== direction) {
      confidence -= 10; // Penalty for going against EMA
      this.logger.log(`⚠️ Trading against EMA trend - confidence reduced`);
    }

    // Check minimum confidence
    if (confidence < this.config.minConfidence) {
      this.logger.log(`No scalping signal - confidence too low: ${confidence}% (min: ${this.config.minConfidence}%)`);
      return null;
    }

    // Calculate tight scalping levels
    // For XAU/USD (Gold) - broker requires minimum 1000 points distance for SL/TP
    // With 3-digit pricing (e.g., 4916.606), we need larger distances
    // 1 pip for Gold = 0.10 price, but broker limit requires ~1-2 dollar distance
    // Setting pip value to 0.20 gives us: 50 pips * 0.20 = $10 SL, 80 pips * 0.20 = $16 TP
    const pipValue = 0.20; // Increased for Gold to meet broker minimum SL/TP distance
    
    let stopLoss: number;
    let takeProfit: number;

    if (direction === 'BUY') {
      stopLoss = currentPrice - (this.config.stopLossPips * pipValue);
      takeProfit = currentPrice + (this.config.takeProfitPips * pipValue);
    } else {
      stopLoss = currentPrice + (this.config.stopLossPips * pipValue);
      takeProfit = currentPrice - (this.config.takeProfitPips * pipValue);
    }
    
    this.logger.log(`Scalping SL/TP: Entry=${currentPrice.toFixed(2)}, SL=${stopLoss.toFixed(2)}, TP=${takeProfit.toFixed(2)} (${this.config.stopLossPips}/${this.config.takeProfitPips} pips)`);

    const risk = Math.abs(currentPrice - stopLoss);
    const reward = Math.abs(takeProfit - currentPrice);
    const riskRewardRatio = reward / risk;

    if (riskRewardRatio < this.config.minRiskReward) {
      return null;
    }

    // Add scalping-specific metadata
    confluences.push(`Tight SL: ${this.config.stopLossPips} pips`);
    confluences.push(`Quick TP: ${this.config.takeProfitPips} pips`);

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

    // Strong BULLISH momentum: net positive change AND mostly higher highs/higher lows
    if (netChangePercent > 0.05 && higherHighs >= 3 && higherLows >= 2) {
      this.logger.log(`✅ BULLISH momentum confirmed: +${netChangePercent.toFixed(3)}%`);
      return { direction: 'BUY', strength: netChange };
    }
    
    // Strong BEARISH momentum: net negative change AND mostly lower highs/lower lows
    if (netChangePercent < -0.05 && lowerHighs >= 3 && lowerLows >= 2) {
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
   * Get overall trend direction based on price position relative to EMA50
   * EMA50 on M5 timeframe = ~4 hours of price data for better trend reading
   * This is used as a trend filter to avoid trading against the main trend
   */
  private getTrendDirection(candles: Candle[]): { direction: 'BULLISH' | 'BEARISH'; position: string; distancePercent: number } | null {
    if (candles.length < 50) {
      this.logger.warn(`Not enough candles for trend filter: ${candles.length} (need 50+)`);
      return null;
    }

    const closes = candles.map(c => c.close);
    const ema50 = this.calculateEMA(closes, 50);
    
    if (ema50.length === 0) return null;

    const currentPrice = closes[closes.length - 1];
    const currentEMA = ema50[ema50.length - 1];
    
    // Calculate how far price is from EMA (as percentage)
    const distancePercent = ((currentPrice - currentEMA) / currentEMA) * 100;
    
    this.logger.log(`📈 EMA50 trend check: Price=${currentPrice.toFixed(2)}, EMA50=${currentEMA.toFixed(2)}, Distance=${distancePercent.toFixed(3)}%`);
    
    // Require price to be at least 0.1% away from EMA to confirm trend
    // This prevents choppy signals when price is hovering around EMA
    if (Math.abs(distancePercent) < 0.1) {
      this.logger.log(`⏸️ Price too close to EMA50 (${distancePercent.toFixed(3)}%) - no clear trend`);
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
