import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TradingService } from './trading.service';
import { Mt5Service } from '../mt5/mt5.service';
import { TradingEventType } from '../../entities/trading-log.entity';
import { Trade } from '../../entities/trade.entity';
import { Mt5Connection } from '../../entities/mt5-connection.entity';

@Injectable()
export class AutoTradingService implements OnModuleInit {
  private readonly logger = new Logger(AutoTradingService.name);
  private isRunning = false;
  private isEnabled: boolean;
  private scalpingMode: boolean;

  constructor(
    private configService: ConfigService,
    private tradingService: TradingService,
    private mt5Service: Mt5Service,
    @InjectRepository(Mt5Connection)
    private mt5ConnectionRepo: Repository<Mt5Connection>,
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
      await this.ensureMt5Connection();
      await this.tradingService.syncTradesWithMt5();
    } catch (error) {
      this.logger.error('Trade sync failed', error);
    }
  }

  /**
   * Ensure MT5 connection is active before trading operations
   * Loads credentials from database, connects, and updates token
   */
  private async ensureMt5Connection(): Promise<void> {
    try {
      // Step 1: Find the most recent active connection from database
      const connection = await this.mt5ConnectionRepo.findOne({
        where: {},
        order: { updatedAt: 'DESC' },
      });

      if (!connection) {
        throw new Error('No MT5 credentials found in database. Please login from the app first.');
      }

      if (!connection.user || !connection.password || !connection.host) {
        throw new Error(`Incomplete MT5 credentials for account ${connection.user}`);
      }

      this.logger.log(`Loading MT5 credentials for account ${connection.user} from database`);

      // Step 2: Set credentials in MT5 service
      await this.mt5Service.setCredentials(
        connection.user,
        connection.password,
        connection.host,
        connection.port?.toString() || '443',
      );

      // Step 3: Check if existing token is still valid
      const tokenAge = connection.lastConnectedAt 
        ? Date.now() - new Date(connection.lastConnectedAt).getTime()
        : Infinity;
      
      const tokenExpired = tokenAge > 25 * 60 * 1000; // Token expires after ~30 min, refresh at 25 min

      if (connection.token && !tokenExpired) {
        // Try to use existing token
        this.logger.log(`Using cached token (age: ${Math.round(tokenAge / 1000)}s)`);
        const isValid = await this.mt5Service.checkConnection();
        if (isValid) {
          this.logger.log('✅ MT5 connection restored from cached token');
          return;
        }
      }

      // Step 4: Token expired or invalid, reconnect
      this.logger.log('Token expired or invalid, reconnecting to MT5...');
      const newToken = await this.mt5Service.connect();

      // Step 5: Update token in database
      connection.token = newToken;
      connection.isConnected = true;
      connection.lastConnectedAt = new Date();
      await this.mt5ConnectionRepo.save(connection);

      this.logger.log(`✅ MT5 reconnected and token updated for account ${connection.user}`);

    } catch (error) {
      this.logger.error(`Failed to ensure MT5 connection: ${error.message}`);
      throw error;
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
      // Step 0: Ensure MT5 connection is ready
      await this.ensureMt5Connection();

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
      // Use lower confidence threshold for scalping mode (20%) vs standard mode (30%)
      const minConfidence = this.scalpingMode ? 20 : 30;
      if (signal.signalType !== 'HOLD' && signal.confidence >= minConfidence) {
        const trade = await this.tradingService.executeTrade(signal);
        
        if (trade) {
          this.logger.log(`✅ Trade executed: ${trade.direction} ${trade.lotSize} ${trade.symbol} @ ${trade.entryPrice}`);
        } else {
          this.logger.log('⏸️ Trade not executed (conditions not met)');
        }
      } else {
        this.logger.log(`⏸️ Signal not actionable: ${signal.signalType} with ${signal.confidence}% confidence (min: ${minConfidence}%)`);
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
  async manualTrigger(): Promise<{ success: boolean; message: string; signal?: any; trade?: any; analysis?: any }> {
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
  async runTradingCycleWithResult(): Promise<{ success: boolean; message: string; signal?: any; trade?: any; analysis?: any }> {
    if (this.isRunning) {
      return { success: false, message: 'Trading cycle already running' };
    }

    if (!this.isEnabled) {
      return { success: false, message: 'Auto trading is disabled' };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      // Step 0: Ensure MT5 connection is ready
      await this.ensureMt5Connection();

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
        return { 
          success: true, 
          message: 'No trading signal generated - no valid setup found', 
          signal: null,
          analysis: {
            symbol,
            timeframe,
            mode: this.scalpingMode ? 'SCALPING' : 'STANDARD',
            result: 'No pattern detected with sufficient confidence',
          },
        };
      }

      // Parse AI analysis for scoring details
      let aiAnalysisData: any = {};
      try {
        aiAnalysisData = signal.aiAnalysis ? JSON.parse(signal.aiAnalysis) : {};
      } catch (e) {
        aiAnalysisData = { raw: signal.aiAnalysis };
      }

      this.logger.log(`📊 Signal: ${signal.signalType} | Confidence: ${signal.confidence}% | Strength: ${signal.strength}`);

      // Step 2: Execute trade if signal is actionable
      // Use lower confidence threshold for scalping mode (20%) vs standard mode (30%)
      const minConfidenceForTrade = this.scalpingMode ? 20 : 30;
      let trade: Trade | null = null;
      if (signal.signalType !== 'HOLD' && signal.confidence >= minConfidenceForTrade) {
        trade = await this.tradingService.executeTrade(signal);
        
        if (trade) {
          this.logger.log(`✅ Trade executed: ${trade.direction} ${trade.lotSize} ${trade.symbol} @ ${trade.entryPrice}`);
        } else {
          this.logger.log('⏸️ Trade not executed (conditions not met)');
        }
      } else {
        this.logger.log(`⏸️ Signal not actionable: ${signal.signalType} with ${signal.confidence}% confidence (min: ${minConfidenceForTrade}%)`);
      }

      const duration = Date.now() - startTime;
      await this.tradingService.logEvent(
        TradingEventType.CRON_EXECUTION,
        `Trading cycle completed in ${duration}ms`,
        { duration, signalId: signal?.id, tradeId: trade?.id },
      );

      return {
        success: true,
        message: trade 
          ? `Trade executed: ${trade.direction} @ ${trade.entryPrice}` 
          : `Signal: ${signal.signalType} (${signal.confidence}% confidence)`,
        signal: {
          id: signal.id,
          type: signal.signalType,
          strength: signal.strength,
          confidence: signal.confidence,
          entryPrice: signal.entryPrice,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
        },
        analysis: {
          mode: this.scalpingMode ? 'SCALPING' : 'STANDARD',
          reasoning: signal.reasoning,
          scoring: {
            confidence: signal.confidence,
            minRequired: minConfidenceForTrade,
            passed: signal.confidence >= minConfidenceForTrade,
          },
          details: aiAnalysisData,
          ictAnalysis: signal.ictAnalysis,
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
