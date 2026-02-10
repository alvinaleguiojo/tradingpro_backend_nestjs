import { Controller, Get, Post, Query, Body, Param, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { TradingService } from './trading.service';
import { AutoTradingService } from './auto-trading.service';
import { KillZoneService } from '../ict-strategy/services/kill-zone.service';
import { ScalpingStrategyService } from '../ict-strategy/services/scalping-strategy.service';
import { Mt5Service } from '../mt5/mt5.service';
import { MoneyManagementService } from '../money-management/money-management.service';

@ApiTags('trading')
@Controller('trading')
export class TradingController {
  constructor(
    private readonly tradingService: TradingService,
    private readonly autoTradingService: AutoTradingService,
    private readonly killZoneService: KillZoneService,
    private readonly scalpingStrategy: ScalpingStrategyService,
    private readonly mt5Service: Mt5Service,
    private readonly moneyManagementService: MoneyManagementService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Combined dashboard endpoint - returns all data in a single request
   * This reduces 7+ API calls to 1, significantly improving load times
   */
  @Get('dashboard')
  @ApiOperation({ summary: 'Get all trading dashboard data in a single request' })
  @ApiQuery({ name: 'signalLimit', required: false, example: 10 })
  @ApiQuery({ name: 'accountId', required: false, description: 'MT5 account ID to filter data by' })
  async getDashboard(
    @Query('signalLimit') signalLimit: number = 10,
    @Query('accountId') queryAccountId?: string,
  ) {
    const startTime = Date.now();
    
    // Use provided accountId or fall back to currently connected account
    const accountId = queryAccountId || 
                      this.mt5Service.getCurrentAccountId() || 
                      this.configService.get('MT5_USER', 'default') ||
                      undefined;
    
    // First fetch MT5 status to get account balance
    let mt5Status: any = { isConnected: false };
    try {
      const hasCredentials = this.mt5Service.hasCredentials();
      if (hasCredentials) {
        const accountSummary = await this.mt5Service.getAccountSummary();
        mt5Status = {
          isConnected: !!accountSummary,
          hasCredentials: true,
          balance: accountSummary?.balance || 0,
          equity: accountSummary?.equity || 0,
        };
      } else {
        mt5Status = { isConnected: false, hasCredentials: false };
      }
    } catch (err) {
      mt5Status = { isConnected: false, error: err.message };
    }
    
    // Activation status (admin-activated MT5 account)
    let activationRequired = false;
    if (accountId) {
      try {
        activationRequired = !(await this.mt5Service.isAccountActivated(accountId));
      } catch {
        activationRequired = false;
      }
    }

    // Fetch remaining data in parallel with individual error handling
    const [
      tradingStatus,
      scalpingStatus,
      moneyManagementStatus,
      tradeStats,
      recentSignals,
      openTrades,
    ] = await Promise.all([
      // These are fast (in-memory)
      this.autoTradingService.getStatus(),
      Promise.resolve({
        enabled: this.tradingService.isScalpingMode(),
        config: this.scalpingStrategy.getConfig(),
      }),
      // Money management status - enhanced with MT5 balance
      this.moneyManagementService.getMoneyManagementStatus(accountId || 'default').catch(err => {
        // Return fallback with MT5 balance if available
        const balance = mt5Status.balance || 0;
        return { 
          error: err.message,
          currentLevel: { level: balance >= 100 ? 1 : 0, lotSize: 0.01, minBalance: 0, maxBalance: 100, dailyTarget: 1, name: 'Unknown' },
          accountState: { currentBalance: balance, dailyProfit: 0 },
          dailyTargetProgress: 0,
          recommendedLotSize: 0.01,
          shouldStopTrading: { stop: false, reason: '' },
        };
      }),
      this.tradingService.getTradeStats(accountId).catch(err => ({
        error: err.message,
        totalTrades: 0,
        openTrades: 0,
        closedTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalProfit: 0,
      })),
      this.tradingService.getRecentSignals(signalLimit, accountId).catch(() => []),
      this.tradingService.getOpenTrades(accountId).catch(() => []),
    ]);

    const duration = Date.now() - startTime;

    return {
      success: true,
      duration: `${duration}ms`,
      data: {
        tradingStatus,
        scalpingStatus,
        mt5Status,
        activationRequired,
        activationMessage: activationRequired
          ? 'Account not activated. Please contact admin to activate your account.'
          : '',
        moneyManagementStatus,
        tradeStats,
        recentSignals,
        openTrades,
      },
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get auto trading status' })
  async getStatus() {
    return {
      success: true,
      data: await this.autoTradingService.getStatus(),
    };
  }

  @Post('trigger')
  @ApiOperation({ summary: 'Manually trigger trading cycle' })
  async triggerTradingCycle() {
    const result = await this.autoTradingService.manualTrigger();
    return result;
  }

  @Get('trigger')
  @ApiOperation({ summary: 'Trigger trading cycle (for Vercel Cron)' })
  async triggerTradingCycleGet(@Headers('authorization') authHeader: string) {
    // Vercel Cron sends CRON_SECRET in authorization header
    // You can add validation here if needed
    const result = await this.autoTradingService.manualTrigger();
    return result;
  }

  @Get('analyze')
  @ApiOperation({ summary: 'Analyze market and generate signal (without executing)' })
  @ApiQuery({ name: 'symbol', required: false, example: 'XAUUSDm' })
  @ApiQuery({ name: 'timeframe', required: false, example: 'M15' })
  async analyzeMarket(
    @Query('symbol') symbol: string = 'XAUUSDm',
    @Query('timeframe') timeframe: string = 'M15',
  ) {
    const signal = await this.tradingService.analyzeAndGenerateSignal(symbol, timeframe);
    return {
      success: true,
      data: signal,
    };
  }

  @Get('trades/open')
  @ApiOperation({ summary: 'Get open trades' })
  @ApiQuery({ name: 'accountId', required: false, description: 'MT5 account ID to filter by' })
  async getOpenTrades(@Query('accountId') accountId?: string) {
    const trades = await this.tradingService.getOpenTrades(accountId);
    return {
      success: true,
      data: trades,
      count: trades.length,
    };
  }

  @Get('trades/closed')
  @ApiOperation({ summary: 'Get closed trades (DB-backed, paginated)' })
  @ApiQuery({ name: 'accountId', required: false, description: 'MT5 account ID to filter by' })
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  async getClosedTrades(
    @Query('accountId') accountId?: string,
    @Query('days') days: number = 30,
    @Query('page') page: number = 1,
    @Query('pageSize') pageSize: number = 50,
  ) {
    const result = await this.tradingService.getClosedTrades(accountId, days, page, pageSize);
    return {
      success: true,
      data: result.data,
      count: result.data.length,
      total: result.total,
      totalProfit: result.totalProfit,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  @Get('signals')
  @ApiOperation({ summary: 'Get recent trading signals' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'accountId', required: false, description: 'MT5 account ID to filter by' })
  async getRecentSignals(
    @Query('limit') limit: number = 20,
    @Query('accountId') accountId?: string,
  ) {
    const signals = await this.tradingService.getRecentSignals(limit, accountId);
    return {
      success: true,
      data: signals,
      count: signals.length,
    };
  }

  @Get('logs')
  @ApiOperation({ summary: 'Get trading logs' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'accountId', required: false, description: 'MT5 account ID to filter by' })
  async getTradingLogs(
    @Query('limit') limit: number = 50,
    @Query('accountId') accountId?: string,
  ) {
    const logs = await this.tradingService.getTradingLogs(limit, accountId);
    return {
      success: true,
      data: logs,
      count: logs.length,
    };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get trade statistics' })
  @ApiQuery({ name: 'accountId', required: false, description: 'MT5 account ID to filter by' })
  async getTradeStats(@Query('accountId') accountId?: string) {
    const stats = await this.tradingService.getTradeStats(accountId);
    return {
      success: true,
      data: stats,
    };
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sync trades with MT5' })
  async syncTrades() {
    await this.tradingService.syncTradesWithMt5();
    return {
      success: true,
      message: 'Trades synced with MT5',
    };
  }

  @Post('enable')
  @ApiOperation({ summary: 'Enable auto trading' })
  enableAutoTrading() {
    return this.autoTradingService.enable();
  }

  @Post('disable')
  @ApiOperation({ summary: 'Disable auto trading' })
  disableAutoTrading() {
    return this.autoTradingService.disable();
  }

  @Post('toggle')
  @ApiOperation({ summary: 'Toggle auto trading on/off' })
  toggleAutoTrading() {
    return this.autoTradingService.toggle();
  }

  @Post('refresh-tokens')
  @ApiOperation({ summary: 'Refresh MT5 tokens for all accounts' })
  async refreshAllTokens() {
    try {
      const result = await this.autoTradingService.refreshAllTokens();
      return result;
    } catch (error: any) {
      return {
        success: false,
        message: `Token refresh failed: ${error.message}`,
        error: error.message,
        results: [],
      };
    }
  }

  @Get('refresh-tokens')
  @ApiOperation({ summary: 'Refresh MT5 tokens for all accounts (GET for cron)' })
  async refreshAllTokensGet() {
    try {
      const result = await this.autoTradingService.refreshAllTokens();
      return result;
    } catch (error: any) {
      return {
        success: false,
        message: `Token refresh failed: ${error.message}`,
        error: error.message,
        results: [],
      };
    }
  }

  @Get('timezone')
  @ApiOperation({ summary: 'Get broker timezone info and current kill zone' })
  getTimezoneInfo() {
    const timezoneInfo = this.killZoneService.getTimezoneInfo();
    const currentKillZone = this.killZoneService.getCurrentKillZone();
    
    return {
      success: true,
      data: {
        ...timezoneInfo,
        currentKillZone: currentKillZone?.name || 'Outside Kill Zone',
        isInKillZone: !!currentKillZone,
      },
    };
  }

  // ========== SCALPING MODE ENDPOINTS ==========

  @Get('scalping/status')
  @ApiOperation({ summary: 'Get scalping mode status and configuration' })
  getScalpingStatus() {
    return {
      success: true,
      data: {
        enabled: this.tradingService.isScalpingMode(),
        config: this.scalpingStrategy.getConfig(),
        description: 'Aggressive scalping mode uses M5 timeframe, lower confidence thresholds, and tighter stops',
      },
    };
  }

  @Post('scalping/enable')
  @ApiOperation({ summary: 'Enable aggressive scalping mode' })
  enableScalpingMode() {
    this.tradingService.setScalpingMode(true);
    return {
      success: true,
      message: '⚡ Aggressive scalping mode ENABLED',
      data: {
        enabled: true,
        timeframe: 'M5',
        cycleInterval: '5 minutes',
        config: this.scalpingStrategy.getConfig(),
      },
    };
  }

  @Post('scalping/disable')
  @ApiOperation({ summary: 'Disable scalping mode (use standard ICT strategy)' })
  disableScalpingMode() {
    this.tradingService.setScalpingMode(false);
    return {
      success: true,
      message: '📊 Standard ICT mode ENABLED',
      data: {
        enabled: false,
        timeframe: 'M15',
        cycleInterval: '15 minutes',
      },
    };
  }

  @Post('scalping/config')
  @ApiOperation({ summary: 'Update scalping configuration' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        minConfidence: { type: 'number', description: 'Minimum confidence to trade (default: 20)' },
        stopLossPips: { type: 'number', description: 'Stop loss in pips (default: 50)' },
        takeProfitPips: { type: 'number', description: 'Take profit in pips (default: 80)' },
        minRiskReward: { type: 'number', description: 'Minimum R:R ratio (default: 1.2)' },
      },
    },
  })
  updateScalpingConfig(@Body() config: any) {
    this.scalpingStrategy.setConfig(config);
    return {
      success: true,
      message: 'Scalping configuration updated',
      data: this.scalpingStrategy.getConfig(),
    };
  }
}
