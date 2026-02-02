import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KillZone } from '../types';

@Injectable()
export class KillZoneService {
  private readonly logger = new Logger(KillZoneService.name);
  
  // Broker timezone offset from UTC (e.g., +2 for UTC+2, +8 for Singapore)
  // This can be updated dynamically from MT5 server
  private brokerTimezoneOffset: number;
  private timezoneSource: 'config' | 'mt5' = 'config';

  constructor(private configService: ConfigService) {
    // Default to UTC+2 (common for most forex brokers)
    // Can be configured via environment variable or updated from MT5
    this.brokerTimezoneOffset = parseInt(
      this.configService.get('MT5_BROKER_TIMEZONE_OFFSET', '2'),
      10,
    );
  }

  /**
   * Update timezone from MT5 server (called by trading service)
   */
  setBrokerTimezoneOffset(offset: number, source: 'config' | 'mt5' = 'mt5'): void {
    if (this.brokerTimezoneOffset !== offset) {
      this.logger.log(`Broker timezone updated: UTC${offset >= 0 ? '+' : ''}${offset} (source: ${source})`);
    }
    this.brokerTimezoneOffset = offset;
    this.timezoneSource = source;
  }

  /**
   * Get current timezone offset
   */
  getBrokerTimezoneOffset(): number {
    return this.brokerTimezoneOffset;
  }

  // ICT Kill Zones defined in UTC (universal standard)
  // Will be converted to broker time for comparison
  private readonly killZonesUTC: Array<{
    name: string;
    startHourUTC: number;
    endHourUTC: number;
  }> = [
    {
      name: 'Asian Session',
      startHourUTC: 0,   // 00:00 UTC
      endHourUTC: 8,     // 08:00 UTC
    },
    {
      name: 'London Open Kill Zone',
      startHourUTC: 7,   // 07:00 UTC
      endHourUTC: 10,    // 10:00 UTC
    },
    {
      name: 'New York Open Kill Zone',
      startHourUTC: 12,  // 12:00 UTC
      endHourUTC: 15,    // 15:00 UTC
    },
    {
      name: 'London Close Kill Zone',
      startHourUTC: 15,  // 15:00 UTC
      endHourUTC: 17,    // 17:00 UTC
    },
  ];

  /**
   * Get kill zones converted to broker time
   */
  private getKillZones(): KillZone[] {
    return this.killZonesUTC.map(zone => ({
      name: zone.name,
      active: false,
      bias: 'NEUTRAL' as const,
      startHour: (zone.startHourUTC + this.brokerTimezoneOffset + 24) % 24,
      endHour: (zone.endHourUTC + this.brokerTimezoneOffset + 24) % 24,
    }));
  }

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
    const killZones = this.getKillZones();
    
    for (const zone of killZones) {
      // Handle zones that cross midnight
      if (zone.startHour > zone.endHour) {
        if (currentHour >= zone.startHour || currentHour < zone.endHour) {
          return { ...zone, active: true };
        }
      } else {
        if (currentHour >= zone.startHour && currentHour < zone.endHour) {
          return { ...zone, active: true };
        }
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
    timezoneSource: string;
  } {
    const brokerTime = this.getBrokerTime();
    return {
      brokerOffset: this.brokerTimezoneOffset,
      brokerTime: brokerTime.toISOString(),
      brokerHour: brokerTime.getHours(),
      utcTime: new Date().toISOString(),
      timezoneSource: this.timezoneSource,
    };
  }
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
