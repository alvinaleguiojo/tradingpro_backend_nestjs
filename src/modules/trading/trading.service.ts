import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Trade, TradeDirection, TradeStatus } from '../../entities/trade.entity';
import { TradingSignal, SignalType, SignalStrength } from '../../entities/trading-signal.entity';
import { TradingLog, TradingEventType } from '../../entities/trading-log.entity';
import { Mt5Service, OrderSendResult } from '../mt5/mt5.service';
import { IctStrategyService } from '../ict-strategy/ict-strategy.service';
import { OpenAiService, AiTradeRecommendation } from '../openai/openai.service';
import { MoneyManagementService } from '../money-management/money-management.service';
import { KillZoneService } from '../ict-strategy/services/kill-zone.service';
import { ScalpingStrategyService } from '../ict-strategy/services/scalping-strategy.service';
import { IctAnalysisResult, TradeSetup, Candle } from '../ict-strategy/types';
import { withRetry } from '../../utils/database.utils';

@Injectable()
export class TradingService implements OnModuleInit {
  private readonly logger = new Logger(TradingService.name);
  private scalpingMode: boolean = true; // Enable aggressive scalping by default

  constructor(
    private configService: ConfigService,
    @InjectRepository(Trade)
    private tradeRepo: Repository<Trade>,
    @InjectRepository(TradingSignal)
    private signalRepo: Repository<TradingSignal>,
    @InjectRepository(TradingLog)
    private logRepo: Repository<TradingLog>,
    private mt5Service: Mt5Service,
    private ictStrategyService: IctStrategyService,
    private openAiService: OpenAiService,
    private moneyManagementService: MoneyManagementService,
    private killZoneService: KillZoneService,
    private scalpingStrategy: ScalpingStrategyService,
  ) {}

  async onModuleInit() {
    // Check if scalping mode is enabled
    this.scalpingMode = this.configService.get('SCALPING_MODE', 'true') === 'true';
    this.logger.log(`Trading mode: ${this.scalpingMode ? '⚡ AGGRESSIVE SCALPING' : '📊 Standard ICT'}`);
    
    // Sync broker timezone from MT5 on startup
    await this.syncBrokerTimezone();
  }

