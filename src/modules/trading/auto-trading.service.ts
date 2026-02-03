import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TradingService } from './trading.service';
import { Mt5Service } from '../mt5/mt5.service';
import { TradingEventType } from '../../schemas/trading-log.schema';
import { Trade, TradeDocument } from '../../schemas/trade.schema';
import { Mt5Connection, Mt5ConnectionDocument } from '../../schemas/mt5-connection.schema';
import { TradingSignalDocument } from '../../schemas/trading-signal.schema';

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
    @InjectModel(Mt5Connection.name)
    private mt5ConnectionModel: Model<Mt5ConnectionDocument>,
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
   * Sync trades with MT5 every 2 minutes for ALL accounts
   */
  @Cron('0 */2 * * * *')
  async handleSyncCron() {
    try {
      const accounts = await this.getAllActiveAccounts();
      
      for (const account of accounts) {
        try {
          await this.ensureMt5ConnectionForAccount(account);
          await this.tradingService.syncTradesWithMt5();
          this.logger.log(`✅ Synced trades for account ${account.user}`);
        } catch (error) {
          this.logger.error(`Failed to sync account ${account.user}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error('Trade sync failed', error);
    }
  }

  /**
   * Ensure MT5 connection is active for a specific account
   * Loads credentials from database, connects, and updates token
   */
  private async ensureMt5ConnectionForAccount(connection: Mt5ConnectionDocument): Promise<void> {
    try {
      if (!connection.user || !(connection as any).password || !connection.host) {
        throw new Error(`Incomplete MT5 credentials for account ${connection.user}`);
      }

      this.logger.log(`Loading MT5 credentials for account ${connection.user} from database`);

      // Set credentials in MT5 service
      await this.mt5Service.setCredentials(
        connection.user,
        (connection as any).password,
        connection.host,
        connection.port?.toString() || '443',
      );

      // Check if existing token is still valid
      const tokenAge = connection.lastConnectedAt 
        ? Date.now() - new Date(connection.lastConnectedAt).getTime()
        : Infinity;
      
      const tokenExpired = tokenAge > 25 * 60 * 1000; // Token expires after ~30 min, refresh at 25 min

      if (connection.token && !tokenExpired) {
        // Try to use existing token
        this.logger.log(`Using cached token for ${connection.user} (age: ${Math.round(tokenAge / 1000)}s)`);
        const isValid = await this.mt5Service.checkConnection();
        if (isValid) {
          this.logger.log(`✅ MT5 connection restored for account ${connection.user}`);
          return;
        }
      }

      // Token expired or invalid, reconnect
      this.logger.log(`Token expired or invalid for ${connection.user}, reconnecting...`);
      const newToken = await this.mt5Service.connect();

      // Update token in database
      await this.mt5ConnectionModel.updateOne(
        { _id: (connection as any)._id },
        { token: newToken, isConnected: true, lastConnectedAt: new Date() }
      );

      this.logger.log(`✅ MT5 reconnected and token updated for account ${connection.user}`);

    } catch (error) {
      this.logger.error(`Failed to connect account ${connection.user}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Legacy method for backward compatibility - uses most recent account
   */
  private async ensureMt5Connection(): Promise<void> {
    const connection = await this.mt5ConnectionModel.findOne({}).sort({ updatedAt: -1 }).exec();

    if (!connection) {
      throw new Error('No MT5 credentials found in database. Please login from the app first.');
    }

    await this.ensureMt5ConnectionForAccount(connection);
  }

  /**
   * Get all active MT5 accounts from database
   */
  private async getAllActiveAccounts(): Promise<Mt5ConnectionDocument[]> {
    const connections = await this.mt5ConnectionModel.find().sort({ updatedAt: -1 }).exec();
    
    // Filter out connections with incomplete credentials
    return connections.filter(c => c.user && (c as any).password && c.host);
  }

  /**
   * Run the complete trading cycle for ALL accounts
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
      // Get all active accounts
      const accounts = await this.getAllActiveAccounts();
      
      if (accounts.length === 0) {
        this.logger.warn('No MT5 accounts found in database');
        return;
      }

      this.logger.log(`🔄 Running trading cycle for ${accounts.length} account(s)`);

      const timeframe = this.configService.get('TRADING_TIMEFRAME', 'M15');

      // Run trading cycle for each account
      for (const account of accounts) {
        try {
          this.logger.log(`\n📊 Processing account: ${account.user}`);
          
          // Connect to this account
          await this.ensureMt5ConnectionForAccount(account);

          // Detect the correct Gold symbol for this broker dynamically
          const configuredSymbol = this.configService.get('TRADING_SYMBOL', 'XAUUSD');
          const symbol = await this.mt5Service.getTradingSymbol(configuredSymbol);
          this.logger.log(`📈 Using trading symbol: ${symbol}`);

          await this.tradingService.logEvent(
            TradingEventType.CRON_EXECUTION,
            `Starting trading cycle for ${symbol} ${timeframe} - Account: ${account.user}`,
            { symbol, timeframe, accountId: account.user, timestamp: new Date().toISOString() },
          );

          // Generate trading signal
          const signal = await this.tradingService.analyzeAndGenerateSignal(symbol, timeframe);

          if (!signal) {
            this.logger.log(`No signal for account ${account.user}`);
            continue;
          }

          this.logger.log(`📊 [${account.user}] Signal: ${signal.signalType} | Confidence: ${signal.confidence}% | Strength: ${signal.strength}`);

          // Execute trade if signal is actionable
          const minConfidence = this.scalpingMode ? 20 : 30;
          if (signal.signalType !== 'HOLD' && signal.confidence >= minConfidence) {
            const trade = await this.tradingService.executeTrade(signal);
            
            if (trade) {
              this.logger.log(`✅ [${account.user}] Trade executed: ${trade.direction} ${trade.lotSize} ${trade.symbol} @ ${trade.entryPrice}`);
            } else {
              this.logger.log(`⏸️ [${account.user}] Trade not executed (conditions not met)`);
            }
          } else {
            this.logger.log(`⏸️ [${account.user}] Signal not actionable: ${signal.signalType} with ${signal.confidence}% confidence`);
          }

        } catch (accountError) {
          this.logger.error(`Failed to process account ${account.user}: ${accountError.message}`);
          // Continue with next account
        }
      }

      const duration = Date.now() - startTime;
      await this.tradingService.logEvent(
        TradingEventType.CRON_EXECUTION,
        `Trading cycle completed for ${accounts.length} accounts in ${duration}ms`,
        { duration, accountCount: accounts.length },
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
   * Manually trigger trading cycle for ALL accounts
   * IMPORTANT: Must await the cycle for serverless environments (Vercel)
   */
  async manualTrigger(): Promise<{ success: boolean; message: string; accounts?: any[] }> {
    if (this.isRunning) {
      return { success: false, message: 'Trading cycle already running' };
    }

    // Must await for serverless - otherwise function terminates before completion
    const result = await this.runTradingCycleWithResult();
    return result;
  }

  /**
   * Run trading cycle for ALL accounts and return results (for serverless environments)
   */
  async runTradingCycleWithResult(): Promise<{ success: boolean; message: string; accounts?: any[] }> {
    if (this.isRunning) {
      return { success: false, message: 'Trading cycle already running' };
    }

    if (!this.isEnabled) {
      return { success: false, message: 'Auto trading is disabled' };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const accountResults: any[] = [];

    try {
      // Get all active accounts
      const accounts = await this.getAllActiveAccounts();
      
      if (accounts.length === 0) {
        this.isRunning = false;
        return { success: false, message: 'No MT5 accounts found in database' };
      }

      this.logger.log(`🔄 Running trading cycle for ${accounts.length} account(s)`);

      const timeframe = this.configService.get('TRADING_TIMEFRAME', 'M15');

      // Process each account
      for (const account of accounts) {
        const accountResult: any = {
          accountId: account.user,
          success: false,
          signal: null,
          trade: null,
          error: null,
        };

        try {
          this.logger.log(`\n📊 Processing account: ${account.user}`);
          
          // Connect to this account
          await this.ensureMt5ConnectionForAccount(account);

          // Detect the correct Gold symbol for this broker dynamically
          const configuredSymbol = this.configService.get('TRADING_SYMBOL', 'XAUUSD');
          const symbol = await this.mt5Service.getTradingSymbol(configuredSymbol);
          this.logger.log(`📈 Using trading symbol: ${symbol}`);
          await this.tradingService.logEvent(
            TradingEventType.CRON_EXECUTION,
            `Trading cycle for ${symbol} - Account: ${account.user}`,
            { symbol, timeframe, accountId: account.user },
          );

          // Generate trading signal
          const signal = await this.tradingService.analyzeAndGenerateSignal(symbol, timeframe);

          if (!signal) {
            this.logger.log(`No signal for account ${account.user}`);
            accountResult.success = true;
            accountResult.message = 'No trading signal - no valid setup found';
            accountResults.push(accountResult);
            continue;
          }

          this.logger.log(`📊 [${account.user}] Signal: ${signal.signalType} | Confidence: ${signal.confidence}%`);

          accountResult.signal = {
            id: (signal as any)._id?.toString(),
            type: signal.signalType,
            strength: signal.strength,
            confidence: signal.confidence,
            entryPrice: signal.entryPrice,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
          };

          // Execute trade if signal is actionable
          const minConfidenceForTrade = this.scalpingMode ? 20 : 30;
          let trade: TradeDocument | null = null;
          
          if (signal.signalType !== 'HOLD' && signal.confidence >= minConfidenceForTrade) {
            trade = await this.tradingService.executeTrade(signal);
            
            if (trade) {
              this.logger.log(`✅ [${account.user}] Trade executed: ${trade.direction} @ ${trade.entryPrice}`);
              accountResult.trade = {
                id: (trade as any)._id?.toString(),
                direction: trade.direction,
                entryPrice: trade.entryPrice,
                lotSize: trade.lotSize,
              };
            }
          }

          accountResult.success = true;
          accountResult.message = trade 
            ? `Trade executed: ${trade.direction} @ ${trade.entryPrice}` 
            : `Signal: ${signal.signalType} (${signal.confidence}% confidence)`;

        } catch (accountError) {
          this.logger.error(`Failed to process account ${account.user}: ${accountError.message}`);
          accountResult.success = false;
          accountResult.error = accountError.message;
        }

        accountResults.push(accountResult);
      }

      const duration = Date.now() - startTime;
      const tradesExecuted = accountResults.filter(r => r.trade).length;
      
      await this.tradingService.logEvent(
        TradingEventType.CRON_EXECUTION,
        `Trading cycle completed for ${accounts.length} accounts in ${duration}ms. Trades: ${tradesExecuted}`,
        { duration, accountCount: accounts.length, tradesExecuted },
      );

      return {
        success: true,
        message: `Processed ${accounts.length} account(s), executed ${tradesExecuted} trade(s)`,
        accounts: accountResults,
      };

    } catch (error) {
      this.logger.error('Trading cycle failed', error);
      return {
        success: false,
        message: `Trading cycle error: ${error.message}`,
        accounts: accountResults,
      };

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
  async getStatus(): Promise<{
    enabled: boolean;
    running: boolean;
    symbol: string;
    configuredSymbol: string;
    timeframe: string;
    nextRun: string;
  }> {
    const now = new Date();
    const minutes = now.getMinutes();
    const nextQuarter = Math.ceil((minutes + 1) / 15) * 15;
    const nextRun = new Date(now);
    nextRun.setMinutes(nextQuarter % 60);
    nextRun.setSeconds(0);
    if (nextQuarter >= 60) {
      nextRun.setHours(nextRun.getHours() + 1);
    }

    // Get dynamic symbol for display
    const configuredSymbol = this.configService.get('TRADING_SYMBOL', 'XAUUSD');
    let detectedSymbol = configuredSymbol;
    try {
      detectedSymbol = await this.mt5Service.getTradingSymbol(configuredSymbol);
    } catch (e) {
      // Use configured symbol if detection fails
    }

    return {
      enabled: this.isEnabled,
      running: this.isRunning,
      symbol: detectedSymbol,
      configuredSymbol: configuredSymbol,
      timeframe: this.configService.get('TRADING_TIMEFRAME', 'M15'),
      nextRun: nextRun.toISOString(),
    };
  }
}
