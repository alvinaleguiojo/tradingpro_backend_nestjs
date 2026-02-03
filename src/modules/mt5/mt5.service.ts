import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { Mt5Connection } from '../../entities/mt5-connection.entity';
import { TradingLog, TradingEventType } from '../../entities/trading-log.entity';

export interface Mt5Quote {
  symbol: string;
  bid: number;
  ask: number;
  time: string;
  spread: number;
}

export interface Mt5Bar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
}

export interface Mt5Order {
  ticket: string;
  symbol: string;
  type: string;
  volume: number;
  openPrice: number;
  stopLoss: number;
  takeProfit: number;
  profit: number;
  openTime: string;
  comment: string;
}

export interface Mt5AccountSummary {
  balance: number;
  equity: number;
  freeMargin: number;
  margin: number;
  marginLevel: number;
  profit: number;
  leverage: number;
  currency: string;
}

export interface OrderSendResult {
  retcode: number;
  deal: string;
  order: string;
  volume: number;
  price: number;
  comment: string;
  error?: string;
}

@Injectable()
export class Mt5Service implements OnModuleInit {
  private readonly logger = new Logger(Mt5Service.name);
  private axiosClient: AxiosInstance;
  private token: string | null = null;
  private readonly baseUrl: string;
  
  // Dynamic credentials (set from frontend login)
  private dynamicCredentials: {
    user: string;
    password: string;
    host: string;
    port: string;
  } | null = null;

  // Connection timeout reduced for Vercel serverless compatibility
  private readonly CONNECTION_TIMEOUT = 10000; // 10 seconds for connection
  private readonly REQUEST_TIMEOUT = 15000; // 15 seconds for data requests
  private lastTokenValidation: number = 0;
  private readonly TOKEN_VALIDATION_INTERVAL = 60000; // Revalidate token every 60s

  constructor(
    private configService: ConfigService,
    @InjectRepository(Mt5Connection)
    private mt5ConnectionRepo: Repository<Mt5Connection>,
    @InjectRepository(TradingLog)
    private tradingLogRepo: Repository<TradingLog>,
  ) {
    this.baseUrl = this.configService.get('MT5_API_BASE_URL', 'https://mt5.mtapi.io');
    this.axiosClient = axios.create({
      baseURL: this.baseUrl,
      timeout: this.REQUEST_TIMEOUT,
    });
  }

  async onModuleInit() {
    // Load credentials from database on startup (don't block if it fails)
    try {
      await this.loadCredentialsFromDb();
      this.logger.log('MT5 Service initialized');
    } catch (error) {
      this.logger.warn('MT5 Service initialized (could not load credentials from DB)');
    }
  }

  /**
   * Load credentials from database (for serverless persistence)
   */
  private async loadCredentialsFromDb(): Promise<void> {
    try {
      const connection = await this.mt5ConnectionRepo.findOne({
        where: {},
        order: { updatedAt: 'DESC' },
      });
      
      if (connection && connection.user && (connection as any).password && connection.host) {
        this.dynamicCredentials = {
          user: connection.user,
          password: (connection as any).password,
          host: connection.host,
          port: connection.port?.toString() || '443',
        };
        this.logger.log(`Loaded MT5 credentials for account ${connection.user} from database`);
      }
    } catch (error) {
      this.logger.warn('Could not load credentials from database:', error.message);
    }
  }

  /**
   * Save credentials to database (for serverless persistence)
   */
  private async saveCredentialsToDb(user: string, password: string, host: string, port: string): Promise<void> {
    try {
      let connection = await this.mt5ConnectionRepo.findOne({
        where: { user },
      });
      
      if (connection) {
        connection.password = password;
        connection.host = host;
        connection.port = parseInt(port, 10);
        connection.updatedAt = new Date();
      } else {
        connection = this.mt5ConnectionRepo.create({
          accountId: user,
          user,
          password,
          host,
          port: parseInt(port, 10),
        });
      }
      
      await this.mt5ConnectionRepo.save(connection);
      this.logger.log(`Saved MT5 credentials to database for account ${user}`);
    } catch (error) {
      this.logger.warn('Could not save credentials to database:', error.message);
    }
  }