  /**
   * Toggle scalping mode
   */
  setScalpingMode(enabled: boolean): void {
    this.scalpingMode = enabled;
    this.logger.log(`Scalping mode: ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Get scalping mode status
   */
  isScalpingMode(): boolean {
    return this.scalpingMode;
  }

  /**
   * Sync broker timezone from MT5 server
   */
  async syncBrokerTimezone(): Promise<void> {
    try {
      const serverTz = await this.mt5Service.getServerTimezone();
      if (serverTz) {
        this.killZoneService.setBrokerTimezoneOffset(serverTz.offsetHours, 'mt5');
        this.logger.log(`Broker timezone synced from MT5: UTC${serverTz.offsetHours >= 0 ? '+' : ''}${serverTz.offsetHours}`);
      }
    } catch (error) {
      this.logger.warn('Could not sync broker timezone from MT5, using config default');
    }
  }

  /**
   * Log trading event to database
   */
  async logEvent(
    eventType: TradingEventType,
    message: string,
    data?: Record<string, any>,
    level: string = 'info',
    tradeId?: string,
    signalId?: string,
  ) {
    const log = this.logRepo.create({
      eventType,
      message,
      data,
      level,
      tradeId,
      signalId,
    });
    
    await withRetry(
      () => this.logRepo.save(log),
      { operationName: 'Save trading log', maxRetries: 3 }
    );
    
    if (level === 'error') {
      this.logger.error(message, data);
    } else {
      this.logger.log(message);
    }
  }

  /**
   * Analyze market and generate trading signal
   */
  async analyzeAndGenerateSignal(
    symbol: string,
    timeframe: string,
  ): Promise<TradingSignal | null> {
    try {
      // Use M5 for scalping mode, otherwise use provided timeframe
      const analysisTimeframe = this.scalpingMode ? 'M5' : timeframe;
      
      // Get price history from MT5
      const candles = await this.mt5Service.getPriceHistory(symbol, analysisTimeframe, 200);
      
      if (candles.length < 50) {
        await this.logEvent(
          TradingEventType.MARKET_ANALYSIS,
          'Insufficient candles for analysis',
          { symbol, timeframe: analysisTimeframe, candleCount: candles.length },
          'warn',
        );
        return null;
      }

      // Convert MT5 candles to our format
      const formattedCandles: Candle[] = candles.map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.tickVolume,
      }));

      // Get current price and spread
      const quote = await this.mt5Service.getQuote(symbol);
      const currentPrice = quote?.bid || formattedCandles[formattedCandles.length - 1].close;
      const spread = quote ? (quote.ask - quote.bid) * 10 : 0; // Convert to pips

      // ======= SCALPING MODE =======
      if (this.scalpingMode) {
        this.logger.log(`⚡ Running AGGRESSIVE SCALPING analysis for ${symbol} on ${analysisTimeframe}`);
        
        // Skip high-impact news for scalping (too risky)
        if (this.ictStrategyService.isHighImpactNewsTime()) {
          await this.logEvent(
            TradingEventType.MARKET_ANALYSIS,
            'Scalping paused - High-impact news time',
            { symbol, timeframe: analysisTimeframe },
            'info',
          );
          return null;
        }

        // Run scalping strategy analysis
        const scalpSetup = this.scalpingStrategy.analyzeForScalp(
          formattedCandles,
          currentPrice,
          spread,
        );

        if (!scalpSetup) {
          this.logger.log('⏸️ No scalping setup found');
          return null;
        }

        this.logger.log(
          `🎯 SCALP SIGNAL: ${scalpSetup.direction} | Confidence: ${scalpSetup.confidence}% | ` +
          `Entry: ${currentPrice.toFixed(2)} | SL: ${scalpSetup.stopLoss.toFixed(2)} | ` +
          `TP: ${scalpSetup.takeProfit.toFixed(2)} | R:R ${scalpSetup.riskRewardRatio}`
        );

        // Create scalping signal (skip AI for speed)
        const signal = await this.createScalpingSignal(scalpSetup, symbol, analysisTimeframe, currentPrice);

        await this.logEvent(
          TradingEventType.SIGNAL_GENERATED,
          `SCALP signal: ${signal.signalType} with ${signal.confidence}% confidence`,
          { 
            signalId: signal.id,
            mode: 'SCALPING',
            reasons: scalpSetup.reasons,
            confluences: scalpSetup.confluences,
          },
          'info',
          undefined,
          signal.id,
        );

        return signal;
      }

      // ======= STANDARD ICT MODE =======
      // Check for high-impact news times
      if (this.ictStrategyService.isHighImpactNewsTime()) {
        await this.logEvent(
          TradingEventType.MARKET_ANALYSIS,
          'Skipping analysis - High-impact news time',
          { symbol, timeframe },
          'info',
        );
        return null;
      }

      // Perform SMC analysis
      const ictAnalysis = this.ictStrategyService.analyzeMarket(
        formattedCandles,
        symbol,
        timeframe,
      );

      // Get current price
      const quote = await this.mt5Service.getQuote(symbol);
      const currentPrice = quote?.bid || formattedCandles[formattedCandles.length - 1].close;

      // If we have a trade setup, get HTF confirmation
      if (ictAnalysis.tradeSetup) {
        // Get H1 candles for HTF confirmation
        const h1Candles = await this.mt5Service.getPriceHistory(symbol, 'H1', 100);
        const h1Formatted: Candle[] = h1Candles.map(c => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.tickVolume,
        }));

        const htfConfirmation = this.ictStrategyService.getHTFConfirmation(
          h1Formatted,
          ictAnalysis.tradeSetup.direction,
        );

        // Add HTF confluence to confidence
        if (htfConfirmation.confirmed) {
          ictAnalysis.tradeSetup.confidence = Math.min(100, 
            ictAnalysis.tradeSetup.confidence + htfConfirmation.confluenceBonus
          );
          ictAnalysis.tradeSetup.reasons.push(`H1 ${htfConfirmation.htfTrend} trend confirmation`);
          this.logger.log(`✅ HTF Confirmation: ${htfConfirmation.htfTrend} trend (+${htfConfirmation.confluenceBonus}% confidence)`);
        } else {
          // Reduce confidence if trading against HTF trend
          ictAnalysis.tradeSetup.confidence = Math.max(0, ictAnalysis.tradeSetup.confidence - 20);
          this.logger.log(`⚠️ HTF Divergence: ${htfConfirmation.htfTrend} trend (-20% confidence)`);
        }
      }

      // Get AI recommendation
      const aiRecommendation = await this.openAiService.analyzeMarket(
        ictAnalysis,
        formattedCandles.slice(-20),
        currentPrice,
      );

      // Generate summary for logging
      const summary = await this.openAiService.generateTradeSummary(aiRecommendation, ictAnalysis);
      this.logger.log(summary);

      // Create trading signal
      const signal = await this.createSignal(ictAnalysis, aiRecommendation, currentPrice);

      await this.logEvent(
        TradingEventType.SIGNAL_GENERATED,
        `Signal generated: ${signal.signalType} with ${signal.confidence}% confidence`,
        { 
          signalId: signal.id, 
          ictAnalysis: {
            trend: ictAnalysis.marketStructure.trend,
            killZone: ictAnalysis.currentKillZone?.name,
            sessionBias: ictAnalysis.sessionBias,
          },
          aiRecommendation: {
            direction: aiRecommendation.direction,
            confidence: aiRecommendation.confidence,
            shouldTrade: aiRecommendation.shouldTrade,
          },
        },
        'info',
        undefined,
        signal.id,
      );

      return signal;
    } catch (error) {
      await this.logEvent(
        TradingEventType.ERROR,
        `Analysis failed: ${error.message}`,
        { error: error.message, symbol, timeframe },
        'error',
      );
      return null;
    }
  }

  /**
   * Create a trading signal from analysis results
   */
  private async createSignal(
    ictAnalysis: IctAnalysisResult,
    aiRecommendation: AiTradeRecommendation,
    currentPrice: number,
  ): Promise<TradingSignal> {
    // Determine signal type and parameters
    let signalType: SignalType;
    let entryPrice: number;
    let stopLoss: number;
    let takeProfit: number;
    let confidence: number;

    if (aiRecommendation.shouldTrade) {
      // Use AI recommendation
      signalType = aiRecommendation.direction === 'BUY' ? SignalType.BUY : 
                   aiRecommendation.direction === 'SELL' ? SignalType.SELL : SignalType.HOLD;
      entryPrice = aiRecommendation.entryPrice;
      stopLoss = aiRecommendation.stopLoss;
      takeProfit = aiRecommendation.takeProfit;
      confidence = aiRecommendation.confidence;
    } else if (ictAnalysis.tradeSetup) {
      // Fall back to ICT analysis
      signalType = ictAnalysis.tradeSetup.direction === 'BUY' ? SignalType.BUY : SignalType.SELL;
      entryPrice = ictAnalysis.tradeSetup.entryPrice;
      stopLoss = ictAnalysis.tradeSetup.stopLoss;
      takeProfit = ictAnalysis.tradeSetup.takeProfit;
      confidence = ictAnalysis.tradeSetup.confidence;
    } else {
      // No trade setup
      signalType = SignalType.HOLD;
      entryPrice = currentPrice;
      stopLoss = currentPrice;
      takeProfit = currentPrice;
      confidence = 0;
    }

    // Determine signal strength
    let strength: SignalStrength;
    if (confidence >= 80) strength = SignalStrength.VERY_STRONG;
    else if (confidence >= 60) strength = SignalStrength.STRONG;
    else if (confidence >= 40) strength = SignalStrength.MODERATE;
    else strength = SignalStrength.WEAK;

    const signal = this.signalRepo.create({
      symbol: ictAnalysis.symbol,
      timeframe: ictAnalysis.timeframe,
      signalType,
      strength,
      entryPrice,
      stopLoss,
      takeProfit,
      confidence,
      ictAnalysis: {
        marketStructure: ictAnalysis.marketStructure.trend,
        orderBlocks: ictAnalysis.orderBlocks.filter(ob => ob.valid).slice(0, 5),
        fairValueGaps: ictAnalysis.unfilledFVGs.slice(0, 5),
        liquidityLevels: [...ictAnalysis.buyLiquidity.slice(0, 3), ...ictAnalysis.sellLiquidity.slice(0, 3)],
        killZone: ictAnalysis.currentKillZone?.name || 'None',
        sessionBias: ictAnalysis.sessionBias,
      },
      aiAnalysis: JSON.stringify(aiRecommendation),
      reasoning: aiRecommendation.reasoning,
      executed: false,
    });

    return await withRetry(
      () => this.signalRepo.save(signal),
      { operationName: 'Save trading signal', maxRetries: 3 }
    );
  }

  /**
   * Create a trading signal from scalping analysis (faster, no AI)
   */
  private async createScalpingSignal(
    scalpSetup: TradeSetup,
    symbol: string,
    timeframe: string,
    currentPrice: number,
  ): Promise<TradingSignal> {
    const signalType = scalpSetup.direction === 'BUY' ? SignalType.BUY : SignalType.SELL;
    
    // Scalping uses different strength thresholds (lower requirements)
    let strength: SignalStrength;
    if (scalpSetup.confidence >= 70) strength = SignalStrength.VERY_STRONG;
    else if (scalpSetup.confidence >= 50) strength = SignalStrength.STRONG;
    else if (scalpSetup.confidence >= 30) strength = SignalStrength.MODERATE;
    else strength = SignalStrength.WEAK;

    const signal = this.signalRepo.create({
      symbol,
      timeframe,
      signalType,
      strength,
      entryPrice: currentPrice,
      stopLoss: scalpSetup.stopLoss,
      takeProfit: scalpSetup.takeProfit,
      confidence: scalpSetup.confidence,
      ictAnalysis: {
        marketStructure: 'SCALPING',
        orderBlocks: [],
        fairValueGaps: [],
        liquidityLevels: [],
        killZone: 'Scalping Mode',
        sessionBias: scalpSetup.direction,
      },
      aiAnalysis: JSON.stringify({
        mode: 'SCALPING',
        reasons: scalpSetup.reasons,
        confluences: scalpSetup.confluences,
        riskReward: scalpSetup.riskRewardRatio,
      }),
      reasoning: `SCALP: ${scalpSetup.reasons.join(', ')}. Confluences: ${scalpSetup.confluences.join(', ')}`,
      executed: false,
    });

    return await withRetry(
      () => this.signalRepo.save(signal),
      { operationName: 'Save scalping signal', maxRetries: 3 }
    );
  }

  /**
   * Execute a trade based on a signal
   */
  async executeTrade(signal: TradingSignal): Promise<Trade | null> {
    const accountId = this.configService.get('MT5_USER', 'default');
    
    try {
      // Check if auto trading is enabled
      const autoTradingEnabled = this.configService.get('AUTO_TRADING_ENABLED', 'true') === 'true';
      if (!autoTradingEnabled) {
        this.logger.log('Auto trading is disabled, skipping execution');
        return null;
      }

      // Check if signal is valid for trading
      if (signal.signalType === SignalType.HOLD) {
        return null;
      }

      // Lower confidence threshold for scalping mode (20% vs 30%)
      const minConfidence = this.scalpingMode ? 20 : 30;
      if (signal.confidence < minConfidence) {
        this.logger.log(`Signal confidence too low: ${signal.confidence}% (min: ${minConfidence}%)`);
        return null;
      }

      // ===== MONEY MANAGEMENT CHECKS =====
      const mmStatus = await this.moneyManagementService.getMoneyManagementStatus(accountId);
      
      // Check if we should stop trading (daily target reached or loss limit)
      if (mmStatus.shouldStopTrading.stop) {
        this.logger.log(`Trading stopped: ${mmStatus.shouldStopTrading.reason}`);
        await this.logEvent(
          TradingEventType.CRON_EXECUTION,
          `Trade skipped: ${mmStatus.shouldStopTrading.reason}`,
          { 
            signalId: signal.id,
            dailyProfit: mmStatus.accountState.dailyProfit,
            dailyTarget: mmStatus.currentLevel.dailyTarget,
          },
        );
        return null;
      }

      // Get dynamic lot size based on current balance level
      const lotSize = mmStatus.recommendedLotSize;
      const currentLevel = mmStatus.currentLevel;
      
      this.logger.log(
        `Money Management: Level ${currentLevel.level}, Balance $${mmStatus.accountState.currentBalance}, ` +
        `LotSize ${lotSize}, Daily Target Progress: ${mmStatus.dailyTargetProgress.toFixed(1)}%`
      );

      // Check max positions
      const maxPositions = parseInt(this.configService.get('TRADING_MAX_POSITIONS', '3'));
      const openOrders = await this.mt5Service.getOpenedOrdersForSymbol(signal.symbol);
      
      if (openOrders.length >= maxPositions) {
        this.logger.log(`Max positions reached for ${signal.symbol}`);
        return null;
      }

      // Check if market is open
      const isOpen = await this.mt5Service.isTradeSession(signal.symbol);
      if (!isOpen) {
        this.logger.log(`Market is closed for ${signal.symbol}`);
        return null;
      }

      // Lot size already determined by money management above

      // Send order to MT5
      const direction = signal.signalType === SignalType.BUY ? 'BUY' : 'SELL';
      
      const orderResult = await this.mt5Service.sendOrder({
        symbol: signal.symbol,
        type: direction,
        volume: lotSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        comment: `ICT_L${currentLevel.level}_${signal.id.substring(0, 6)}`,
      });

      if (orderResult.error) {
        await this.logEvent(
          TradingEventType.ERROR,
          `Order execution failed: ${orderResult.error}`,
          { signal: signal.id, orderResult },
          'error',
          undefined,
          signal.id,
        );
        return null;
      }

      // Create trade record
      const trade = this.tradeRepo.create({
        mt5Ticket: orderResult.order,
        symbol: signal.symbol,
        direction: direction === 'BUY' ? TradeDirection.BUY : TradeDirection.SELL,
        entryPrice: orderResult.price || signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        lotSize,
        status: TradeStatus.OPEN,
        signalId: signal.id,
        notes: signal.reasoning,
        metadata: {
          signalConfidence: signal.confidence,
          ictAnalysis: signal.ictAnalysis,
          moneyManagement: {
            level: currentLevel.level,
            balanceAtEntry: mmStatus.accountState.currentBalance,
            dailyProfitAtEntry: mmStatus.accountState.dailyProfit,
            dailyTarget: currentLevel.dailyTarget,
          },
        },
      });

      const savedTrade = await withRetry(
        () => this.tradeRepo.save(trade),
        { operationName: 'Save trade', maxRetries: 3 }
      );

      // Update signal as executed
      signal.executed = true;
      signal.tradeId = savedTrade.id;
      await withRetry(
        () => this.signalRepo.save(signal),
        { operationName: 'Update signal executed status', maxRetries: 3 }
      );

      await this.logEvent(
        TradingEventType.TRADE_OPENED,
        `Trade opened: ${direction} ${lotSize} ${signal.symbol} @ ${orderResult.price}`,
        { trade: savedTrade, orderResult },
        'info',
        savedTrade.id,
        signal.id,
      );

      return savedTrade;
    } catch (error) {
      await this.logEvent(
        TradingEventType.ERROR,
        `Trade execution error: ${error.message}`,
        { error: error.message, signalId: signal.id },
        'error',
        undefined,
        signal.id,
      );
      return null;
    }
  }

  /**
   * Get open trades
   */
  async getOpenTrades(): Promise<Trade[]> {
    return this.tradeRepo.find({
      where: { status: TradeStatus.OPEN },
      order: { openedAt: 'DESC' },
    });
  }

  /**
   * Get recent signals
   */
  async getRecentSignals(limit: number = 20): Promise<TradingSignal[]> {
    return this.signalRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get trading logs
   */
  async getTradingLogs(limit: number = 50): Promise<TradingLog[]> {
    return this.logRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get trade statistics
   */
  async getTradeStats(): Promise<{
    totalTrades: number;
    openTrades: number;
    closedTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalProfit: number;
  }> {
    const trades = await this.tradeRepo.find();
    
    const openTrades = trades.filter(t => t.status === TradeStatus.OPEN);
    const closedTrades = trades.filter(t => t.status === TradeStatus.CLOSED);
    const winningTrades = closedTrades.filter(t => t.profit > 0);
    const losingTrades = closedTrades.filter(t => t.profit < 0);
    const totalProfit = closedTrades.reduce((sum, t) => sum + Number(t.profit), 0);

    return {
      totalTrades: trades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length) * 100 : 0,
      totalProfit,
    };
  }

  /**
   * Sync trade status with MT5
   */
  async syncTradesWithMt5(): Promise<void> {
    const openTrades = await this.getOpenTrades();
    const mt5Orders = await this.mt5Service.getOpenedOrders();
    const accountId = process.env.MT5_ACCOUNT_ID || 'default';

    for (const trade of openTrades) {
      const mt5Order = mt5Orders.find(o => o.ticket === trade.mt5Ticket);
      
      if (!mt5Order) {
        // Trade was closed on MT5
        trade.status = TradeStatus.CLOSED;
        trade.closedAt = new Date();
        
        // Get current account balance to update money management
        const accountSummary = await this.mt5Service.getAccountSummary();
        const currentBalance = accountSummary?.balance || 0;
        
        // Try to calculate profit from previous balance if we don't have it
        // The profit should be the difference or stored in trade metadata
        const profit = trade.profit || 0;
        
        await withRetry(
          () => this.tradeRepo.save(trade),
          { operationName: 'Update closed trade', maxRetries: 3 }
        );

        // Update money management account state with the profit
        if (profit !== 0 && currentBalance > 0) {
          try {
            await this.moneyManagementService.updateAccountState(accountId, profit, currentBalance);
            this.logger.log(`Updated account state with profit: $${profit.toFixed(2)}, Balance: $${currentBalance.toFixed(2)}`);
          } catch (error) {
            this.logger.warn(`Failed to update money management state: ${error.message}`);
          }
        }
        
        await this.logEvent(
          TradingEventType.TRADE_CLOSED,
          `Trade ${trade.mt5Ticket} closed (synced from MT5) - Profit: $${profit?.toFixed(2) || '0.00'}`,
          { trade, profit },
          'info',
          trade.id,
        );
      } else {
        // Update profit
        trade.profit = mt5Order.profit;
        await withRetry(
          () => this.tradeRepo.save(trade),
          { operationName: 'Update trade profit', maxRetries: 3 }
        );
      }
    }
  }
}
