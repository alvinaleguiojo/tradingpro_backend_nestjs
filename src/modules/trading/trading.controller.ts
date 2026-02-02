import { Controller, Get, Post, Query, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
import { TradingService } from './trading.service';
import { AutoTradingService } from './auto-trading.service';

@ApiTags('trading')
@Controller('trading')
export class TradingController {
  constructor(
    private readonly tradingService: TradingService,
    private readonly autoTradingService: AutoTradingService,
  ) {}

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
}