  /**
   * Set credentials from frontend login
   */
  async setCredentials(user: string, password: string, host: string, port: string = '443'): Promise<void> {
    this.dynamicCredentials = { user, password, host, port };
    this.token = null; // Reset token to force reconnection
    
    // Persist to database for serverless
    await this.saveCredentialsToDb(user, password, host, port);
    
    this.logger.log(`MT5 credentials set for account ${user}`);
  }

  /**
   * Get current credentials (dynamic or from .env)
   */
  private getCredentials(): { user: string; password: string; host: string; port: string } {
    if (this.dynamicCredentials) {
      return this.dynamicCredentials;
    }
    return {
      user: this.configService.get('MT5_USER', ''),
      password: this.configService.get('MT5_PASSWORD', ''),
      host: this.configService.get('MT5_HOST', ''),
      port: this.configService.get('MT5_PORT', '443'),
    };
  }

  /**
   * Check if credentials are set
   */
  hasCredentials(): boolean {
    const creds = this.getCredentials();
    return !!(creds.user && creds.password && creds.host);
  }

  private async log(
    eventType: TradingEventType,
    message: string,
    data?: Record<string, any>,
    level: string = 'info',
  ) {
    const log = this.tradingLogRepo.create({
      eventType,
      message,
      data,
      level,
    });
    await this.tradingLogRepo.save(log);
    
    if (level === 'error') {
      this.logger.error(message, data);
    } else {
      this.logger.log(message);
    }
  }

  async connect(): Promise<string> {
    const { user, password, host, port } = this.getCredentials();

    if (!user || !password || !host) {
      throw new Error('MT5 credentials not set. Please login from the mobile app first.');
    }

    try {
      const response = await this.axiosClient.get('/Connect', {
        params: { user, password, host, port },
        timeout: this.CONNECTION_TIMEOUT, // Faster timeout for connection
      });

      if (response.data && !response.data.error) {
        this.token = response.data;
        
        // Save connection info
        let connection = await this.mt5ConnectionRepo.findOne({
          where: { user },
        });

        if (!connection) {
          connection = this.mt5ConnectionRepo.create({
            accountId: user,
            user,
            host,
            port: parseInt(port),
          });
        }

        connection.token = this.token;
        connection.isConnected = true;
        connection.lastConnectedAt = new Date();
        
        // Get account details
        const accountSummary = await this.getAccountSummary();
        if (accountSummary) {
          connection.balance = accountSummary.balance;
          connection.equity = accountSummary.equity;
          connection.freeMargin = accountSummary.freeMargin;
          connection.leverage = String(accountSummary.leverage);
          connection.currency = accountSummary.currency;
        }

        await this.mt5ConnectionRepo.save(connection);
        
        await this.log(
          TradingEventType.CONNECTION_ESTABLISHED,
          `Connected to MT5 account ${user}`,
          { user, host },
        );

        return this.token!;
      } else {
        throw new Error(response.data?.error || 'Connection failed');
      }
    } catch (error) {
      await this.log(
        TradingEventType.ERROR,
        `Failed to connect to MT5: ${error.message}`,
        { error: error.message },
        'error',
      );
      throw error;
    }
  }

  /**
   * Force reconnect - clears existing token and reconnects
   * Use this when the token has expired
   */
  async forceReconnect(): Promise<string> {
    this.logger.log('Force reconnecting to MT5...');
    
    // Try to load credentials from database first (for serverless)
    await this.loadCredentialsFromDb();
    
    // Clear existing token
    this.token = null;
    
    // Reconnect
    return this.connect();
  }

  async disconnect(): Promise<void> {
    if (!this.token) return;

    try {
      await this.axiosClient.get('/Disconnect', {
        params: { id: this.token },
      });
      this.token = null;
      this.logger.log('Disconnected from MT5');
    } catch (error) {
      this.logger.error('Failed to disconnect from MT5', error);
    }
  }

