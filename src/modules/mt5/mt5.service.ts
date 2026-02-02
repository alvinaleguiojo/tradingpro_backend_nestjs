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
      timeout: 30000,
    });
  }

  async onModuleInit() {
    // Don't auto-connect on startup - wait for frontend to set credentials
    this.logger.log('MT5 Service initialized - waiting for credentials from frontend login');
  }

  /**
   * Set credentials from frontend login
   */
  setCredentials(user: string, password: string, host: string, port: string = '443'): void {
    this.dynamicCredentials = { user, password, host, port };
    this.token = null; // Reset token to force reconnection
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
    if (!this.token) {
      await this.connect();
      return !!this.token;
    }

    try {
      const response = await this.axiosClient.get('/ConnectionStatus', {
        params: { id: this.token },
      });
      
      if (response.data?.connected === false) {
        await this.connect();
      }
      
      return true;
    } catch (error) {
      this.logger.warn('Connection check failed, attempting reconnect');
      await this.connect();
      return !!this.token;
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

      const response = await this.axiosClient.get('/PriceHistoryMonth', {
        params: { 
          id: this.token, 
          symbol, 
          timeframe: tf,
        },
      });

      // Return last 'count' bars
      const bars = Array.isArray(response.data) ? response.data : [];
      if (bars.length === 0) {
        this.logger.warn(`No price history data received for ${symbol}`);
        return [];
      }
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

  getToken(): string | null {
    return this.token;
  }
}
