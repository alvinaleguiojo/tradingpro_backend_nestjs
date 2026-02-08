import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios, { AxiosInstance } from 'axios';
import { Mt5Connection, Mt5ConnectionDocument } from '../../schemas/mt5-connection.schema';
import { TradingLog, TradingLogDocument, TradingEventType } from '../../schemas/trading-log.schema';
import { EaSession, EaSessionDocument } from '../../schemas/ea-session.schema';
import {
  EaCommand,
  EaCommandDocument,
  EaCommandType,
  EaCommandSource,
  EaCommandStatus,
} from '../../schemas/ea-command.schema';

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
  private currentTokenAccountId: string | null = null; // Track which account the current token belongs to

  // EA Bridge mode — reads from EaSession cache instead of calling mtapi.io
  private readonly eaBridgeEnabled: boolean;
  private readonly eaCommandTtlSeconds: number;

  constructor(
    private configService: ConfigService,
    @InjectModel(Mt5Connection.name)
    private mt5ConnectionModel: Model<Mt5ConnectionDocument>,
    @InjectModel(TradingLog.name)
    private tradingLogModel: Model<TradingLogDocument>,
    @InjectModel(EaSession.name)
    private eaSessionModel: Model<EaSessionDocument>,
    @InjectModel(EaCommand.name)
    private eaCommandModel: Model<EaCommandDocument>,
  ) {
    this.eaBridgeEnabled = this.configService.get('EA_BRIDGE_ENABLED', 'false') === 'true';
    this.eaCommandTtlSeconds = parseInt(this.configService.get('EA_COMMAND_TTL_SECONDS', '60'), 10);
    this.baseUrl = this.configService.get('MT5_API_BASE_URL', 'https://mt5.mtapi.io');
    this.axiosClient = axios.create({
      baseURL: this.baseUrl,
      timeout: this.REQUEST_TIMEOUT,
    });
  }

  /**
   * Check if EA Bridge mode is active
   */
  isEaBridgeMode(): boolean {
    return this.eaBridgeEnabled;
  }

  /**
   * Get the active EA session for the current account
   */
  private async getActiveEaSession(accountId?: string): Promise<EaSessionDocument | null> {
    const id = accountId || this.currentTokenAccountId;
    if (!id) {
      // Fallback: get the most recently synced session
      return this.eaSessionModel.findOne().sort({ lastSyncAt: -1 }).exec();
    }
    return this.eaSessionModel.findOne({ accountId: id }).exec();
  }

  async onModuleInit() {
    if (this.eaBridgeEnabled) {
      this.logger.log('MT5 Service initialized in EA BRIDGE mode (mtapi.io disabled)');
      return;
    }

    // Load credentials from database on startup (don't block if it fails)
    try {
      await this.loadCredentialsFromDb();
      this.logger.log('MT5 Service initialized (legacy mtapi.io mode)');
    } catch (error) {
      this.logger.warn('MT5 Service initialized (could not load credentials from DB)');
    }
  }

  /**
   * Load credentials from database (for serverless persistence)
   */
  private async loadCredentialsFromDb(): Promise<void> {
    try {
      const connection = await this.mt5ConnectionModel.findOne({}).sort({ updatedAt: -1 }).exec();
      
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
      const connection = await this.mt5ConnectionModel.findOne({ user }).exec();
      
      if (connection) {
        await this.mt5ConnectionModel.updateOne(
          { user },
          { password, host, port: parseInt(port, 10), updatedAt: new Date() }
        );
      } else {
        const newConnection = new this.mt5ConnectionModel({
          accountId: user,
          user,
          password,
          host,
          port: parseInt(port, 10),
        });
        await newConnection.save();
      }
      
      this.logger.log(`Saved MT5 credentials to database for account ${user}`);
    } catch (error) {
      this.logger.warn('Could not save credentials to database:', error.message);
    }
  }

  /**
   * Set credentials from frontend login (in-memory only, not persisted until connect succeeds)
   */
  async setCredentials(user: string, password: string, host: string, port: string = '443'): Promise<void> {
    this.dynamicCredentials = { user, password, host, port };
    this.token = null; // Reset token to force reconnection
    this.currentTokenAccountId = user; // Track which account we're now using
    
    // NOTE: Do NOT persist to database here - only save after successful connection
    // This prevents saving invalid credentials that would pollute the database
    
    this.logger.log(`MT5 credentials set in memory for account ${user} (will persist after successful connect)`);
  }

  /**
   * Ensure we're connected to the correct account
   * If currently connected to a different account, switch to the requested one
   * On serverless (Vercel), each request may be a new instance, so we always verify
   */
  async ensureAccountConnection(userId: string): Promise<boolean> {
    // EA Bridge mode: just set the accountId, no mtapi.io connection needed
    if (this.eaBridgeEnabled) {
      this.currentTokenAccountId = userId;
      this.token = 'ea-bridge-mode';
      const session = await this.getActiveEaSession(userId);
      if (session) {
        this.logger.log(`EA Bridge: account ${userId} set (online: ${Date.now() - session.lastSyncAt.getTime() < 30000})`);
        return true;
      }
      this.logger.warn(`EA Bridge: no session found for account ${userId}`);
      return false;
    }

    this.logger.log(`ensureAccountConnection called for user ${userId}, current: ${this.currentTokenAccountId}, hasToken: ${!!this.token}`);

    // If already connected to this account with a valid token, we're good
    if (this.currentTokenAccountId === userId && this.token) {
      this.logger.log(`Already connected to account ${userId}`);
      return true;
    }
    
    this.logger.log(`Switching connection from ${this.currentTokenAccountId || 'none'} to ${userId}`);
    
    // Load credentials for this user from database
    try {
      const connection = await this.mt5ConnectionModel.findOne({ user: userId }).exec();
      
      if (connection && (connection as any).password) {
        // Switch to this account
        this.dynamicCredentials = {
          user: connection.user,
          password: (connection as any).password,
          host: connection.host,
          port: connection.port?.toString() || '443',
        };
        this.token = null; // Force reconnection
        this.currentTokenAccountId = userId;
        
        // Connect with new credentials
        await this.connect();
        this.logger.log(`Successfully switched to account ${userId}`);
        return true;
      } else {
        this.logger.warn(`No credentials found in database for user ${userId}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Failed to switch account to ${userId}:`, error.message);
      return false;
    }
  }

  /**
   * Get current connected account ID
   */
  getCurrentAccountId(): string | null {
    return this.currentTokenAccountId;
  }

  /**
   * Set credentials and optionally a cached token for a specific account
   * Used by auto-trading to switch between accounts efficiently
   */
  async setCredentialsWithToken(
    user: string, 
    password: string, 
    host: string, 
    port: string = '443',
    cachedToken?: string,
  ): Promise<void> {
    // CRITICAL: If switching to a different account, invalidate the cached token validation
    if (this.currentTokenAccountId && this.currentTokenAccountId !== user) {
      this.logger.log(`Switching account from ${this.currentTokenAccountId} to ${user} - invalidating token cache`);
      this.lastTokenValidation = 0; // Force revalidation
      this.token = null; // Clear the old account's token
    }
    
    this.dynamicCredentials = { user, password, host, port };
    this.currentTokenAccountId = user; // Track which account we're now using
    
    // If a cached token is provided and valid, use it
    if (cachedToken && this.isValidToken(cachedToken)) {
      this.token = cachedToken;
      this.logger.log(`MT5 credentials set for account ${user} with cached token`);
    } else {
      this.token = null; // Reset token to force reconnection
      this.logger.log(`MT5 credentials set for account ${user} (no cached token)`);
    }
  }

  /**
   * Get all MT5 accounts stored in database
   */
  async getAllAccounts(): Promise<any[]> {
    try {
      const connections = await this.mt5ConnectionModel.find().sort({ updatedAt: -1 }).exec();
      
      return connections.map(conn => ({
        accountId: conn.accountId,
        user: conn.user,
        host: conn.host,
        port: conn.port,
        isConnected: conn.isConnected,
        hasToken: !!conn.token && this.isValidToken(conn.token),
        balance: conn.balance,
        equity: conn.equity,
        currency: conn.currency,
        lastConnectedAt: conn.lastConnectedAt,
        updatedAt: (conn as any).updatedAt,
      }));
    } catch (error) {
      this.logger.error('Error getting all accounts:', error.message);
      return [];
    }
  }

  /**
   * Get open trades for a specific account by connecting temporarily
   */
  async getTradesForAccount(user: string, password: string, host: string, port: string = '443'): Promise<{
    success: boolean;
    account: string;
    trades: any[];
    balance?: number;
    equity?: number;
    error?: string;
  }> {
    try {
      // Connect to this specific account
      const response = await this.axiosClient.get('/Connect', {
        params: { user, password, host, port },
        timeout: this.CONNECTION_TIMEOUT,
      });

      if (!response.data || !this.isValidToken(response.data)) {
        return {
          success: false,
          account: user,
          trades: [],
          error: 'Failed to connect - invalid token received',
        };
      }

      const token = response.data;

      // Get account summary
      let balance = 0;
      let equity = 0;
      try {
        const summaryResponse = await this.axiosClient.get('/AccountSummary', {
          params: { id: token },
          timeout: this.REQUEST_TIMEOUT,
        });
        balance = summaryResponse.data?.balance || 0;
        equity = summaryResponse.data?.equity || 0;
      } catch (e) {
        // Continue even if summary fails
      }

      // Get open orders
      const ordersResponse = await this.axiosClient.get('/OpenedOrders', {
        params: { id: token },
        timeout: this.REQUEST_TIMEOUT,
      });

      const trades = Array.isArray(ordersResponse.data) ? ordersResponse.data : [];

      // Disconnect
      try {
        await this.axiosClient.get('/Disconnect', { params: { id: token } });
      } catch (e) {
        // Ignore disconnect errors
      }

      return {
        success: true,
        account: user,
        trades,
        balance,
        equity,
      };
    } catch (error) {
      return {
        success: false,
        account: user,
        trades: [],
        error: error.message,
      };
    }
  }

  /**
   * Get open trades across ALL accounts in database
   */
  async getAllAccountsTrades(): Promise<{
    totalAccounts: number;
    totalOpenTrades: number;
    accounts: any[];
  }> {
    const connections = await this.mt5ConnectionModel.find().exec();
    const results: any[] = [];
    let totalOpenTrades = 0;

    for (const conn of connections) {
      if (!conn.user || !(conn as any).password || !conn.host) {
        results.push({
          account: conn.user || conn.accountId,
          success: false,
          error: 'Missing credentials',
          trades: [],
        });
        continue;
      }

      const accountResult = await this.getTradesForAccount(
        conn.user,
        (conn as any).password,
        conn.host,
        conn.port?.toString() || '443',
      );

      totalOpenTrades += accountResult.trades.length;
      results.push(accountResult);
    }

    return {
      totalAccounts: connections.length,
      totalOpenTrades,
      accounts: results,
    };
  }

  /**
   * Clear any invalid tokens from database
   * Use this when the stored token is corrupted (e.g., JSON error object instead of UUID)
   */
  async clearInvalidTokens(): Promise<{ cleared: number }> {
    try {
      const connections = await this.mt5ConnectionModel.find().exec();
      let clearedCount = 0;
      
      for (const connection of connections) {
        const token = connection.token as string | null;
        if (token && !this.isValidToken(token)) {
          const tokenPreview = token.substring(0, 30);
          this.logger.warn(`Clearing invalid token for user ${connection.user}: ${tokenPreview}...`);
          await this.mt5ConnectionModel.updateOne(
            { _id: connection._id },
            { token: null, isConnected: false }
          );
          clearedCount++;
        }
      }
      
      // Also clear the in-memory token if invalid
      if (this.token && !this.isValidToken(this.token)) {
        this.token = null;
      }
      
      return { cleared: clearedCount };
    } catch (error) {
      this.logger.error('Error clearing invalid tokens:', error.message);
      throw error;
    }
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

  /**
   * Get the REAL connected account ID by calling the MT5 API
   * This verifies which account the token is actually connected to
   */
  async getVerifiedAccountId(): Promise<string | null> {
    try {
      const details = await this.getAccountDetails();
      if (details && details.accountNumber) {
        return details.accountNumber;
      }
    } catch (error) {
      this.logger.warn(`Failed to verify account ID: ${error.message}`);
    }
    return null;
  }

  private async log(
    eventType: TradingEventType,
    message: string,
    data?: Record<string, any>,
    level: string = 'info',
  ) {
    const log = new this.tradingLogModel({
      eventType,
      message,
      data,
      level,
    });
    await log.save();
    
    if (level === 'error') {
      this.logger.error(message, data);
    } else {
      this.logger.log(message);
    }
  }

  /**
   * Validate if a token is a valid UUID format
   * Returns true only if token is a valid UUID string
   */
  private isValidToken(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(token);
  }

  /**
   * Check if MT5 API response is an error (they return errors on HTTP 200)
   * Returns true if the response indicates an error
   */
  private isMt5ErrorResponse(data: any): boolean {
    if (!data) return false;
    // MT5 API returns error objects with 'code' field like INVALID_TOKEN, INVALID_PARAMETER, etc.
    if (data.code && typeof data.code === 'string') {
      return true;
    }
    // Also check for 'error' field
    if (data.error) {
      return true;
    }
    return false;
  }

  /**
   * Handle MT5 API error response - reconnect if token expired
   * Returns true if we should retry the request after reconnection
   */
  private async handleMt5Error(data: any): Promise<boolean> {
    if (data?.code === 'INVALID_TOKEN') {
      this.logger.warn('MT5 token expired, forcing reconnection...');
      this.token = null;
      this.lastTokenValidation = 0;
      try {
        await this.connect();
        return !!this.token; // Return true if we got a new token
      } catch (error) {
        this.logger.error('Failed to reconnect after token expiry:', error.message);
        return false;
      }
    }
    return false;
  }

  async connect(): Promise<string> {
    // EA Bridge mode: no mtapi.io connection needed
    if (this.eaBridgeEnabled) {
      const accountId = this.dynamicCredentials?.user || this.currentTokenAccountId;
      this.logger.log(`EA Bridge mode: connect() is no-op for account ${accountId}`);
      this.token = 'ea-bridge-mode';
      if (accountId) this.currentTokenAccountId = accountId;
      return 'ea-bridge-mode';
    }

    const { user, password, host, port } = this.getCredentials();

    if (!user || !password || !host) {
      throw new Error('MT5 credentials not set. Please login from the mobile app first.');
    }

    try {
      const response = await this.axiosClient.get('/Connect', {
        params: { user, password, host, port },
        timeout: this.CONNECTION_TIMEOUT, // Faster timeout for connection
      });

      // Validate the response is a valid UUID token, not an error object
      if (response.data && this.isValidToken(response.data)) {
        this.token = response.data;
        this.currentTokenAccountId = user; // Track which account this token belongs to
        this.lastTokenValidation = Date.now(); // Mark as validated now
        
        // Save connection info (including password for serverless persistence)
        let connection = await this.mt5ConnectionModel.findOne({ user }).exec();

        if (!connection) {
          connection = new this.mt5ConnectionModel({
            accountId: user,
            user,
            password, // Save password on successful connection
            host,
            port: parseInt(port),
          });
        } else {
          // Update password on existing connection (in case it changed)
          (connection as any).password = password;
          connection.host = host;
          connection.port = parseInt(port);
        }

        connection.token = this.token || '';
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

        await connection.save();
        
        await this.log(
          TradingEventType.CONNECTION_ESTABLISHED,
          `Connected to MT5 account ${user}`,
          { user, host },
        );

        return this.token!;
      } else {
        // Response is not a valid token - extract error message
        const errorMsg = typeof response.data === 'object' 
          ? (response.data?.error || response.data?.message || JSON.stringify(response.data))
          : 'Invalid token format received';
        this.logger.error(`MT5 Connect returned invalid token: ${errorMsg}`);
        throw new Error(`Connection failed: ${errorMsg}`);
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
    // EA Bridge mode: no-op
    if (this.eaBridgeEnabled) {
      this.token = 'ea-bridge-mode';
      return 'ea-bridge-mode';
    }

    this.logger.log('Force reconnecting to MT5...');

    // Try to load credentials from database first (for serverless)
    await this.loadCredentialsFromDb();

    // Clear existing token
    this.token = null;

    // Reconnect
    return this.connect();
  }

  async disconnect(): Promise<void> {
    // EA Bridge mode: no-op
    if (this.eaBridgeEnabled) {
      this.token = null;
      return;
    }

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
    // EA Bridge mode: check if EA session is online
    if (this.eaBridgeEnabled) {
      const session = await this.getActiveEaSession();
      if (!session) return false;
      const age = Date.now() - session.lastSyncAt.getTime();
      return age < 30000; // Online if synced within 30s
    }

    const now = Date.now();
    const currentAccount = this.dynamicCredentials?.user;
    
    // CRITICAL: Ensure token belongs to the current account
    // If we're trying to use a token from a different account, force reconnection
    if (this.token && this.currentTokenAccountId && currentAccount && this.currentTokenAccountId !== currentAccount) {
      this.logger.warn(`Token mismatch: token for ${this.currentTokenAccountId} but need ${currentAccount} - forcing reconnect`);
      this.token = null;
      this.lastTokenValidation = 0;
    }
    
    // If we have a valid token for the current account and it was validated recently, skip validation
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
      
      // Update the account ID after connecting
      if (this.token && currentAccount) {
        this.currentTokenAccountId = currentAccount;
      }
      
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
        
        // Update the account ID after reconnecting
        if (this.token && currentAccount) {
          this.currentTokenAccountId = currentAccount;
        }
      } else {
        this.lastTokenValidation = now;
      }
      
      return true;
    } catch (error) {
      this.logger.warn('Connection check failed, attempting reconnect');
      this.token = null;
      await this.connect();
      
      // Update the account ID after reconnecting
      if (this.token && currentAccount) {
        this.currentTokenAccountId = currentAccount;
      }
      
      return !!this.token;
    }
  }

  /**
   * Load token from database (for serverless cold starts)
   * Avoids full reconnection if token is still valid
   * IMPORTANT: Only loads token for the CURRENTLY SET credentials (dynamicCredentials.user)
   */
  private async loadTokenFromDb(): Promise<void> {
    try {
      // CRITICAL FIX: Only load token for the account we're currently trying to use
      // This prevents loading a different account's token when switching between accounts
      const targetUser = this.dynamicCredentials?.user;
      
      let connection;
      if (targetUser) {
        // Load token for the specific account we're trying to connect to
        connection = await this.mt5ConnectionModel.findOne({ user: targetUser, isConnected: true }).exec();
        if (!connection) {
          this.logger.log(`No cached token found for account ${targetUser}, will need to connect`);
          return;
        }
      } else {
        // Fallback to most recent (only for initial startup with no credentials set)
        connection = await this.mt5ConnectionModel.findOne({ isConnected: true }).sort({ lastConnectedAt: -1 }).exec();
      }
      
      if (connection?.token) {
        const token = connection.token as string;
        // Validate token format - must be UUID, not an error object
        if (!this.isValidToken(token)) {
          const tokenPreview = token.substring(0, 20);
          this.logger.warn(`Invalid token format in database for ${connection.user} (starts with: ${tokenPreview}...), clearing it`);
          // Clear the invalid token from database
          await this.mt5ConnectionModel.updateOne(
            { _id: connection._id },
            { token: null, isConnected: false }
          );
          return;
        }
        
        // Check if token is less than 30 minutes old
        const tokenAge = Date.now() - connection.lastConnectedAt.getTime();
        if (tokenAge < 30 * 60 * 1000) { // 30 minutes
          this.token = connection.token;
          this.currentTokenAccountId = connection.user; // Track which account this token belongs to
          // Only update dynamicCredentials if not already set (avoid overwriting intended account)
          if (!this.dynamicCredentials?.user) {
            this.dynamicCredentials = {
              user: connection.user,
              password: (connection as any).password || '',
              host: connection.host,
              port: connection.port?.toString() || '443',
            };
          }
          this.logger.log(`Restored MT5 token for account ${connection.user} from database (age: ${Math.round(tokenAge/1000)}s)`);
        } else {
          this.logger.log(`Token for account ${connection.user} is too old (${Math.round(tokenAge/1000)}s), will reconnect`);
        }
      }
    } catch (error) {
      this.logger.warn('Could not load token from database:', error.message);
    }
  }

  async getAccountSummary(): Promise<Mt5AccountSummary | null> {
    // EA Bridge mode: read from EaSession cache
    if (this.eaBridgeEnabled) {
      const session = await this.getActiveEaSession();
      if (!session?.accountInfo) return null;
      return {
        balance: session.accountInfo.balance || 0,
        equity: session.accountInfo.equity || 0,
        freeMargin: session.accountInfo.freeMargin || 0,
        margin: session.accountInfo.margin || 0,
        marginLevel: session.accountInfo.equity && session.accountInfo.margin
          ? (session.accountInfo.equity / session.accountInfo.margin) * 100
          : 0,
        profit: (session.openPositions || []).reduce((sum, p) => sum + (p.profit || 0), 0),
        leverage: session.accountInfo.leverage || 0,
        currency: session.accountInfo.currency || 'USD',
      };
    }

    await this.checkConnection();

    try {
      const response = await this.axiosClient.get('/AccountSummary', {
        params: { id: this.token },
      });
      
      // Check if MT5 API returned an error (they return errors on HTTP 200)
      if (this.isMt5ErrorResponse(response.data)) {
        const shouldRetry = await this.handleMt5Error(response.data);
        if (shouldRetry) {
          // Retry with new token
          const retryResponse = await this.axiosClient.get('/AccountSummary', {
            params: { id: this.token },
          });
          if (!this.isMt5ErrorResponse(retryResponse.data)) {
            return retryResponse.data;
          }
        }
        this.logger.error('MT5 API error in getAccountSummary:', response.data);
        return null;
      }
      
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
    // EA Bridge mode: read from EaSession cache
    if (this.eaBridgeEnabled) {
      const session = await this.getActiveEaSession();
      if (!session?.lastQuote) return null;
      return {
        symbol: session.symbol || symbol,
        bid: session.lastQuote.bid,
        ask: session.lastQuote.ask,
        time: session.lastQuote.time,
        spread: Math.round((session.lastQuote.ask - session.lastQuote.bid) * 100) / 100,
      };
    }

    await this.checkConnection();

    try {
      const response = await this.axiosClient.get('/GetQuote', {
        params: { id: this.token, symbol },
      });
      
      // Check if MT5 API returned an error (they return errors on HTTP 200)
      if (this.isMt5ErrorResponse(response.data)) {
        const shouldRetry = await this.handleMt5Error(response.data);
        if (shouldRetry) {
          // Retry with new token
          const retryResponse = await this.axiosClient.get('/GetQuote', {
            params: { id: this.token, symbol },
          });
          if (!this.isMt5ErrorResponse(retryResponse.data)) {
            return retryResponse.data;
          }
        }
        this.logger.error(`MT5 API error in getQuote for ${symbol}:`, response.data);
        return null;
      }
      
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
    // EA Bridge mode: read from EaSession candles cache
    if (this.eaBridgeEnabled) {
      const session = await this.getActiveEaSession();
      if (!session?.candles || session.candles.length === 0) {
        this.logger.warn(`EA Bridge: no candles available for ${symbol}`);
        return [];
      }
      const bars: Mt5Bar[] = session.candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        tickVolume: c.tickVolume || 0,
      }));
      this.logger.log(`EA Bridge: returning ${bars.length} cached candles for ${symbol}`);
      return bars.slice(-count);
    }

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
    // EA Bridge mode: check if EA is online (if EA is running, market is open)
    if (this.eaBridgeEnabled) {
      const session = await this.getActiveEaSession();
      if (!session) return false;
      return Date.now() - session.lastSyncAt.getTime() < 30000;
    }

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
    // EA Bridge mode: read from EaSession positions cache
    if (this.eaBridgeEnabled) {
      const session = await this.getActiveEaSession();
      if (!session?.openPositions) return [];
      return session.openPositions.map((p) => ({
        ticket: p.ticket,
        symbol: p.symbol,
        type: p.type,
        volume: p.volume,
        openPrice: p.openPrice,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        profit: p.profit,
        openTime: p.openTime,
        comment: p.comment || '',
      }));
    }

    await this.checkConnection();

    try {
      const response = await this.axiosClient.get('/OpenedOrders', {
        params: { id: this.token },
      });
      
      // Check if MT5 API returned an error (they return errors on HTTP 200)
      if (this.isMt5ErrorResponse(response.data)) {
        const shouldRetry = await this.handleMt5Error(response.data);
        if (shouldRetry) {
          // Retry with new token
          const retryResponse = await this.axiosClient.get('/OpenedOrders', {
            params: { id: this.token },
          });
          if (!this.isMt5ErrorResponse(retryResponse.data)) {
            return retryResponse.data || [];
          }
        }
        this.logger.error('MT5 API error in getOpenedOrders:', response.data);
        return [];
      }
      
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
    // EA Bridge mode: create EaCommand for EA to execute locally
    if (this.eaBridgeEnabled) {
      const accountId = this.currentTokenAccountId;
      if (!accountId) {
        throw new Error('EA Bridge: no account set. Ensure ensureAccountConnection() was called.');
      }

      const expiresAt = new Date(Date.now() + this.eaCommandTtlSeconds * 1000);
      const command = await this.eaCommandModel.create({
        accountId,
        type: params.type === 'BUY' ? EaCommandType.BUY : EaCommandType.SELL,
        symbol: params.symbol,
        volume: params.volume,
        stopLoss: params.stopLoss || 0,
        takeProfit: params.takeProfit || 0,
        comment: params.comment || 'AutoTrading',
        source: EaCommandSource.AUTO,
        status: EaCommandStatus.PENDING,
        expiresAt,
      });

      this.logger.log(`EA Bridge: ${params.type} command queued → ${(command as any)._id}`);

      await this.log(
        TradingEventType.TRADE_OPENED,
        `EA Bridge: ${params.type} ${params.volume} ${params.symbol} command queued`,
        { params, commandId: (command as any)._id.toString() },
      );

      return {
        retcode: 0,
        deal: '',
        order: (command as any)._id.toString(),
        volume: params.volume,
        price: 0,
        comment: `EA command queued: ${(command as any)._id}`,
      };
    }

    await this.checkConnection();

    // Map order type: 0 = BUY, 1 = SELL
    const orderType = params.type === 'BUY' ? 0 : 1;

    try {
      // Use correct mtapi.io parameter names: stoploss and takeprofit (not sl/tp)
      const response = await this.axiosClient.get('/OrderSend', {
        params: {
          id: this.token,
          symbol: params.symbol,
          operation: params.type === 'BUY' ? 'Buy' : 'Sell',
          volume: params.volume,
          price: params.price || 0, // 0 for market order
          stoploss: params.stopLoss || 0,
          takeprofit: params.takeProfit || 0,
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
    // EA Bridge mode: create MODIFY command for EA
    if (this.eaBridgeEnabled) {
      const accountId = this.currentTokenAccountId;
      if (!accountId) return false;

      const expiresAt = new Date(Date.now() + this.eaCommandTtlSeconds * 1000);
      await this.eaCommandModel.create({
        accountId,
        type: EaCommandType.MODIFY,
        symbol: '',
        ticket: params.ticket,
        stopLoss: params.stopLoss || 0,
        takeProfit: params.takeProfit || 0,
        comment: `MODIFY_${params.ticket}`,
        source: EaCommandSource.AUTO,
        status: EaCommandStatus.PENDING,
        expiresAt,
      });

      this.logger.log(`EA Bridge: MODIFY command queued for ticket #${params.ticket}`);
      return true;
    }

    await this.checkConnection();

    try {
      // Use correct mtapi.io parameter names: stoploss and takeprofit (not sl/tp)
      const response = await this.axiosClient.get('/OrderModify', {
        params: {
          id: this.token,
          ticket: params.ticket,
          stoploss: params.stopLoss,
          takeprofit: params.takeProfit,
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
    // EA Bridge mode: create CLOSE command for EA
    if (this.eaBridgeEnabled) {
      const accountId = this.currentTokenAccountId;
      if (!accountId) return false;

      const expiresAt = new Date(Date.now() + this.eaCommandTtlSeconds * 1000);
      await this.eaCommandModel.create({
        accountId,
        type: EaCommandType.CLOSE,
        symbol: '',
        ticket,
        volume: volume || 0,
        comment: `CLOSE_${ticket}`,
        source: EaCommandSource.AUTO,
        status: EaCommandStatus.PENDING,
        expiresAt,
      });

      this.logger.log(`EA Bridge: CLOSE command queued for ticket #${ticket}`);
      return true;
    }

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
  async getTradeHistory(days: number = 30): Promise<any> {
    await this.checkConnection();

    try {
      // Use /ClosedOrders - the most reliable endpoint for closed trades
      const closedResponse = await this.axiosClient.get('/ClosedOrders', {
        params: { id: this.token },
      });
      
      // Check if MT5 API returned an error (they return errors on HTTP 200)
      if (this.isMt5ErrorResponse(closedResponse.data)) {
        const shouldRetry = await this.handleMt5Error(closedResponse.data);
        if (shouldRetry) {
          // Retry with new token
          const retryResponse = await this.axiosClient.get('/ClosedOrders', {
            params: { id: this.token },
          });
          if (!this.isMt5ErrorResponse(retryResponse.data)) {
            const closedOrders = retryResponse.data || [];
            this.logger.log(`Fetched ${Array.isArray(closedOrders) ? closedOrders.length : 0} closed orders (after retry)`);
            return Array.isArray(closedOrders) ? closedOrders : [];
          }
        }
        this.logger.error('MT5 API error in getTradeHistory:', closedResponse.data);
        return [];
      }
      
      const closedOrders = closedResponse.data || [];
      this.logger.log(`Fetched ${Array.isArray(closedOrders) ? closedOrders.length : 0} closed orders`);
      
      // Return in a consistent format
      return Array.isArray(closedOrders) ? closedOrders : [];
    } catch (error) {
      this.logger.error('Failed to get trade history from ClosedOrders:', error.message);
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
      const connection = await this.mt5ConnectionModel.findOne({}).sort({ updatedAt: -1 }).exec();
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
          updatedAt: (connection as any).updatedAt,
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

  /**
   * Detect the correct Gold/XAU symbol for this broker
   * Different brokers use different symbol names: XAUUSDm, XAUUSD, GOLD, XAU/USD, etc.
   */
  async detectGoldSymbol(): Promise<string | null> {
    try {
      await this.checkConnection();
      
      // Common Gold symbol patterns to search for
      const goldPatterns = ['XAU', 'GOLD'];
      
      for (const pattern of goldPatterns) {
        const symbols = await this.getSymbolList(pattern);
        
        if (symbols.length > 0) {
          // Priority 1: XAUUSDm or XAUUSD (most common for Gold vs USD)
          const xauusdSymbol = symbols.find((s: string) => 
            s.toUpperCase().startsWith('XAUUSD')
          );
          if (xauusdSymbol) {
            this.logger.log(`✅ Detected Gold symbol (XAUUSD*): ${xauusdSymbol}`);
            return xauusdSymbol;
          }
          
          // Priority 2: Any symbol containing both XAU and USD
          const xauWithUsd = symbols.find((s: string) => 
            s.toUpperCase().includes('XAU') && s.toUpperCase().includes('USD')
          );
          if (xauWithUsd) {
            this.logger.log(`✅ Detected Gold symbol (XAU+USD): ${xauWithUsd}`);
            return xauWithUsd;
          }
          
          // Priority 3: GOLD symbol (but exclude stock symbols like GoldmSachs/Goldman)
          const goldSymbol = symbols.find((s: string) => {
            const upper = s.toUpperCase();
            // Must start with GOLD but not be a stock (Goldman Sachs, etc.)
            return upper.startsWith('GOLD') && 
                   !upper.includes('SACHS') && 
                   !upper.includes('MAN') &&
                   !upper.includes('CORP') &&
                   !upper.includes('FIELD') &&
                   !upper.includes('MINING');
          });
          if (goldSymbol) {
            this.logger.log(`✅ Detected Gold symbol (GOLD*): ${goldSymbol}`);
            return goldSymbol;
          }
          
          // Avoid symbols like XAUJPY, XAUEUR - only use USD pairs
          const usdOnlySymbol = symbols.find((s: string) => {
            const upper = s.toUpperCase();
            return upper.includes('USD') && !upper.includes('JPY') && !upper.includes('EUR') && !upper.includes('GBP') && !upper.includes('AUD');
          });
          if (usdOnlySymbol) {
            this.logger.log(`✅ Detected Gold symbol (USD only): ${usdOnlySymbol}`);
            return usdOnlySymbol;
          }
          
          // Last resort: skip non-USD symbols entirely
          this.logger.warn(`⚠️ Found Gold symbols but none are USD-denominated: ${symbols.slice(0, 5).join(', ')}`);
        }
      }
      
      this.logger.warn('⚠️ Could not detect Gold symbol for this broker');
      return null;
    } catch (error) {
      this.logger.error('Failed to detect Gold symbol', error);
      return null;
    }
  }

  /**
   * Get the trading symbol - tries to detect dynamically, falls back to configured value
   */
  async getTradingSymbol(defaultSymbol: string = 'XAUUSD'): Promise<string> {
    // Hardcoded to XAUUSDm for now to avoid symbol detection issues
    return 'XAUUSDm';
  }

  /**
   * Search for brokers by company name
   */
  async searchBrokers(companyName: string): Promise<any[]> {
    try {
      const response = await this.axiosClient.get('/Search', {
        params: { company: companyName },
      });
      return response.data || [];
    } catch (error) {
      this.logger.error(`Failed to search brokers for ${companyName}`, error);
      return [];
    }
  }
}
