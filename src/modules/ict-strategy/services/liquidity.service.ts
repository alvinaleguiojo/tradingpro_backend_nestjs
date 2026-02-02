import { Injectable } from '@nestjs/common';
import { Candle, LiquidityLevel, SwingPoint } from '../types';
import { MarketStructureService } from './market-structure.service';

@Injectable()
export class LiquidityService {
  constructor(private marketStructureService: MarketStructureService) {}

  /**
   * Identify liquidity levels based on swing highs/lows and equal highs/lows
   */
  findLiquidityLevels(candles: Candle[]): LiquidityLevel[] {
    const liquidityLevels: LiquidityLevel[] = [];
    
    // Get swing points
    const swingPoints = this.marketStructureService.findSwingPoints(candles);
    
    // Add swing points as liquidity levels
    for (const swing of swingPoints) {
      liquidityLevels.push({
        price: swing.price,
        type: swing.type === 'HIGH' ? 'BUY_SIDE' : 'SELL_SIDE',
        strength: this.calculateLiquidityStrength(swing, candles),
        swept: this.isLiquiditySwept(swing, candles),
        time: swing.time,
      });
    }
    
    // Find equal highs/lows (double/triple tops/bottoms)
    const equalLevels = this.findEqualLevels(candles);
    liquidityLevels.push(...equalLevels);
    
    // Find session highs/lows
    const sessionLevels = this.findSessionLevels(candles);
    liquidityLevels.push(...sessionLevels);
    
    return liquidityLevels;
  }

  /**
   * Calculate the strength of a liquidity level
   */
  private calculateLiquidityStrength(swing: SwingPoint, candles: Candle[]): number {
    let strength = 5;
    
    // Count how many times price has tested this level
    const tolerance = swing.price * 0.0005; // 0.05% tolerance
    let testCount = 0;
    
    for (const candle of candles) {
      if (swing.type === 'HIGH') {
        if (Math.abs(candle.high - swing.price) <= tolerance) {
          testCount++;
        }
      } else {
        if (Math.abs(candle.low - swing.price) <= tolerance) {
          testCount++;
        }
      }
    }
    
    // More tests = stronger liquidity
    strength += Math.min(3, testCount);
    
    // Check time in the market (older levels may be stronger)
    const swingIndex = candles.findIndex(c => c.time === swing.time);
    const age = candles.length - swingIndex;
    if (age > 50) strength += 1;
    if (age > 100) strength += 1;
    
    return Math.min(10, strength);
  }

  /**
   * Check if liquidity has been swept
   */
  private isLiquiditySwept(swing: SwingPoint, candles: Candle[]): boolean {
    const swingIndex = candles.findIndex(c => c.time === swing.time);
    const subsequentCandles = candles.slice(swingIndex + 1);
    
    for (const candle of subsequentCandles) {
      if (swing.type === 'HIGH' && candle.high > swing.price) {
        return true;
      }
      if (swing.type === 'LOW' && candle.low < swing.price) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Find equal highs and lows (double/triple tops/bottoms)
   */
  private findEqualLevels(candles: Candle[]): LiquidityLevel[] {
    const levels: LiquidityLevel[] = [];
    const tolerance = 0.0003; // 0.03% tolerance for "equal" levels
    
    // Group highs and lows by similar price
    const highsByLevel: Map<number, Candle[]> = new Map();
    const lowsByLevel: Map<number, Candle[]> = new Map();
    
    for (const candle of candles) {
      // Group highs
      let foundHighLevel = false;
      for (const [level, groupedCandles] of highsByLevel) {
        if (Math.abs(candle.high - level) / level <= tolerance) {
          groupedCandles.push(candle);
          foundHighLevel = true;
          break;
        }
      }
      if (!foundHighLevel) {
        highsByLevel.set(candle.high, [candle]);
      }
      
      // Group lows
      let foundLowLevel = false;
      for (const [level, groupedCandles] of lowsByLevel) {
        if (Math.abs(candle.low - level) / level <= tolerance) {
          groupedCandles.push(candle);
          foundLowLevel = true;
          break;
        }
      }
      if (!foundLowLevel) {
        lowsByLevel.set(candle.low, [candle]);
      }
    }
    
    // Add equal highs (buy-side liquidity)
    for (const [level, groupedCandles] of highsByLevel) {
      if (groupedCandles.length >= 2) {
        levels.push({
          price: level,
          type: 'BUY_SIDE',
          strength: 5 + Math.min(3, groupedCandles.length),
          swept: false,
          time: groupedCandles[groupedCandles.length - 1].time,
        });
      }
    }
    
    // Add equal lows (sell-side liquidity)
    for (const [level, groupedCandles] of lowsByLevel) {
      if (groupedCandles.length >= 2) {
        levels.push({
          price: level,
          type: 'SELL_SIDE',
          strength: 5 + Math.min(3, groupedCandles.length),
          swept: false,
          time: groupedCandles[groupedCandles.length - 1].time,
        });
      }
    }
    
    return levels;
  }

  /**
   * Find session highs/lows (Asian, London, NY)
   */
  private findSessionLevels(candles: Candle[]): LiquidityLevel[] {
    const levels: LiquidityLevel[] = [];
    
    // Group candles by session
    // This is simplified - in production you'd need proper timezone handling
    const today = new Date();
    const recentCandles = candles.slice(-96); // Last 24 hours for 15min TF
    
    if (recentCandles.length > 0) {
      const dailyHigh = Math.max(...recentCandles.map(c => c.high));
      const dailyLow = Math.min(...recentCandles.map(c => c.low));
      
      levels.push({
        price: dailyHigh,
        type: 'BUY_SIDE',
        strength: 8,
        swept: false,
        time: recentCandles[recentCandles.length - 1].time,
      });
      
      levels.push({
        price: dailyLow,
        type: 'SELL_SIDE',
        strength: 8,
        swept: false,
        time: recentCandles[recentCandles.length - 1].time,
      });
    }
    
    return levels;
  }

  /**
   * Get buy-side liquidity levels (above current price)
   */
  getBuySideLiquidity(levels: LiquidityLevel[], currentPrice: number): LiquidityLevel[] {
    return levels
      .filter(l => l.type === 'BUY_SIDE' && l.price > currentPrice && !l.swept)
      .sort((a, b) => a.price - b.price);
  }

  /**
   * Get sell-side liquidity levels (below current price)
   */
  getSellSideLiquidity(levels: LiquidityLevel[], currentPrice: number): LiquidityLevel[] {
    return levels
      .filter(l => l.type === 'SELL_SIDE' && l.price < currentPrice && !l.swept)
      .sort((a, b) => b.price - a.price);
  }

  /**
   * Find the nearest liquidity level
   */
  findNearestLiquidity(
    levels: LiquidityLevel[],
    currentPrice: number,
    direction: 'ABOVE' | 'BELOW',
  ): LiquidityLevel | null {
    const filtered = levels.filter(l => {
      if (l.swept) return false;
      if (direction === 'ABOVE') return l.price > currentPrice;
      return l.price < currentPrice;
    });
    
    if (filtered.length === 0) return null;
    
    if (direction === 'ABOVE') {
      return filtered.reduce((nearest, l) =>
        l.price < nearest.price ? l : nearest
      );
    } else {
      return filtered.reduce((nearest, l) =>
        l.price > nearest.price ? l : nearest
      );
    }
  }
}
