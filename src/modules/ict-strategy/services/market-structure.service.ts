import { Injectable } from '@nestjs/common';
import { Candle, SwingPoint, MarketStructure } from '../types';

@Injectable()
export class MarketStructureService {
  private readonly swingLookback = 5; // Number of candles to confirm swing

  /**
   * Identify swing highs and lows in price data
   */
  findSwingPoints(candles: Candle[]): SwingPoint[] {
    const swingPoints: SwingPoint[] = [];
    const lookback = this.swingLookback;

    for (let i = lookback; i < candles.length - lookback; i++) {
      const current = candles[i];
      
      // Check for swing high
      let isSwingHigh = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j !== i && candles[j].high >= current.high) {
          isSwingHigh = false;
          break;
        }
      }

      if (isSwingHigh) {
        swingPoints.push({
          index: i,
          price: current.high,
          type: 'HIGH',
          time: current.time,
          broken: false,
        });
      }

      // Check for swing low
      let isSwingLow = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j !== i && candles[j].low <= current.low) {
          isSwingLow = false;
          break;
        }
      }

      if (isSwingLow) {
        swingPoints.push({
          index: i,
          price: current.low,
          type: 'LOW',
          time: current.time,
          broken: false,
        });
      }
    }

    return swingPoints.sort((a, b) => a.index - b.index);
  }

  /**
   * Analyze market structure - identify trend, BOS, and CHoCH
   */
  analyzeMarketStructure(candles: Candle[]): MarketStructure {
    const swingPoints = this.findSwingPoints(candles);
    
    if (swingPoints.length < 4) {
      return {
        trend: 'RANGING',
        lastHigherHigh: null,
        lastHigherLow: null,
        lastLowerHigh: null,
        lastLowerLow: null,
        breakOfStructure: false,
        changeOfCharacter: false,
        currentSwingHigh: null,
        currentSwingLow: null,
      };
    }

    // Get recent swing highs and lows
    const swingHighs = swingPoints.filter(sp => sp.type === 'HIGH');
    const swingLows = swingPoints.filter(sp => sp.type === 'LOW');

    const currentSwingHigh = swingHighs[swingHighs.length - 1] || null;
    const currentSwingLow = swingLows[swingLows.length - 1] || null;
    const prevSwingHigh = swingHighs[swingHighs.length - 2] || null;
    const prevSwingLow = swingLows[swingLows.length - 2] || null;

    // Determine trend
    let trend: 'BULLISH' | 'BEARISH' | 'RANGING' = 'RANGING';
    let higherHighs = 0;
    let higherLows = 0;
    let lowerHighs = 0;
    let lowerLows = 0;

    // Count higher highs and higher lows (bullish structure)
    for (let i = 1; i < swingHighs.length; i++) {
      if (swingHighs[i].price > swingHighs[i - 1].price) {
        higherHighs++;
      } else {
        lowerHighs++;
      }
    }

    for (let i = 1; i < swingLows.length; i++) {
      if (swingLows[i].price > swingLows[i - 1].price) {
        higherLows++;
      } else {
        lowerLows++;
      }
    }

    // Determine trend based on structure
    if (higherHighs >= 2 && higherLows >= 2) {
      trend = 'BULLISH';
    } else if (lowerHighs >= 2 && lowerLows >= 2) {
      trend = 'BEARISH';
    }

    // Check for Break of Structure (BOS)
    const currentPrice = candles[candles.length - 1].close;
    let breakOfStructure = false;
    
    if (trend === 'BULLISH' && currentSwingLow) {
      // In bullish trend, BOS is when price breaks below the last swing low
      breakOfStructure = currentPrice < currentSwingLow.price;
    } else if (trend === 'BEARISH' && currentSwingHigh) {
      // In bearish trend, BOS is when price breaks above the last swing high
      breakOfStructure = currentPrice > currentSwingHigh.price;
    }

    // Check for Change of Character (CHoCH)
    let changeOfCharacter = false;
    if (trend === 'BULLISH' && prevSwingLow && currentSwingLow) {
      // CHoCH in bullish trend: lower low created
      changeOfCharacter = currentSwingLow.price < prevSwingLow.price;
    } else if (trend === 'BEARISH' && prevSwingHigh && currentSwingHigh) {
      // CHoCH in bearish trend: higher high created
      changeOfCharacter = currentSwingHigh.price > prevSwingHigh.price;
    }

    // Find last higher/lower points
    let lastHigherHigh: SwingPoint | null = null;
    let lastHigherLow: SwingPoint | null = null;
    let lastLowerHigh: SwingPoint | null = null;
    let lastLowerLow: SwingPoint | null = null;

    for (let i = swingHighs.length - 1; i > 0; i--) {
      if (!lastHigherHigh && swingHighs[i].price > swingHighs[i - 1].price) {
        lastHigherHigh = swingHighs[i];
      }
      if (!lastLowerHigh && swingHighs[i].price < swingHighs[i - 1].price) {
        lastLowerHigh = swingHighs[i];
      }
    }

    for (let i = swingLows.length - 1; i > 0; i--) {
      if (!lastHigherLow && swingLows[i].price > swingLows[i - 1].price) {
        lastHigherLow = swingLows[i];
      }
      if (!lastLowerLow && swingLows[i].price < swingLows[i - 1].price) {
        lastLowerLow = swingLows[i];
      }
    }

    return {
      trend,
      lastHigherHigh,
      lastHigherLow,
      lastLowerHigh,
      lastLowerLow,
      breakOfStructure,
      changeOfCharacter,
      currentSwingHigh,
      currentSwingLow,
    };
  }

  /**
   * Check if a specific swing level has been broken
   */
  isLevelBroken(level: number, candles: Candle[], type: 'HIGH' | 'LOW'): boolean {
    const recentCandles = candles.slice(-10);
    
    for (const candle of recentCandles) {
      if (type === 'HIGH' && candle.high > level) {
        return true;
      }
      if (type === 'LOW' && candle.low < level) {
        return true;
      }
    }
    
    return false;
  }
}
