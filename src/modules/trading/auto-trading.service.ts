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
  
  // Track accounts that have traded in current cycle to prevent duplicates
  private accountsTradedThisCycle: Set<string> = new Set();
  // Track last trade time per account to enforce cooldown
  private lastTradeTime: Map<string, number> = new Map();
  private readonly TRADE_COOLDOWN_MS = 60000; // 1 minute cooldown between trades per account

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
   * TOKEN REFRESH CRON: Refresh tokens for ALL accounts every 20 minutes
   * This ensures tokens are always fresh before trading cycles
   * MTAPI tokens expire after ~30 minutes, so we refresh at 20 mins to be safe
   */
  @Cron('0 */20 * * * *') // Every 20 minutes
  async handleTokenRefreshCron() {
    this.logger.log('🔄 Starting token refresh for all accounts...');
    const accounts = await this.getAllActiveAccounts();
    let successCount = 0;
    let failCount = 0;

    for (const account of accounts) {
      try {
        // Force reconnect by clearing cached token first
        await this.mt5ConnectionModel.updateOne(
          { _id: (account as any)._id },
          { token: null }
        );
        
        // Reconnect and get fresh token
        await this.forceReconnectAccount(account);
        successCount++;
        this.logger.log(`✅ Token refreshed for account ${account.user}`);
      } catch (error) {
        failCount++;
        this.logger.error(`❌ Failed to refresh token for ${account.user}: ${error.message}`);
      }
      
      // Small delay between accounts to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    this.logger.log(`🔄 Token refresh completed: ${successCount} success, ${failCount} failed`);
  }

  /**
   * Force reconnect an account and update token in database
   */
  private async forceReconnectAccount(connection: Mt5ConnectionDocument): Promise<string> {
    if (!connection.user || !(connection as any).password || !connection.host) {
      throw new Error(`Incomplete MT5 credentials for account ${connection.user}`);
    }

    // Set credentials without cached token to force reconnection
    await this.mt5Service.setCredentialsWithToken(
      connection.user,
      (connection as any).password,
      connection.host,
      connection.port?.toString() || '443',
      undefined, // No cached token - force reconnect
    );

    // Connect and get new token
    const newToken = await this.mt5Service.connect();

    // Update token in database
    await this.mt5ConnectionModel.updateOne(
      { _id: (connection as any)._id },
      { token: newToken, isConnected: true, lastConnectedAt: new Date() }
    );

    return newToken;
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

      // Check if existing token is still valid
      const tokenAge = connection.lastConnectedAt 
        ? Date.now() - new Date(connection.lastConnectedAt).getTime()
        : Infinity;
      
      const tokenExpired = tokenAge > 25 * 60 * 1000; // Token expires after ~30 min, refresh at 25 min
      const cachedToken = (connection.token && !tokenExpired) ? connection.token : undefined;

      // Set credentials with cached token if available
      await this.mt5Service.setCredentialsWithToken(
        connection.user,
        (connection as any).password,
        connection.host,
        connection.port?.toString() || '443',
        cachedToken as string | undefined,
      );

      if (cachedToken) {
        // Try to validate the cached token
        this.logger.log(`Using cached token for ${connection.user} (age: ${Math.round(tokenAge / 1000)}s)`);
        const isValid = await this.mt5Service.checkConnection();
        if (isValid) {
          this.logger.log(`✅ MT5 connection restored for account ${connection.user}`);
          return;
        }
      }

      // Token expired, invalid, or not available - reconnect
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
   * IMPORTANT: Generate signal ONCE and apply to all accounts for consistency
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
    
    // Clear the cycle tracking at start of new cycle
    this.accountsTradedThisCycle.clear();

    try {
      // Get all active accounts
      const accounts = await this.getAllActiveAccounts();
      
      if (accounts.length === 0) {
        this.logger.warn('No MT5 accounts found in database');
        return;
      }

      this.logger.log(`🔄 Running trading cycle for ${accounts.length} account(s)`);

      const timeframe = this.configService.get('TRADING_TIMEFRAME', 'M15');

      // ========== GENERATE SIGNAL ONCE FOR ALL ACCOUNTS ==========
      // Connect to first account to get market data and generate signal
      const primaryAccount = accounts[0];
      await this.ensureMt5ConnectionForAccount(primaryAccount);
      
      const configuredSymbol = this.configService.get('TRADING_SYMBOL', 'XAUUSD');
      const primarySymbol = await this.mt5Service.getTradingSymbol(configuredSymbol);
      
      this.logger.log(`📈 Generating master signal using account ${primaryAccount.user}, symbol: ${primarySymbol}`);
      
      const masterSignal = await this.tradingService.analyzeAndGenerateSignal(primarySymbol, timeframe);
      
      if (!masterSignal) {
        this.logger.log('No trading signal generated - skipping all accounts');
        await this.tradingService.logEvent(
          TradingEventType.CRON_EXECUTION,
          `Trading cycle completed - No signal generated`,
          { accountCount: accounts.length, duration: Date.now() - startTime },
        );
        return;
      }

      this.logger.log(`📊 MASTER SIGNAL: ${masterSignal.signalType} | Confidence: ${masterSignal.confidence}% | Strength: ${masterSignal.strength}`);

      // ========== EXECUTE SAME SIGNAL ON ALL ACCOUNTS ==========
      const minConfidence = this.scalpingMode ? 20 : 30;
      
      if (masterSignal.signalType === 'HOLD' || masterSignal.confidence < minConfidence) {
        this.logger.log(`⏸️ Signal not actionable: ${masterSignal.signalType} with ${masterSignal.confidence}% confidence`);
        return;
      }

      // Run trading cycle for each account with the SAME signal
      for (const account of accounts) {
        try {
          const accountId = account.user;
          this.logger.log(`\n📊 Processing account: ${accountId}`);
          
          // Check if this account already traded in this cycle
          if (this.accountsTradedThisCycle.has(accountId)) {
            this.logger.log(`⏸️ [${accountId}] Already traded in this cycle, skipping`);
            continue;
          }
          
          // Check cooldown - prevent rapid-fire trades
          const lastTrade = this.lastTradeTime.get(accountId);
          if (lastTrade && (Date.now() - lastTrade) < this.TRADE_COOLDOWN_MS) {
            const remainingCooldown = Math.round((this.TRADE_COOLDOWN_MS - (Date.now() - lastTrade)) / 1000);
            this.logger.log(`⏸️ [${accountId}] Trade cooldown active (${remainingCooldown}s remaining), skipping`);
            continue;
          }
          
          // Connect to this account
          await this.ensureMt5ConnectionForAccount(account);

          // Detect the correct Gold symbol for this broker dynamically
          const symbol = await this.mt5Service.getTradingSymbol(configuredSymbol);
          this.logger.log(`📈 Using trading symbol: ${symbol}`);

          await this.tradingService.logEvent(
            TradingEventType.CRON_EXECUTION,
            `Starting trading cycle for ${symbol} ${timeframe} - Account: ${accountId}`,
            { symbol, timeframe, accountId, timestamp: new Date().toISOString() },
          );

          // Clone the master signal with this account's symbol
          const accountSignal = {
            ...masterSignal.toObject ? masterSignal.toObject() : masterSignal,
            symbol: symbol, // Use this broker's symbol
          };

          // Execute the SAME signal direction on this account
          const trade = await this.tradingService.executeTrade(accountSignal as any);
          
          if (trade) {
            this.logger.log(`✅ [${accountId}] Trade executed: ${trade.direction} ${trade.lotSize} ${trade.symbol} @ ${trade.entryPrice}`);
            // Mark this account as traded in this cycle and set cooldown
            this.accountsTradedThisCycle.add(accountId);
            this.lastTradeTime.set(accountId, Date.now());
          } else {
            this.logger.log(`⏸️ [${accountId}] Trade not executed (conditions not met)`);
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
   * IMPORTANT: Generate signal ONCE and apply to all accounts for consistency
   */
  async runTradingCycleWithResult(): Promise<{ success: boolean; message: string; accounts?: any[]; masterSignal?: any }> {
    if (this.isRunning) {
      return { success: false, message: 'Trading cycle already running' };
    }

    if (!this.isEnabled) {
      return { success: false, message: 'Auto trading is disabled' };
    }

    this.isRunning = true;
    const startTime = Date.now();
    const accountResults: any[] = [];
    
    // Clear the cycle tracking at start of new cycle
    this.accountsTradedThisCycle.clear();

    try {
      // Get all active accounts
      const accounts = await this.getAllActiveAccounts();
      
      if (accounts.length === 0) {
        this.isRunning = false;
        return { success: false, message: 'No MT5 accounts found in database' };
      }

      this.logger.log(`🔄 Running trading cycle for ${accounts.length} account(s)`);

      const timeframe = this.configService.get('TRADING_TIMEFRAME', 'M15');
      const configuredSymbol = this.configService.get('TRADING_SYMBOL', 'XAUUSD');

      // ========== GENERATE SIGNAL ONCE FOR ALL ACCOUNTS ==========
      const primaryAccount = accounts[0];
      await this.ensureMt5ConnectionForAccount(primaryAccount);
      
      const primarySymbol = await this.mt5Service.getTradingSymbol(configuredSymbol);
      this.logger.log(`📈 Generating master signal using account ${primaryAccount.user}, symbol: ${primarySymbol}`);
      
      const masterSignal = await this.tradingService.analyzeAndGenerateSignal(primarySymbol, timeframe);
      
      if (!masterSignal) {
        this.isRunning = false;
        return { 
          success: true, 
          message: 'No trading signal generated - no valid setup found',
          accounts: accountResults,
        };
      }

      this.logger.log(`📊 MASTER SIGNAL: ${masterSignal.signalType} | Confidence: ${masterSignal.confidence}%`);

      const masterSignalData = {
        id: (masterSignal as any)._id?.toString(),
        type: masterSignal.signalType,
        strength: masterSignal.strength,
        confidence: masterSignal.confidence,
        entryPrice: masterSignal.entryPrice,
        stopLoss: masterSignal.stopLoss,
        takeProfit: masterSignal.takeProfit,
      };

      // Check if signal is actionable
      const minConfidenceForTrade = this.scalpingMode ? 20 : 30;
      if (masterSignal.signalType === 'HOLD' || masterSignal.confidence < minConfidenceForTrade) {
        this.isRunning = false;
        return {
          success: true,
          message: `Signal not actionable: ${masterSignal.signalType} (${masterSignal.confidence}% confidence)`,
          masterSignal: masterSignalData,
          accounts: accountResults,
        };
      }

      // ========== EXECUTE SAME SIGNAL ON ALL ACCOUNTS ==========
      for (const account of accounts) {
        const accountId = account.user;
        const accountResult: any = {
          accountId: accountId,
          success: false,
          signal: masterSignalData,
          trade: null,
          error: null,
        };

        try {
          this.logger.log(`\n📊 Processing account: ${accountId}`);
          
          // Check if this account already traded in this cycle
          if (this.accountsTradedThisCycle.has(accountId)) {
            this.logger.log(`⏸️ [${accountId}] Already traded in this cycle, skipping`);
            accountResult.success = true;
            accountResult.message = 'Already traded in this cycle';
            accountResults.push(accountResult);
            continue;
          }
          
          // Check cooldown - prevent rapid-fire trades
          const lastTrade = this.lastTradeTime.get(accountId);
          if (lastTrade && (Date.now() - lastTrade) < this.TRADE_COOLDOWN_MS) {
            const remainingCooldown = Math.round((this.TRADE_COOLDOWN_MS - (Date.now() - lastTrade)) / 1000);
            this.logger.log(`⏸️ [${accountId}] Trade cooldown active (${remainingCooldown}s remaining), skipping`);
            accountResult.success = true;
            accountResult.message = `Trade cooldown active (${remainingCooldown}s remaining)`;
            accountResults.push(accountResult);
            continue;
          }
          
          // Connect to this account
          await this.ensureMt5ConnectionForAccount(account);

          // Detect the correct Gold symbol for this broker
          const symbol = await this.mt5Service.getTradingSymbol(configuredSymbol);
          this.logger.log(`📈 Using trading symbol: ${symbol}`);
          
          await this.tradingService.logEvent(
            TradingEventType.CRON_EXECUTION,
            `Trading cycle for ${symbol} - Account: ${accountId} - Signal: ${masterSignal.signalType}`,
            { symbol, timeframe, accountId, signalType: masterSignal.signalType },
          );

          // Clone the master signal with this account's symbol
          const accountSignal = {
            ...masterSignal.toObject ? masterSignal.toObject() : masterSignal,
            symbol: symbol,
          };

          // Execute the SAME signal direction on this account
          const trade = await this.tradingService.executeTrade(accountSignal as any);
          
          if (trade) {
            this.logger.log(`✅ [${accountId}] Trade executed: ${trade.direction} @ ${trade.entryPrice}`);
            accountResult.trade = {
              id: (trade as any)._id?.toString(),
              direction: trade.direction,
              entryPrice: trade.entryPrice,
              lotSize: trade.lotSize,
            };
            // Mark this account as traded in this cycle and set cooldown
            this.accountsTradedThisCycle.add(accountId);
            this.lastTradeTime.set(accountId, Date.now());
          }

          accountResult.success = true;
          accountResult.message = trade 
            ? `Trade executed: ${trade.direction} @ ${trade.entryPrice}` 
            : `Trade not executed (conditions not met)`;

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
        masterSignal: masterSignalData,
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
   * Manually refresh all tokens - can be called from API
   */
  async refreshAllTokens(): Promise<{
    success: boolean;
    message: string;
    results: { accountId: string; success: boolean; error?: string }[];
  }> {
    this.logger.log('🔄 Manual token refresh triggered for all accounts...');
    const accounts = await this.getAllActiveAccounts();
    const results: { accountId: string; success: boolean; error?: string }[] = [];
    let successCount = 0;
    let failCount = 0;

    for (const account of accounts) {
      try {
        // Force reconnect by clearing cached token first
        await this.mt5ConnectionModel.updateOne(
          { _id: (account as any)._id },
          { token: null }
        );
        
        // Reconnect and get fresh token
        await this.forceReconnectAccount(account);
        successCount++;
        results.push({ accountId: account.user, success: true });
        this.logger.log(`✅ Token refreshed for account ${account.user}`);
      } catch (error) {
        failCount++;
        results.push({ accountId: account.user, success: false, error: error.message });
        this.logger.error(`❌ Failed to refresh token for ${account.user}: ${error.message}`);
      }
      
      // Small delay between accounts to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    return {
      success: failCount === 0,
      message: `Token refresh completed: ${successCount} success, ${failCount} failed`,
      results,
    };
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