  async checkConnection(): Promise<boolean> {
    // If we have a token and it was validated recently, skip validation
    const now = Date.now();
    if (this.token && (now - this.lastTokenValidation) < this.TOKEN_VALIDATION_INTERVAL) {
      return true;
    }

    if (!this.token) {
      // Try to load token from DB first (for serverless cold starts)
      await this.loadTokenFromDb();
    }

    if (!this.token) {
      // No token in DB, need to connect
      await this.loadCredentialsFromDb();
      await this.connect();
      return !!this.token;
    }

    try {
      // Quick validation with short timeout
      const response = await this.axiosClient.get('/ConnectionStatus', {
        params: { id: this.token },
        timeout: 5000, // 5 second timeout for status check
      });
      
      if (response.data?.connected === false) {
        this.token = null;
        await this.connect();
      } else {
        this.lastTokenValidation = now;
      }
      
      return true;
    } catch (error) {
      this.logger.warn('Connection check failed, attempting reconnect');
      this.token = null;
      await this.connect();
      return !!this.token;
    }
  }

  /**
   * Load token from database (for serverless cold starts)
   * Avoids full reconnection if token is still valid
   */
  private async loadTokenFromDb(): Promise<void> {
    try {
      const connection = await this.mt5ConnectionRepo.findOne({
        where: { isConnected: true },
        order: { lastConnectedAt: 'DESC' },
      });
      
      if (connection?.token) {
        // Check if token is less than 30 minutes old
        const tokenAge = Date.now() - connection.lastConnectedAt.getTime();
        if (tokenAge < 30 * 60 * 1000) { // 30 minutes
          this.token = connection.token;
          this.dynamicCredentials = {
            user: connection.user,
            password: connection.password || '',
            host: connection.host,
            port: connection.port?.toString() || '443',
          };
          this.logger.log(`Restored MT5 token from database (age: ${Math.round(tokenAge/1000)}s)`);
        }
      }
    } catch (error) {
      this.logger.warn('Could not load token from database:', error.message);
    }
  }

  async getAccountSummary(): Promise<Mt5AccountSummary | null> {
    await this.checkConnection();
    
    try {
      const response = await this.axiosClient.get('/AccountSummary', {
        params: { id: this.token },
      });
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get account summary', error);
      return null;
    }
  }

  /**
   * Get broker server timezone offset from MT5
   * Returns timezone offset in hours (e.g., 2 for UTC+2)
   */
  async getServerTimezone(): Promise<{ timezone: string; offsetHours: number } | null> {
    await this.checkConnection();
    
    try {
      const response = await this.axiosClient.get('/ServerTimezone', {
        params: { id: this.token },
      });
      
      // Response format: "UTC+2" or similar
      const timezone = response.data?.toString() || 'UTC+2';
      
      // Parse offset from timezone string (e.g., "UTC+2" -> 2, "UTC-5" -> -5)
      const match = timezone.match(/UTC([+-]?\d+)/i);
      const offsetHours = match ? parseInt(match[1], 10) : 2;
      
      this.logger.log(`MT5 Server Timezone: ${timezone} (UTC${offsetHours >= 0 ? '+' : ''}${offsetHours})`);
      
      return { timezone, offsetHours };
    } catch (error) {
      this.logger.error('Failed to get server timezone', error);
      return null;
    }
  }

  /**
   * Get detailed account info including server time
   */
  async getAccountDetails(): Promise<{
    accountNumber: string;
    name: string;
    serverName: string;
    serverTime: string;
    serverTimezone: string;
    company: string;
    currency: string;
  } | null> {
    await this.checkConnection();
    
    try {
      const response = await this.axiosClient.get('/AccountDetails', {
        params: { id: this.token },
      });
      return response.data;
    } catch (error) {
      this.logger.error('Failed to get account details', error);
      return null;
    }
  }

