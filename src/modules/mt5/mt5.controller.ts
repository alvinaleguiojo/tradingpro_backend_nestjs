import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Mt5Service } from './mt5.service';

@ApiTags('mt5')
@Controller('mt5')
export class Mt5Controller {
  constructor(private readonly mt5Service: Mt5Service) {}

  @Get('connect')
  @ApiOperation({ summary: 'Connect to MT5 account' })
  async connect() {
    const token = await this.mt5Service.connect();
    return { success: true, token };
  }

  @Get('disconnect')
  @ApiOperation({ summary: 'Disconnect from MT5 account' })
  async disconnect() {
    await this.mt5Service.disconnect();
    return { success: true, message: 'Disconnected' };
  }

  @Get('account')
  @ApiOperation({ summary: 'Get account summary' })
  async getAccountSummary() {
    const summary = await this.mt5Service.getAccountSummary();
    return { success: true, data: summary };
  }

  @Get('quote')
  @ApiOperation({ summary: 'Get current quote for a symbol' })
  @ApiQuery({ name: 'symbol', required: true, example: 'XAUUSDm' })
  async getQuote(@Query('symbol') symbol: string) {
    const quote = await this.mt5Service.getQuote(symbol);
    return { success: true, data: quote };
  }

  @Get('history')
  @ApiOperation({ summary: 'Get price history for a symbol' })
  @ApiQuery({ name: 'symbol', required: true, example: 'XAUUSDm' })
  @ApiQuery({ name: 'timeframe', required: false, example: 'M15' })
  @ApiQuery({ name: 'count', required: false, example: 100 })
  async getPriceHistory(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: string = 'M15',
    @Query('count') count: number = 100,
  ) {
    const history = await this.mt5Service.getPriceHistory(symbol, timeframe, count);
    return { success: true, data: history, count: history.length };
  }

  @Get('orders')
  @ApiOperation({ summary: 'Get opened orders' })
  async getOpenedOrders() {
    const orders = await this.mt5Service.getOpenedOrders();
    return { success: true, data: orders };
  }

  @Get('orders/symbol')
  @ApiOperation({ summary: 'Get opened orders for a specific symbol' })
  @ApiQuery({ name: 'symbol', required: true, example: 'XAUUSDm' })
  async getOrdersForSymbol(@Query('symbol') symbol: string) {
    const orders = await this.mt5Service.getOpenedOrdersForSymbol(symbol);
    return { success: true, data: orders };
  }

  @Get('trade-session')
  @ApiOperation({ summary: 'Check if market is open for a symbol' })
  @ApiQuery({ name: 'symbol', required: true, example: 'XAUUSDm' })
  async isTradeSession(@Query('symbol') symbol: string) {
    const isOpen = await this.mt5Service.isTradeSession(symbol);
    return { success: true, isOpen };
  }

  @Get('symbol-info')
  @ApiOperation({ summary: 'Get symbol information' })
  @ApiQuery({ name: 'symbol', required: true, example: 'XAUUSDm' })
  async getSymbolInfo(@Query('symbol') symbol: string) {
    const info = await this.mt5Service.getSymbolInfo(symbol);
    return { success: true, data: info };
  }

  @Post('order/send')
  @ApiOperation({ summary: 'Send a market order' })
  async sendOrder(
    @Body()
    body: {
      symbol: string;
      type: 'BUY' | 'SELL';
      volume: number;
      stopLoss?: number;
      takeProfit?: number;
      comment?: string;
    },
  ) {
    const result = await this.mt5Service.sendOrder(body);
    return { success: !result.error, data: result };
  }

  @Post('order/close')
  @ApiOperation({ summary: 'Close an order' })
  async closeOrder(@Body() body: { ticket: string; volume?: number }) {
    const success = await this.mt5Service.closeOrder(body.ticket, body.volume);
    return { success };
  }

  @Post('order/modify')
  @ApiOperation({ summary: 'Modify an order' })
  async modifyOrder(
    @Body() body: { ticket: string; stopLoss?: number; takeProfit?: number },
  ) {
    const success = await this.mt5Service.modifyOrder(body);
    return { success };
  }

  @Post('set-credentials')
  @ApiOperation({ summary: 'Set MT5 credentials from frontend login' })
  async setCredentials(
    @Body()
    body: {
      user: string;
      password: string;
      host: string;
      port?: string;
    },
  ) {
    await this.mt5Service.setCredentials(
      body.user,
      body.password,
      body.host,
      body.port || '443',
    );
    
    // Try to connect with new credentials
    try {
      const token = await this.mt5Service.connect();
      return {
        success: true,
        message: `Connected to MT5 account ${body.user}`,
        connected: true,
      };
    } catch (error: any) {
      return {
        success: false,
        message: error.message || 'Failed to connect',
        connected: false,
      };
    }
  }

  @Get('status')
  @ApiOperation({ summary: 'Get MT5 connection status' })
  async getStatus() {
    const hasCredentials = this.mt5Service.hasCredentials();
    let connected = false;
    let accountSummary: any = null;

    if (hasCredentials) {
      try {
        accountSummary = await this.mt5Service.getAccountSummary();
        connected = !!accountSummary;
      } catch {
        connected = false;
      }
    }

    return {
      success: true,
      data: {
        hasCredentials,
        connected,
        balance: accountSummary?.balance || null,
        equity: accountSummary?.equity || null,
        currency: accountSummary?.currency || null,
      },
    };
  }
}
