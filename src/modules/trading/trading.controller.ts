import { Controller, Get, Post, Query, Body, Param, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
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
  ) {}

  /**
   * Combined dashboard endpoint - returns all data in a single request
   * This reduces 7+ API calls to 1, significantly improving load times
   */
  @Get('dashboard')
  @ApiOperation({ summary: 'Get all trading dashboard data in a single request' })
  @ApiQuery({ name: 'signalLimit', required: false, example: 10 })
  async getDashboard(@Query('signalLimit') signalLimit: number = 10) {
    const startTime = Date.now();
    
    // Fetch all data in parallel with individual error handling
    const [
      tradingStatus,
      scalpingStatus,
      mt5Status,
      moneyManagementStatus,
      tradeStats,
      recentSignals,
      openTrades,
    ] = await Promise.all([
      // These are fast (in-memory)
      Promise.resolve(this.autoTradingService.getStatus()),
      Promise.resolve({
        enabled: this.tradingService.isScalpingMode(),
        config: this.scalpingStrategy.getConfig(),
      }),
      // MT5 status - may be slow, add timeout
      this.mt5Service.getStatus().catch(err => ({ 
        isConnected: false, 
        error: err.message,
        account: null,
      })),
      // Database queries - may be slow
      this.moneyManagementService.getStatus().catch(err => ({ 
        error: err.message,
        currentLevel: null,
        levels: [],
      })),
      this.tradingService.getTradeStats().catch(err => ({
        error: err.message,
        totalTrades: 0,
        winRate: 0,
        profitFactor: 0,
      })),
      this.tradingService.getRecentSignals(signalLimit).catch(() => []),
      this.tradingService.getOpenTrades().catch(() => []),
    ]);

    const duration = Date.now() - startTime;

    return {
      success: true,
      duration: `${duration}ms`,
      data: {
        tradingStatus,
        scalpingStatus,
        mt5Status,
        moneyManagementStatus,
        tradeStats,
        recentSignals,
        openTrades,
      },
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get auto trading status' })
  getStatus() {
    return {
      success: true,
      data: this.autoTradingService.getStatus(),
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
  async getOpenTrades() {
    const trades = await this.tradingService.getOpenTrades();
    return {
      success: true,
      data: trades,
      count: trades.length,
    };
  }

  @Get('signals')
  @ApiOperation({ summary: 'Get recent trading signals' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  async getRecentSignals(@Query('limit') limit: number = 20) {
    const signals = await this.tradingService.getRecentSignals(limit);
    return {
      success: true,
      data: signals,
      count: signals.length,
    };
  }

  @Get('logs')
  @ApiOperation({ summary: 'Get trading logs' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  async getTradingLogs(@Query('limit') limit: number = 50) {
    const logs = await this.tradingService.getTradingLogs(limit);
    return {
      success: true,
      data: logs,
      count: logs.length,
    };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get trade statistics' })
  async getTradeStats() {
    const stats = await this.tradingService.getTradeStats();
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