  async getQuote(symbol: string): Promise<Mt5Quote | null> {
    await this.checkConnection();
    
    try {
      const response = await this.axiosClient.get('/GetQuote', {
        params: { id: this.token, symbol },
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to get quote for ${symbol}`, error);
      return null;
    }
  }

  async getPriceHistory(
    symbol: string,
    timeframe: string,
    count: number = 100,
  ): Promise<Mt5Bar[]> {
    await this.checkConnection();
    
    // Debug: log token info
    const tokenPreview = this.token ? `${this.token.substring(0, 8)}...` : 'null';
    this.logger.log(`getPriceHistory called with token: ${tokenPreview} for ${symbol} ${timeframe}`);
    
    try {
      // Map timeframe to MT5 format
      const tfMap: Record<string, number> = {
        M1: 1,
        M5: 5,
        M15: 15,
        M30: 30,
        H1: 60,
        H4: 240,
        D1: 1440,
        W1: 10080,
        MN1: 43200,
      };

      const tf = tfMap[timeframe] || 15;
      let rawBars: any[] = [];

      // Use /PriceHistory with date range - this returns actual live data
      // Calculate date range based on timeframe and count needed
      const now = new Date();
      const daysBack = Math.ceil((count * tf) / (24 * 60)) + 1; // Calculate days needed based on timeframe minutes
      const fromDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
      
      const from = fromDate.toISOString().split('T')[0]; // YYYY-MM-DD
      const to = now.toISOString().split('T')[0];

      this.logger.log(`Requesting /PriceHistory: symbol=${symbol}, tf=${tf}, from=${from}, to=${to}`);
      
      try {
        const response = await this.axiosClient.get('/PriceHistory', {
          params: { 
            id: this.token, 
            symbol, 
            timeframe: tf,
            from,
            to,
          },
        });
        
        // Log response details for debugging
        const responseType = typeof response.data;
        const isArray = Array.isArray(response.data);
        this.logger.log(`PriceHistory response: type=${responseType}, isArray=${isArray}, length=${isArray ? response.data.length : 'N/A'}`);
        
        // Check if API returned an error object
        if (response.data?.error) {
          this.logger.error(`PriceHistory API error: ${response.data.error}`);
          throw new Error(response.data.error);
        }
        
        rawBars = Array.isArray(response.data) ? response.data : [];
        this.logger.log(`PriceHistory (${from} to ${to}) returned ${rawBars.length} candles for ${symbol} ${timeframe}`);
      } catch (e) {
        this.logger.warn(`PriceHistory failed for ${symbol}: ${e.message}, trying PriceHistoryToday`);
        
        // Fallback to PriceHistoryToday
        try {
          const todayResponse = await this.axiosClient.get('/PriceHistoryToday', {
            params: { 
              id: this.token, 
              symbol, 
              timeframe: tf,
            },
          });
          
          // Check if API returned an error object
          if (todayResponse.data?.error) {
            this.logger.error(`PriceHistoryToday API error: ${todayResponse.data.error}`);
            throw new Error(todayResponse.data.error);
          }
          
          rawBars = Array.isArray(todayResponse.data) ? todayResponse.data : [];
          this.logger.log(`PriceHistoryToday returned ${rawBars.length} candles for ${symbol} ${timeframe}`);
        } catch (e2) {
          this.logger.error(`PriceHistoryToday also failed: ${e2.message}`);
        }
      }

      if (rawBars.length === 0) {
        this.logger.warn(`No price history data received for ${symbol} - MT5 may be disconnected`);
        return [];
      }

      // Take the last 'count' candles
      const candlesToUse = rawBars.slice(-count);

      // Map MT5 API response (openPrice, highPrice, etc.) to our interface (open, high, etc.)
      const bars: Mt5Bar[] = candlesToUse.map((bar: any) => ({
        time: bar.time,
        open: bar.openPrice ?? bar.open,
        high: bar.highPrice ?? bar.high,
        low: bar.lowPrice ?? bar.low,
        close: bar.closePrice ?? bar.close,
        tickVolume: bar.tickVolume ?? bar.volume ?? 0,
      }));

      this.logger.log(`Fetched ${bars.length} candles for ${symbol} ${timeframe}, returning last ${count}`);
      return bars.slice(-count);
    } catch (error) {
      this.logger.error(`Failed to get price history for ${symbol}`, error);
      return [];
    }
  }

  async isTradeSession(symbol: string): Promise<boolean> {
    await this.checkConnection();
    
    try {
      const response = await this.axiosClient.get('/IsTradeSession', {
        params: { id: this.token, symbol },
      });
      return response.data === true;
    } catch (error) {
      this.logger.error(`Failed to check trade session for ${symbol}`, error);
      return false;
    }
  }

  async getOpenedOrders(): Promise<Mt5Order[]> {
    await this.checkConnection();
    
    try {
      const response = await this.axiosClient.get('/OpenedOrders', {
        params: { id: this.token },
      });
      return response.data || [];
    } catch (error) {
      this.logger.error('Failed to get opened orders', error);
      return [];
    }
  }

  async getOpenedOrdersForSymbol(symbol: string): Promise<Mt5Order[]> {
    const orders = await this.getOpenedOrders();
    return orders.filter(order => order.symbol === symbol);
  }

  async sendOrder(params: {
    symbol: string;
    type: 'BUY' | 'SELL';
    volume: number;
    price?: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<OrderSendResult> {
    await this.checkConnection();

    // Map order type: 0 = BUY, 1 = SELL
    const orderType = params.type === 'BUY' ? 0 : 1;

    try {
      const response = await this.axiosClient.get('/OrderSend', {
        params: {
          id: this.token,
          symbol: params.symbol,
          type: orderType,
          volume: params.volume,
          price: params.price || 0, // 0 for market order
          sl: params.stopLoss || 0,
          tp: params.takeProfit || 0,
          comment: params.comment || 'AutoTrading',
        },
      });

      const result: OrderSendResult = {
        retcode: response.data.retcode || 0,
        deal: response.data.deal || '',
        order: response.data.order || '',
        volume: response.data.volume || params.volume,
        price: response.data.price || 0,
        comment: response.data.comment || '',
      };

      if (response.data.error) {
        result.error = response.data.error;
      }

      await this.log(
        TradingEventType.TRADE_OPENED,
        `Order sent: ${params.type} ${params.volume} ${params.symbol}`,
        { params, result },
      );

      return result;
    } catch (error) {
      await this.log(
        TradingEventType.ERROR,
        `Failed to send order: ${error.message}`,
        { params, error: error.message },
        'error',
      );
      throw error;
    }
  }

  async modifyOrder(params: {
    ticket: string;
    stopLoss?: number;
    takeProfit?: number;
  }): Promise<boolean> {
    await this.checkConnection();

    try {
      const response = await this.axiosClient.get('/OrderModify', {
        params: {
          id: this.token,
          ticket: params.ticket,
          sl: params.stopLoss,
          tp: params.takeProfit,
        },
      });

      await this.log(
        TradingEventType.TRADE_MODIFIED,
        `Order modified: ${params.ticket}`,
        { params, response: response.data },
      );

      return !response.data.error;
    } catch (error) {
      this.logger.error(`Failed to modify order ${params.ticket}`, error);
      return false;
    }
  }

  async closeOrder(ticket: string, volume?: number): Promise<boolean> {
    await this.checkConnection();

    try {
      const response = await this.axiosClient.get('/OrderClose', {
        params: {
          id: this.token,
          ticket,
          volume: volume || 0, // 0 = close all
        },
      });

      await this.log(
        TradingEventType.TRADE_CLOSED,
        `Order closed: ${ticket}`,
        { ticket, response: response.data },
      );

      return !response.data.error;
    } catch (error) {
      this.logger.error(`Failed to close order ${ticket}`, error);
      return false;
    }
  }

  async getSymbolInfo(symbol: string): Promise<any> {
    await this.checkConnection();

    try {
      const response = await this.axiosClient.get('/SymbolParams', {
        params: { id: this.token, symbol },
      });
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to get symbol info for ${symbol}`, error);
      return null;
    }
  }

  /**
   * Get list of available symbols from MT5
   * @param filter Optional filter string to search for specific symbols (e.g., 'XAU', 'GOLD', 'EUR')
   */
  async getSymbolList(filter?: string): Promise<string[]> {
    await this.checkConnection();

    try {
      const response = await this.axiosClient.get('/SymbolList', {
        params: { id: this.token },
      });
      
      let symbols: string[] = response.data || [];
      
      // Filter symbols if a filter is provided
      if (filter) {
        const filterLower = filter.toLowerCase();
        symbols = symbols.filter((s: string) => 
          s.toLowerCase().includes(filterLower)
        );
      }
      
      return symbols;
    } catch (error) {
      this.logger.error('Failed to get symbol list', error);
      return [];
    }
  }

  /**
   * Get full symbol information for multiple symbols
   * @param filter Optional filter string to search for specific symbols
   */
  async getSymbols(filter?: string): Promise<any[]> {
    await this.checkConnection();

    try {
      const response = await this.axiosClient.get('/Symbols', {
        params: { id: this.token },
      });
      
      let symbols: any[] = response.data || [];
      
      // Filter symbols if a filter is provided
      if (filter) {
        const filterLower = filter.toLowerCase();
        symbols = symbols.filter((s: any) => 
          s.symbol?.toLowerCase().includes(filterLower) ||
          s.description?.toLowerCase().includes(filterLower)
        );
      }
      
      return symbols;
    } catch (error) {
      this.logger.error('Failed to get symbols', error);
      return [];
    }
  }

  /**
   * Get trade history (closed orders/deals) from MT5
   * @param days Number of days of history to fetch (default 30)
   */
  async getTradeHistory(days: number = 30): Promise<any[]> {
    await this.checkConnection();

    try {
      // Calculate date range
      const dateTo = new Date();
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - days);

      const response = await this.axiosClient.get('/OrderHistory', {
        params: {
          id: this.token,
          from: dateFrom.toISOString().split('T')[0],
          to: dateTo.toISOString().split('T')[0],
        },
      });
      
      this.logger.log(`Fetched ${response.data?.length || 0} historical orders`);
      return response.data || [];
    } catch (error) {
      this.logger.error('Failed to get trade history', error);
      return [];
    }
  }

