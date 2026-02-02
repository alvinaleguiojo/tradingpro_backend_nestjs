import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TradingService } from './trading.service';
import { TradingEventType } from '../../entities/trading-log.entity';

@Injectable()
export class AutoTradingService implements OnModuleInit {
  private readonly logger = new Logger(AutoTradingService.name);
  private isRunning = false;
  private isEnabled: boolean;
  private scalpingMode: boolean;

  constructor(
    private configService: ConfigService,
    private tradingService: TradingService,
  ) {
    // Initialize from environment variable
    this.isEnabled = this.configService.get('AUTO_TRADING_ENABLED', 'true') === 'true';
    this.scalpingMode = this.configService.get('SCALPING_MODE', 'true') === 'true';
  }

  async onModuleInit() {
    const mode = this.scalpingMode ? '⚡ AGGRESSIVE SCALPING (5min cycles)' : '📊 Standard ICT (15min cycles)';
    this.logger.log(`Auto Trading Service initialized. Enabled: ${this.isEnabled}, Mode: ${mode}`);
    
    // Run initial analysis on startup (after a delay to ensure MT5 connection)
    if (this.isEnabled) {
      setTimeout(() => this.runTradingCycle(), 10000);
    }
  }

  /**
   * SCALPING MODE: Runs every 5 minutes for aggressive trading
   */
  @Cron('0 */5 * * * *') // Every 5 minutes
  async handleScalpingCron() {
    if (this.scalpingMode && this.tradingService.isScalpingMode()) {
      await this.runTradingCycle();
    }
  }

  /**
   * STANDARD MODE: Runs every 15 minutes aligned with M15 candle close
   */
  @Cron('0 */15 * * * *') // At minute 0, 15, 30, 45
  async handleTradingCron() {
    if (!this.scalpingMode || !this.tradingService.isScalpingMode()) {
      await this.runTradingCycle();
    }
  }

  /**
   * Sync trades with MT5 every 2 minutes (faster for scalping)
   */
  @Cron('0 */2 * * * *')
  async handleSyncCron() {
    try {
      await this.tradingService.syncTradesWithMt5();
    } catch (error) {
      this.logger.error('Trade sync failed', error);
    }
  }

  /**
   * Run the complete trading cycle
   */
  async runTradingCycle(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Trading cycle already running, skipping...');
      return;
    }

