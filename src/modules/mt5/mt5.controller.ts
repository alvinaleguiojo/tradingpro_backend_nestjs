import { Controller, Get, Post, Query, Body, BadRequestException } from '@nestjs/common';
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
  @ApiQuery({ name: 'userId', required: false, description: 'User ID to ensure correct account connection' })
  async getAccountSummary(@Query('userId') userId?: string) {
    // If userId provided, ensure we're connected to the right account
    if (userId) {
      const connected = await this.mt5Service.ensureAccountConnection(userId);
      if (!connected) {
        return { 
          success: false, 
          error: 'CREDENTIALS_NOT_FOUND',
          message: `Account ${userId} not found. Please re-login from the app.`,
          connectedAccount: null 
        };
      }
    }
    const summary = await this.mt5Service.getAccountSummary();
    const currentAccount = this.mt5Service.getCurrentAccountId();
    return { success: true, data: summary, connectedAccount: currentAccount };
  }

  @Get('quote')
  @ApiOperation({ summary: 'Get current quote for a symbol' })
  @ApiQuery({ name: 'symbol', required: true, example: 'XAUUSDm' })
  @ApiQuery({ name: 'userId', required: false, description: 'User ID to ensure correct account connection' })
  async getQuote(@Query('symbol') symbol: string, @Query('userId') userId?: string) {
    if (userId) {
      await this.mt5Service.ensureAccountConnection(userId);
    }
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
  @ApiQuery({ name: 'userId', required: false, description: 'User ID to ensure correct account connection' })
  async getOpenedOrders(@Query('userId') userId?: string) {
    if (userId) {
      const connected = await this.mt5Service.ensureAccountConnection(userId);
      if (!connected) {
        return { 
          success: false, 
          error: 'CREDENTIALS_NOT_FOUND',
          message: `Account ${userId} not found. Please re-login from the app.`,
          connectedAccount: null 
        };
      }
    }
    const orders = await this.mt5Service.getOpenedOrders();
    const currentAccount = this.mt5Service.getCurrentAccountId();
    return { success: true, data: orders, connectedAccount: currentAccount };
  }

  @Get('orders/closed')
  @ApiOperation({ summary: 'Get closed orders history' })
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiQuery({ name: 'userId', required: false, description: 'User ID to ensure correct account connection' })
  async getClosedOrders(@Query('days') days: number = 30, @Query('userId') userId?: string) {
    if (userId) {
      const connected = await this.mt5Service.ensureAccountConnection(userId);
      if (!connected) {
        return { 
          success: false, 
          error: 'CREDENTIALS_NOT_FOUND',
          message: `Account ${userId} not found. Please re-login from the app.`,
          connectedAccount: null 
        };
      }
    }
    const orders = await this.mt5Service.getTradeHistory(days);
    const currentAccount = this.mt5Service.getCurrentAccountId();
    return { success: true, data: orders, count: orders.length, connectedAccount: currentAccount };
  }

  @Get('account/details')
  @ApiOperation({ summary: 'Get detailed account information' })
  @ApiQuery({ name: 'userId', required: false, description: 'User ID to ensure correct account connection' })
  async getAccountDetails(@Query('userId') userId?: string) {
    if (userId) {
      await this.mt5Service.ensureAccountConnection(userId);
    }
    const details = await this.mt5Service.getAccountDetails();
    return { success: true, data: details };
  }

  @Get('brokers/search')
  @ApiOperation({ summary: 'Search for brokers by company name' })
  @ApiQuery({ name: 'company', required: true, example: 'Exness' })
  async searchBrokers(@Query('company') company: string) {
    const results = await this.mt5Service.searchBrokers(company);
    return { success: true, data: results };
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

  @Get('symbols')
  @ApiOperation({ summary: 'Get list of available symbols (use filter to search for XAU, GOLD, EUR, etc.)' })
  @ApiQuery({ name: 'filter', required: false, example: 'XAU', description: 'Filter symbols by name (e.g., XAU, GOLD, EUR)' })
  async getSymbols(@Query('filter') filter?: string) {
    const symbols = await this.mt5Service.getSymbols(filter);
    return { 
      success: true, 
      count: symbols.length,
      filter: filter || 'none',
      data: symbols 
    };
  }

  @Get('symbol-list')
  @ApiOperation({ summary: 'Get simple list of symbol names' })
  @ApiQuery({ name: 'filter', required: false, example: 'XAU', description: 'Filter symbols by name' })
  async getSymbolList(@Query('filter') filter?: string) {
    const symbols = await this.mt5Service.getSymbolList(filter);
    return { 
      success: true, 
      count: symbols.length,
      filter: filter || 'none',
      data: symbols 
    };
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
      userId?: string;
    },
  ) {
    // Ensure we're connected to the correct account
    if (body.userId) {
      await this.mt5Service.ensureAccountConnection(body.userId);
    }
    const result = await this.mt5Service.sendOrder(body);
    return { success: !result.error, data: result };
  }

  @Post('order/close')
  @ApiOperation({ summary: 'Close an order' })
  async closeOrder(@Body() body: { ticket: string; volume?: number; userId?: string }) {
    // Ensure we're connected to the correct account
    if (body.userId) {
      await this.mt5Service.ensureAccountConnection(body.userId);
    }
    const success = await this.mt5Service.closeOrder(body.ticket, body.volume);
    return { success };
  }

  @Post('order/modify')
  @ApiOperation({ summary: 'Modify an order' })
  async modifyOrder(
    @Body() body: { ticket: string; stopLoss?: number; takeProfit?: number; userId?: string },
  ) {
    // Ensure we're connected to the correct account
    if (body.userId) {
      await this.mt5Service.ensureAccountConnection(body.userId);
    }
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
      // Throw HTTP 400 error for failed connection
      throw new BadRequestException({
        success: false,
        message: error.message || 'Failed to connect',
        connected: false,
      });
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

  @Post('refresh')
  @ApiOperation({ summary: 'Force refresh MT5 connection token' })
  async refreshConnection() {
    try {
      // First clear any invalid tokens
      const cleared = await this.mt5Service.clearInvalidTokens();
      if (cleared.cleared > 0) {
        console.log(`Cleared ${cleared.cleared} invalid token(s) from database`);
      }
      
      // Force reconnect by clearing token and reconnecting
      await this.mt5Service.forceReconnect();
      const accountSummary = await this.mt5Service.getAccountSummary();
      
      return {
        success: true,
        message: 'MT5 connection refreshed successfully',
        clearedInvalidTokens: cleared.cleared,
        data: {
          connected: !!accountSummary,
          balance: accountSummary?.balance || null,
          equity: accountSummary?.equity || null,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to refresh connection: ${error.message}`,
        error: error.message,
      };
    }
  }

  @Post('clear-tokens')
  @ApiOperation({ summary: 'Clear any invalid/corrupted tokens from database' })
  async clearInvalidTokens() {
    try {
      const result = await this.mt5Service.clearInvalidTokens();
      return {
        success: true,
        message: `Cleared ${result.cleared} invalid token(s)`,
        cleared: result.cleared,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  @Get('trade-history')
  @ApiOperation({ summary: 'Get closed trade history' })
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiQuery({ name: 'userId', required: false, description: 'User ID to ensure correct account connection' })
  async getTradeHistory(
    @Query('days') days: number = 30,
    @Query('userId') userId?: string,
  ) {
    // Ensure we're connected to the right account
    let connectionResult: boolean | null = null;
    if (userId) {
      connectionResult = await this.mt5Service.ensureAccountConnection(userId);
    }
    const currentAccount = this.mt5Service.getCurrentAccountId();
    const history = await this.mt5Service.getTradeHistory(days);
    return { 
      success: true, 
      data: history, 
      count: history.length,
      debug: {
        requestedUserId: userId,
        connectionResult,
        currentConnectedAccount: currentAccount,
      }
    };
  }

  @Get('deals')
  @ApiOperation({ summary: 'Get deals history (includes deposits/withdrawals)' })
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiQuery({ name: 'userId', required: false, description: 'User ID to ensure correct account connection' })
  async getDealsHistory(
    @Query('days') days: number = 30,
    @Query('userId') userId?: string,
  ) {
    // Ensure we're connected to the right account
    if (userId) {
      await this.mt5Service.ensureAccountConnection(userId);
    }
    const deals = await this.mt5Service.getDealsHistory(days);
    return { success: true, data: deals, count: deals.length };
  }

  @Get('debug')
  @ApiOperation({ summary: 'Debug MT5 connection - shows current state and tests API' })
  async debugConnection() {
    try {
      // Step 1: Get current token/connection info (without reconnecting)
      const connectionInfo = await this.mt5Service.getDebugInfo();
      
      // Step 2: Try to get a quote (quick test)
      let quoteTest: any = null;
      let quoteError: string | null = null;
      try {
        const quote = await this.mt5Service.getQuote('XAUUSDm');
        quoteTest = quote ? { bid: quote.bid, ask: quote.ask, time: quote.time } : null;
      } catch (e: any) {
        quoteError = e.message;
      }

      // Step 3: Try to get price history (main issue we're debugging)
      let historyTest: any = null;
      let historyError: string | null = null;
      try {
        const history = await this.mt5Service.getPriceHistory('XAUUSDm', 'M5', 10);
        historyTest = { 
          count: history.length, 
          firstCandle: history[0] || null,
          lastCandle: history[history.length - 1] || null,
        };
      } catch (e: any) {
        historyError = e.message;
      }

      return {
        success: true,
        timestamp: new Date().toISOString(),
        connection: connectionInfo,
        tests: {
          quote: quoteError ? { error: quoteError } : quoteTest,
          history: historyError ? { error: historyError } : historyTest,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  @Get('all-accounts')
  @ApiOperation({ summary: 'Get list of all MT5 accounts in database' })
  async getAllAccounts() {
    const accounts = await this.mt5Service.getAllAccounts();
    return {
      success: true,
      count: accounts.length,
      accounts,
    };
  }

  @Get('all-trades')
  @ApiOperation({ summary: 'Get open trades across ALL MT5 accounts' })
  async getAllAccountsTrades() {
    try {
      const result = await this.mt5Service.getAllAccountsTrades();
      return {
        success: true,
        timestamp: new Date().toISOString(),
        summary: {
          totalAccounts: result.totalAccounts,
          totalOpenTrades: result.totalOpenTrades,
        },
        accounts: result.accounts.map(acc => ({
          account: acc.account,
          success: acc.success,
          balance: acc.balance,
          equity: acc.equity,
          openTrades: acc.trades.length,
          error: acc.error,
          trades: acc.trades.map((t: any) => ({
            ticket: t.ticket,
            symbol: t.symbol,
            type: t.orderType,
            volume: t.lots,
            openPrice: t.openPrice,
            stopLoss: t.stopLoss,
            takeProfit: t.takeProfit,
            profit: t.profit,
            openTime: t.openTime,
          })),
        })),
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