  /**
   * Get deals history (including deposits/withdrawals) from MT5
   * Note: mtapi.io may not have a DealsHistory endpoint, so we use OrderHistory as fallback
   * @param days Number of days of history to fetch (default 30)
   */
  async getDealsHistory(days: number = 30): Promise<any[]> {
    await this.checkConnection();

    try {
      // Calculate date range
      const dateTo = new Date();
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - days);

      // Try HistoryDeals endpoint first (correct mtapi.io naming)
      try {
        const response = await this.axiosClient.get('/HistoryDeals', {
          params: {
            id: this.token,
            from: dateFrom.toISOString().split('T')[0],
            to: dateTo.toISOString().split('T')[0],
          },
        });
        this.logger.log(`Fetched ${response.data?.length || 0} deals from HistoryDeals`);
        return response.data || [];
      } catch (e) {
        // If HistoryDeals doesn't exist, fall back to OrderHistory
        this.logger.warn('HistoryDeals endpoint not available, using OrderHistory as fallback');
        return await this.getTradeHistory(days);
      }
    } catch (error) {
      this.logger.error('Failed to get deals history', error.message || error);
      return [];
    }
  }

  getToken(): string | null {
    return this.token;
  }

  /**
   * Get debug info about current connection state
   * Used for diagnosing connection issues
   */
  async getDebugInfo(): Promise<{
    hasToken: boolean;
    tokenPreview: string | null;
    hasCredentials: boolean;
    credentialsUser: string | null;
    credentialsHost: string | null;
    lastTokenValidation: number;
    envCredentials: {
      user: string | null;
      host: string | null;
    };
    dbConnection: any;
  }> {
    // Get credentials from env
    const envUser = process.env.MT5_USER || null;
    const envHost = process.env.MT5_HOST || null;

    // Get connection from database
    let dbConnection: any = null;
    try {
      const connection = await this.mt5ConnectionRepo.findOne({
        where: {},
        order: { updatedAt: 'DESC' },
      });
      if (connection) {
        // Remove sensitive data
        dbConnection = {
          user: connection.user,
          host: connection.host,
          port: connection.port,
          isConnected: connection.isConnected,
          hasToken: !!connection.token,
          tokenPreview: connection.token ? `${connection.token.substring(0, 8)}...` : null,
          lastConnectedAt: connection.lastConnectedAt,
          updatedAt: connection.updatedAt,
        };
      }
    } catch (e: any) {
      dbConnection = { error: e.message };
    }

    const creds = this.getCredentials();

    return {
      hasToken: !!this.token,
      tokenPreview: this.token ? `${this.token.substring(0, 8)}...` : null,
      hasCredentials: !!(creds.user && creds.password && creds.host),
      credentialsUser: creds.user || null,
      credentialsHost: creds.host || null,
      lastTokenValidation: this.lastTokenValidation,
      envCredentials: {
        user: envUser,
        host: envHost,
      },
      dbConnection,
    };
  }
}
