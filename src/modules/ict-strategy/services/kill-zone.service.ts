import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KillZone } from '../types';

@Injectable()
export class KillZoneService {
  // Broker timezone offset from UTC (e.g., +2 for UTC+2, +8 for Singapore)
  // Most MT5 brokers use UTC+2 or UTC+3 (during DST)
  private readonly brokerTimezoneOffset: number;

  constructor(private configService: ConfigService) {
    // Default to UTC+2 (common for most forex brokers)
    // Can be configured via environment variable
    this.brokerTimezoneOffset = parseInt(
      this.configService.get('MT5_BROKER_TIMEZONE_OFFSET', '2'),
      10,
    );
  }

  // ICT Kill Zones (in BROKER SERVER TIME)
  // These times are based on broker server timezone
  private readonly killZones: KillZone[] = [
    {
      name: 'Asian Session',
      active: false,
      bias: 'NEUTRAL',
      startHour: 2,   // 00:00 UTC = 02:00 Broker (UTC+2)
      endHour: 10,    // 08:00 UTC = 10:00 Broker (UTC+2)
    },
    {
      name: 'London Open Kill Zone',
      active: false,
      bias: 'NEUTRAL',
      startHour: 9,   // 07:00 UTC = 09:00 Broker (UTC+2)
      endHour: 12,    // 10:00 UTC = 12:00 Broker (UTC+2)
    },
    {
      name: 'New York Open Kill Zone',
      active: false,
      bias: 'NEUTRAL',
      startHour: 14,  // 12:00 UTC = 14:00 Broker (UTC+2)
      endHour: 17,    // 15:00 UTC = 17:00 Broker (UTC+2)
    },
    {
      name: 'London Close Kill Zone',
      active: false,
      bias: 'NEUTRAL',
      startHour: 17,  // 15:00 UTC = 17:00 Broker (UTC+2)
      endHour: 19,    // 17:00 UTC = 19:00 Broker (UTC+2)
    },
  ];

  /**
   * Get the current broker server time
   * Converts UTC to broker timezone
   */
  getBrokerTime(): Date {
    const now = new Date();
    const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utcTime + this.brokerTimezoneOffset * 3600000);
  }

  /**
   * Get the current broker hour (0-23)
   */
  getBrokerHour(): number {
    return this.getBrokerTime().getHours();
  }

  /**
   * Get the current kill zone based on broker server time
   */
  getCurrentKillZone(): KillZone | null {
    const currentHour = this.getBrokerHour();
    
    for (const zone of this.killZones) {
      if (currentHour >= zone.startHour && currentHour < zone.endHour) {
        return {
          ...zone,
          active: true,
        };
      }
    }
    
    return null;
  }

  /**
   * Get timezone info for debugging/display
   */
  getTimezoneInfo(): {
    brokerOffset: number;
    brokerTime: string;
    brokerHour: number;
    utcTime: string;
  } {
    const brokerTime = this.getBrokerTime();
    return {
      brokerOffset: this.brokerTimezoneOffset,
      brokerTime: brokerTime.toISOString(),
      brokerHour: brokerTime.getHours(),
      utcTime: new Date().toISOString(),
    };
  }

  /**
   * Check if we're in a high-probability trading window
   */
  isInKillZone(): boolean {
    return this.getCurrentKillZone() !== null;
  }

  /**
   * Get trading bias based on the current session
   */
  getSessionBias(asianHigh: number, asianLow: number, currentPrice: number): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const killZone = this.getCurrentKillZone();
    
    if (!killZone) return 'NEUTRAL';
    
    // If we're in London or NY session, determine bias based on Asian range
    if (killZone.name === 'London Open Kill Zone' || killZone.name === 'New York Open Kill Zone') {
      // ICT concept: Price sweeping Asian session liquidity provides bias
      const asianMid = (asianHigh + asianLow) / 2;
      
      if (currentPrice > asianHigh) {
        // Swept Asian high, looking for reversal (bearish)
        return 'BEARISH';
      } else if (currentPrice < asianLow) {
        // Swept Asian low, looking for reversal (bullish)
        return 'BULLISH';
      } else if (currentPrice > asianMid) {
        return 'BULLISH';
      } else {
        return 'BEARISH';
      }
    }
    
    return 'NEUTRAL';
  }

  /**
   * Get Asian session range
   */
  getAsianSessionRange(candles: { time: string | Date; high: number; low: number }[]): {
    high: number;
    low: number;
    midpoint: number;
  } | null {
    // Filter candles from Asian session (00:00 - 08:00 UTC)
    const asianCandles = candles.filter(c => {
      const time = new Date(c.time);
      const hour = time.getUTCHours();
      return hour >= 0 && hour < 8;
    });
    
    if (asianCandles.length === 0) return null;
    
    const high = Math.max(...asianCandles.map(c => c.high));
    const low = Math.min(...asianCandles.map(c => c.low));
    
    return {
      high,
      low,
      midpoint: (high + low) / 2,
    };
  }

  /**
   * Check if it's a high-probability trading day (avoid NFP, FOMC, etc.)
   */
  isHighProbabilityDay(): boolean {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    
    // Avoid trading on weekends (Friday late and Sunday)
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;
    
    // Friday afternoon - lower probability
    if (dayOfWeek === 5 && now.getUTCHours() >= 20) return false;
    
    // Monday early morning - lower probability
    if (dayOfWeek === 1 && now.getUTCHours() < 4) return false;
    
    return true;
  }

  /**
   * Get optimal trading windows for gold (XAU/USD)
   */
  getGoldOptimalWindows(): { name: string; startHour: number; endHour: number; description: string }[] {
    return [
      {
        name: 'London Open',
        startHour: 7,
        endHour: 10,
        description: 'High volatility, good for breakout trades',
      },
      {
        name: 'NY Open',
        startHour: 12,
        endHour: 15,
        description: 'Highest volatility for gold, economic news releases',
      },
      {
        name: 'London/NY Overlap',
        startHour: 12,
        endHour: 16,
        description: 'Maximum liquidity and volatility',
      },
    ];
  }

  /**
   * Calculate time until next kill zone
   */
  getTimeToNextKillZone(): { name: string; minutes: number } | null {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentMinutes = now.getUTCMinutes();
    const totalMinutesNow = currentHour * 60 + currentMinutes;
    
    let nearestZone: { name: string; minutes: number } | null = null;
    let minMinutes = Infinity;
    
    for (const zone of this.killZones) {
      const zoneStartMinutes = zone.startHour * 60;
      let minutesUntil = zoneStartMinutes - totalMinutesNow;
      
      if (minutesUntil < 0) {
        minutesUntil += 24 * 60; // Next day
      }
      
      if (minutesUntil < minMinutes && minutesUntil > 0) {
        minMinutes = minutesUntil;
        nearestZone = { name: zone.name, minutes: minutesUntil };
      }
    }
    
    return nearestZone;
  }
}
