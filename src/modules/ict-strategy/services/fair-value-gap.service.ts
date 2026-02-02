import { Injectable } from '@nestjs/common';
import { Candle, FairValueGap } from '../types';

@Injectable()
export class FairValueGapService {
  /**
   * Identify Fair Value Gaps (FVG) in price data
   * FVG is a 3-candle pattern where there's a gap between candle 1 and candle 3
   */
  findFairValueGaps(candles: Candle[]): FairValueGap[] {
    const fvgs: FairValueGap[] = [];

    for (let i = 2; i < candles.length; i++) {
      const candle1 = candles[i - 2];
      const candle2 = candles[i - 1];
      const candle3 = candles[i];

      // Bullish FVG: Gap between candle 1 high and candle 3 low
      // This occurs during a strong bullish move
      if (candle3.low > candle1.high) {
        const gapSize = candle3.low - candle1.high;
        const candleRange = Math.abs(candle2.high - candle2.low);
        
        // Only consider significant FVGs (gap should be meaningful)
        if (gapSize > candleRange * 0.1) {
          fvgs.push({
            index: i - 1, // Middle candle index
            type: 'BULLISH',
            high: candle3.low,
            low: candle1.high,
            midpoint: (candle3.low + candle1.high) / 2,
            time: candle2.time,
            filled: false,
            fillPercentage: 0,
          });
        }
      }

      // Bearish FVG: Gap between candle 1 low and candle 3 high
      // This occurs during a strong bearish move
      if (candle3.high < candle1.low) {
        const gapSize = candle1.low - candle3.high;
        const candleRange = Math.abs(candle2.high - candle2.low);
        
        // Only consider significant FVGs
        if (gapSize > candleRange * 0.1) {
          fvgs.push({
            index: i - 1,
            type: 'BEARISH',
            high: candle1.low,
            low: candle3.high,
            midpoint: (candle1.low + candle3.high) / 2,
            time: candle2.time,
            filled: false,
            fillPercentage: 0,
          });
        }
      }
    }

    // Check FVG fill status
    return this.checkFVGFillStatus(fvgs, candles);
  }

  /**
   * Check how much of each FVG has been filled
   */
  private checkFVGFillStatus(fvgs: FairValueGap[], candles: Candle[]): FairValueGap[] {
    return fvgs.map(fvg => {
      const subsequentCandles = candles.slice(fvg.index + 2);
      const fvgSize = fvg.high - fvg.low;
      let maxFill = 0;

      for (const candle of subsequentCandles) {
        if (fvg.type === 'BULLISH') {
          // For bullish FVG, price needs to retrace down into the gap
          if (candle.low <= fvg.high) {
            const fillAmount = fvg.high - Math.max(candle.low, fvg.low);
            maxFill = Math.max(maxFill, fillAmount);
          }
        } else {
          // For bearish FVG, price needs to retrace up into the gap
          if (candle.high >= fvg.low) {
            const fillAmount = Math.min(candle.high, fvg.high) - fvg.low;
            maxFill = Math.max(maxFill, fillAmount);
          }
        }
      }

      const fillPercentage = (maxFill / fvgSize) * 100;
      
      return {
        ...fvg,
        filled: fillPercentage >= 100,
        fillPercentage: Math.min(100, fillPercentage),
      };
    });
  }

  /**
   * Get unfilled FVGs (potential trading opportunities)
   */
  getUnfilledFVGs(fvgs: FairValueGap[], minUnfilled: number = 50): FairValueGap[] {
    return fvgs.filter(fvg => !fvg.filled && fvg.fillPercentage < minUnfilled);
  }

  /**
   * Find the nearest FVG to current price
   */
  findNearestFVG(
    fvgs: FairValueGap[],
    currentPrice: number,
    type: 'BULLISH' | 'BEARISH',
  ): FairValueGap | null {
    const unfilledFVGs = fvgs.filter(fvg => 
      !fvg.filled && 
      fvg.type === type &&
      fvg.fillPercentage < 75 // At least 25% unfilled
    );

    if (unfilledFVGs.length === 0) return null;

    if (type === 'BULLISH') {
      // Find nearest bullish FVG below current price
      const fvgsBelow = unfilledFVGs.filter(fvg => fvg.high < currentPrice);
      if (fvgsBelow.length === 0) return null;
      return fvgsBelow.reduce((nearest, fvg) =>
        fvg.high > nearest.high ? fvg : nearest
      );
    } else {
      // Find nearest bearish FVG above current price
      const fvgsAbove = unfilledFVGs.filter(fvg => fvg.low > currentPrice);
      if (fvgsAbove.length === 0) return null;
      return fvgsAbove.reduce((nearest, fvg) =>
        fvg.low < nearest.low ? fvg : nearest
      );
    }
  }

  /**
   * Check if price is currently in an FVG
   */
  isPriceInFVG(fvgs: FairValueGap[], currentPrice: number): FairValueGap | null {
    for (const fvg of fvgs) {
      if (fvg.filled) continue;
      
      if (currentPrice >= fvg.low && currentPrice <= fvg.high) {
        return fvg;
      }
    }
    return null;
  }

  /**
   * Calculate optimal entry within an FVG (typically the midpoint or 50% level)
   */
  getOptimalEntry(fvg: FairValueGap): number {
    // The optimal entry is typically at the 50% level of the FVG
    return fvg.midpoint;
  }

  /**
   * Find consequent encroachment (CE) level - the 50% of FVG
   */
  getConsequentEncroachment(fvg: FairValueGap): number {
    return fvg.midpoint;
  }
}