    if (!this.isEnabled) {
      this.logger.log('Auto trading is disabled');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const symbol = this.configService.get('TRADING_SYMBOL', 'XAUUSDm');
      const timeframe = this.configService.get('TRADING_TIMEFRAME', 'M15');

      await this.tradingService.logEvent(
        TradingEventType.CRON_EXECUTION,
        `Starting trading cycle for ${symbol} ${timeframe}`,
        { symbol, timeframe, timestamp: new Date().toISOString() },
      );

      this.logger.log(`🔄 Running trading cycle for ${symbol} on ${timeframe} timeframe`);

      // Step 1: Generate trading signal
      const signal = await this.tradingService.analyzeAndGenerateSignal(symbol, timeframe);

      if (!signal) {
        this.logger.log('No signal generated');
        return;
      }

      this.logger.log(`📊 Signal: ${signal.signalType} | Confidence: ${signal.confidence}% | Strength: ${signal.strength}`);

      // Step 2: Execute trade if signal is actionable
      if (signal.signalType !== 'HOLD' && signal.confidence >= 30) {
        const trade = await this.tradingService.executeTrade(signal);
        
        if (trade) {
          this.logger.log(`✅ Trade executed: ${trade.direction} ${trade.lotSize} ${trade.symbol} @ ${trade.entryPrice}`);
        } else {
          this.logger.log('⏸️ Trade not executed (conditions not met)');
        }
      } else {
        this.logger.log(`⏸️ Signal not actionable: ${signal.signalType} with ${signal.confidence}% confidence`);
      }

      const duration = Date.now() - startTime;
      await this.tradingService.logEvent(
        TradingEventType.CRON_EXECUTION,
        `Trading cycle completed in ${duration}ms`,
        { duration, signalId: signal?.id },
      );

    } catch (error) {
      this.logger.error('Trading cycle failed', error);
      await this.tradingService.logEvent(
        TradingEventType.ERROR,
        `Trading cycle error: ${error.message}`,
        { error: error.message, stack: error.stack },
        'error',
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Manually trigger trading cycle
   * IMPORTANT: Must await the cycle for serverless environments (Vercel)
   */
  async manualTrigger(): Promise<{ success: boolean; message: string; signal?: any; trade?: any }> {
    if (this.isRunning) {
      return { success: false, message: 'Trading cycle already running' };
    }

    // Must await for serverless - otherwise function terminates before completion
    const result = await this.runTradingCycleWithResult();
    return result;
  }

  /**
   * Run trading cycle and return the result (for serverless environments)
   */
  async runTradingCycleWithResult(): Promise<{ success: boolean; message: string; signal?: any; trade?: any }> {
    if (this.isRunning) {
      return { success: false, message: 'Trading cycle already running' };
    }

    if (!this.isEnabled) {
      return { success: false, message: 'Auto trading is disabled' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const symbol = this.configService.get('TRADING_SYMBOL', 'XAUUSDm');
      const timeframe = this.configService.get('TRADING_TIMEFRAME', 'M15');

      await this.tradingService.logEvent(
        TradingEventType.CRON_EXECUTION,
        `Starting trading cycle for ${symbol} ${timeframe}`,
        { symbol, timeframe, timestamp: new Date().toISOString() },
      );

      this.logger.log(`🔄 Running trading cycle for ${symbol} on ${timeframe} timeframe`);

      // Step 1: Generate trading signal
      const signal = await this.tradingService.analyzeAndGenerateSignal(symbol, timeframe);

      if (!signal) {
        this.logger.log('No signal generated');
        return { success: true, message: 'No trading signal generated', signal: null };
      }

      this.logger.log(`📊 Signal: ${signal.signalType} | Confidence: ${signal.confidence}% | Strength: ${signal.strength}`);

      // Step 2: Execute trade if signal is actionable
      let trade = null;
      if (signal.signalType !== 'HOLD' && signal.confidence >= 30) {
        trade = await this.tradingService.executeTrade(signal);
        
        if (trade) {
          this.logger.log(`✅ Trade executed: ${trade.direction} ${trade.lotSize} ${trade.symbol} @ ${trade.entryPrice}`);
        } else {
          this.logger.log('⏸️ Trade not executed (conditions not met)');
        }
      } else {
        this.logger.log(`⏸️ Signal not actionable: ${signal.signalType} with ${signal.confidence}% confidence`);
      }

      const duration = Date.now() - startTime;
      await this.tradingService.logEvent(
        TradingEventType.CRON_EXECUTION,
        `Trading cycle completed in ${duration}ms`,
        { duration, signalId: signal?.id, tradeId: trade?.id },
      );

      return {
        success: true,
        message: trade ? `Trade executed: ${trade.direction} @ ${trade.entryPrice}` : `Signal: ${signal.signalType} (${signal.confidence}% confidence)`,
        signal: {
          id: signal.id,
          type: signal.signalType,
          confidence: signal.confidence,
          entryPrice: signal.entryPrice,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
        },
        trade: trade ? {
          id: trade.id,
          direction: trade.direction,
          entryPrice: trade.entryPrice,
          lotSize: trade.lotSize,
        } : null,
      };

    } catch (error) {
      this.logger.error('Trading cycle failed', error);
      await this.tradingService.logEvent(
        TradingEventType.ERROR,
        `Trading cycle error: ${error.message}`,
        { error: error.message, stack: error.stack },
        'error',
      );
      return { success: false, message: `Trading cycle failed: ${error.message}` };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Enable auto trading
   */
  enable(): { success: boolean; message: string; enabled: boolean } {
    this.isEnabled = true;
    this.logger.log('Auto trading ENABLED');
    return {
      success: true,
      message: 'Auto trading has been enabled',
      enabled: this.isEnabled,
    };
  }

  /**
   * Disable auto trading
   */
  disable(): { success: boolean; message: string; enabled: boolean } {
    this.isEnabled = false;
    this.logger.log('Auto trading DISABLED');
    return {
      success: true,
      message: 'Auto trading has been disabled',
      enabled: this.isEnabled,
    };
  }

  /**
   * Toggle auto trading
   */
  toggle(): { success: boolean; message: string; enabled: boolean } {
    this.isEnabled = !this.isEnabled;
    this.logger.log(`Auto trading ${this.isEnabled ? 'ENABLED' : 'DISABLED'}`);
    return {
      success: true,
      message: `Auto trading has been ${this.isEnabled ? 'enabled' : 'disabled'}`,
      enabled: this.isEnabled,
    };
  }

  /**
   * Check if auto trading is enabled
   */
  isAutoTradingEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Get current status
   */
  getStatus(): {
    enabled: boolean;
    running: boolean;
    symbol: string;
    timeframe: string;
    nextRun: string;
  } {
    const now = new Date();
    const minutes = now.getMinutes();
    const nextQuarter = Math.ceil((minutes + 1) / 15) * 15;
    const nextRun = new Date(now);
    nextRun.setMinutes(nextQuarter % 60);
    nextRun.setSeconds(0);
    if (nextQuarter >= 60) {
      nextRun.setHours(nextRun.getHours() + 1);
    }

    return {
      enabled: this.isEnabled,
      running: this.isRunning,
      symbol: this.configService.get('TRADING_SYMBOL', 'XAUUSDm'),
      timeframe: this.configService.get('TRADING_TIMEFRAME', 'M15'),
      nextRun: nextRun.toISOString(),
    };
  }
}
