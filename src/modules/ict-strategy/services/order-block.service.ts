import { Injectable } from '@nestjs/common';
import { Candle, OrderBlock } from '../types';

@Injectable()
export class OrderBlockService {
  /**
   * Identify Order Blocks in price data
   * An Order Block is the last bullish/bearish candle before a significant move in the opposite direction
   */
  findOrderBlocks(candles: Candle[]): OrderBlock[] {
    const orderBlocks: OrderBlock[] = [];
    const minMoveMultiplier = 2; // The impulse move should be at least 2x the OB candle

    for (let i = 1; i < candles.length - 3; i++) {
      const currentCandle = candles[i];
      const nextCandles = candles.slice(i + 1, i + 4);

      // Calculate candle properties
      const isBullishCandle = currentCandle.close > currentCandle.open;
      const isBearishCandle = currentCandle.close < currentCandle.open;
      const candleBody = Math.abs(currentCandle.close - currentCandle.open);

      // Check for Bullish Order Block
      // Last bearish candle before a strong bullish move
      if (isBearishCandle && candleBody > 0) {
        const impulseMoveUp = this.calculateImpulseMove(nextCandles, 'UP');
        
        if (impulseMoveUp > candleBody * minMoveMultiplier) {
          const strength = this.calculateOBStrength(candleBody, impulseMoveUp, candles, i);
          
          orderBlocks.push({
            index: i,
            type: 'BULLISH',
            high: currentCandle.high,
            low: currentCandle.low,
            midpoint: (currentCandle.high + currentCandle.low) / 2,
            time: currentCandle.time,
            valid: true,
            tested: false,
            strength,
          });
        }
      }

      // Check for Bearish Order Block
      // Last bullish candle before a strong bearish move
      if (isBullishCandle && candleBody > 0) {
        const impulseMoveDown = this.calculateImpulseMove(nextCandles, 'DOWN');
        
        if (impulseMoveDown > candleBody * minMoveMultiplier) {
          const strength = this.calculateOBStrength(candleBody, impulseMoveDown, candles, i);
          
          orderBlocks.push({
            index: i,
            type: 'BEARISH',
            high: currentCandle.high,
            low: currentCandle.low,
            midpoint: (currentCandle.high + currentCandle.low) / 2,
            time: currentCandle.time,
            valid: true,
            tested: false,
            strength,
          });
        }
      }
    }

    // Validate order blocks (check if they've been mitigated)
    return this.validateOrderBlocks(orderBlocks, candles);
  }

  /**
   * Calculate the impulse move after a potential order block
   */
  private calculateImpulseMove(candles: Candle[], direction: 'UP' | 'DOWN'): number {
    if (candles.length === 0) return 0;

    if (direction === 'UP') {
      const highestHigh = Math.max(...candles.map(c => c.high));
      const lowestLow = Math.min(...candles.map(c => c.low));
      return highestHigh - lowestLow;
    } else {
      const highestHigh = Math.max(...candles.map(c => c.high));
      const lowestLow = Math.min(...candles.map(c => c.low));
      return highestHigh - lowestLow;
    }
  }

  /**
   * Calculate the strength of an order block (1-10)
   */
  private calculateOBStrength(
    obBodySize: number,
    impulseMove: number,
    candles: Candle[],
    obIndex: number,
  ): number {
    let strength = 5;

    // Factor 1: Impulse move ratio
    const impulseRatio = impulseMove / obBodySize;
    if (impulseRatio > 5) strength += 2;
    else if (impulseRatio > 3) strength += 1;

    // Factor 2: OB formed after liquidity sweep
    if (obIndex > 5) {
      const priorCandles = candles.slice(obIndex - 5, obIndex);
      const priorLow = Math.min(...priorCandles.map(c => c.low));
      const priorHigh = Math.max(...priorCandles.map(c => c.high));
      const ob = candles[obIndex];

      // Check if OB swept prior liquidity
      if (ob.low < priorLow || ob.high > priorHigh) {
        strength += 1;
      }
    }

    // Factor 3: Volume (if available)
    const obVolume = candles[obIndex].volume || 0;
    const avgVolume = candles.slice(Math.max(0, obIndex - 20), obIndex)
      .reduce((sum, c) => sum + (c.volume || 0), 0) / 20;
    
    if (obVolume > avgVolume * 1.5) {
      strength += 1;
    }

    return Math.min(10, Math.max(1, strength));
  }

  /**
   * Validate order blocks - check if they've been mitigated
   */
  private validateOrderBlocks(orderBlocks: OrderBlock[], candles: Candle[]): OrderBlock[] {
    return orderBlocks.map(ob => {
      // Check candles after the order block
      const subsequentCandles = candles.slice(ob.index + 1);
      
      for (const candle of subsequentCandles) {
        if (ob.type === 'BULLISH') {
          // Bullish OB is invalidated if price closes below OB low
          if (candle.close < ob.low) {
            ob.valid = false;
            break;
          }
          // OB is tested if price wicks into it
          if (candle.low <= ob.high && candle.low >= ob.low) {
            ob.tested = true;
          }
        } else {
          // Bearish OB is invalidated if price closes above OB high
          if (candle.close > ob.high) {
            ob.valid = false;
            break;
          }
          // OB is tested if price wicks into it
          if (candle.high >= ob.low && candle.high <= ob.high) {
            ob.tested = true;
          }
        }
      }
      
      return ob;
    });
  }

  /**
   * Find the nearest valid order block to current price
   */
  findNearestOrderBlock(
    orderBlocks: OrderBlock[],
    currentPrice: number,
    type: 'BULLISH' | 'BEARISH',
  ): OrderBlock | null {
    const validBlocks = orderBlocks.filter(ob => ob.valid && ob.type === type);
    
    if (validBlocks.length === 0) return null;

    if (type === 'BULLISH') {
      // Find the nearest bullish OB below current price
      const blocksBelow = validBlocks.filter(ob => ob.high < currentPrice);
      if (blocksBelow.length === 0) return null;
      return blocksBelow.reduce((nearest, ob) => 
        ob.high > nearest.high ? ob : nearest
      );
    } else {
      // Find the nearest bearish OB above current price
      const blocksAbove = validBlocks.filter(ob => ob.low > currentPrice);
      if (blocksAbove.length === 0) return null;
      return blocksAbove.reduce((nearest, ob) => 
        ob.low < nearest.low ? ob : nearest
      );
    }
  }

  /**
   * Check if price is currently at an order block
   */
  isPriceAtOrderBlock(
    orderBlocks: OrderBlock[],
    currentPrice: number,
    tolerance: number = 0.0005, // 0.05% tolerance
  ): OrderBlock | null {
    for (const ob of orderBlocks) {
      if (!ob.valid) continue;
      
      const expandedHigh = ob.high * (1 + tolerance);
      const expandedLow = ob.low * (1 - tolerance);
      
      if (currentPrice >= expandedLow && currentPrice <= expandedHigh) {
        return ob;
      }
    }
    return null;
  }
}
