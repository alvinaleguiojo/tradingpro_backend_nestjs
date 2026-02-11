import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
import { Trade, TradeDocument, TradeDirection, TradeStatus } from '../../schemas/trade.schema';
import { TradingSignal, TradingSignalDocument, SignalType, SignalStrength } from '../../schemas/trading-signal.schema';
import { TradingLog, TradingLogDocument, TradingEventType } from '../../schemas/trading-log.schema';
import { TradeLock, TradeLockDocument } from '../../schemas/trade-lock.schema';
import { Mt5Service, OrderSendResult } from '../mt5/mt5.service';
import { IctStrategyService } from '../ict-strategy/ict-strategy.service';
import { OpenAiService, AiTradeRecommendation } from '../openai/openai.service';
import { MoneyManagementService } from '../money-management/money-management.service';
import { KillZoneService } from '../ict-strategy/services/kill-zone.service';
import { ScalpingStrategyService } from '../ict-strategy/services/scalping-strategy.service';
import { IctAnalysisResult, TradeSetup, Candle } from '../ict-strategy/types';

@Injectable()
export class TradingService implements OnModuleInit {
  private readonly logger = new Logger(TradingService.name);
  private scalpingMode: boolean = true; // Enable aggressive scalping by default
  private readonly LOCK_TIMEOUT_MS = 30000; // 30 second lock timeout

  constructor(
    private configService: ConfigService,
    @InjectModel(Trade.name)
    private tradeModel: Model<TradeDocument>,
    @InjectModel(TradingSignal.name)
    private signalModel: Model<TradingSignalDocument>,
    @InjectModel(TradingLog.name)
    private logModel: Model<TradingLogDocument>,
    @InjectModel(TradeLock.name)
    private tradeLockModel: Model<TradeLockDocument>,
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
   * Acquire a distributed lock for trading on a specific account
   * Uses MongoDB's atomic upsert to ensure only one instance can acquire the lock
   * @returns lockId if acquired, null if failed
   */
  async acquireTradeLock(accountId: string): Promise<string | null> {
    const lockId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.LOCK_TIMEOUT_MS);

    try {
      // Use a two-step approach for reliable distributed locking:
      // 1. Try to insert a new lock document (will fail if one exists)
      // 2. If that fails, try to update an expired/released lock
      
      // Step 1: Try to create a new lock (for accounts with no lock yet)
      try {
        await this.tradeLockModel.create({
          accountId,
          lockId,
          lockedAt: now,
          expiresAt,
          released: false,
        });
        this.logger.log(`🔒 Acquired NEW trade lock for account ${accountId}`);
        return lockId;
      } catch (createError: any) {
        // If it's not a duplicate key error, something else went wrong
        if (createError.code !== 11000) {
          throw createError;
        }
        // Duplicate key - lock document exists, try to acquire it
      }

      // Step 2: Try to update an existing lock that's released or expired
      const result = await this.tradeLockModel.findOneAndUpdate(
        {
          accountId,
          $or: [
            { released: true },
            { expiresAt: { $lt: now } },
          ],
        },
        {
          $set: {
            lockId,
            lockedAt: now,
            expiresAt,
            released: false,
          },
        },
        { new: true },
      );

      if (result && result.lockId === lockId) {
        this.logger.log(`🔒 Acquired EXISTING trade lock for account ${accountId}`);
        return lockId;
      }

      // Lock is held by another instance and hasn't expired
      this.logger.log(`⏳ Lock held by another instance for account ${accountId} - skipping trade`);
      return null;
    } catch (error: any) {
      this.logger.error(`Lock acquisition error for ${accountId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Release a trade lock
   */
  async releaseTradeLock(accountId: string, lockId: string): Promise<void> {
    try {
      await this.tradeLockModel.updateOne(
        { accountId, lockId },
        { $set: { released: true } },
      );
      this.logger.debug(`🔓 Released trade lock for account ${accountId}`);
    } catch (error: any) {
      this.logger.warn(`Failed to release lock for ${accountId}: ${error.message}`);
    }
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
    accountId?: string,
  ) {
    const log = new this.logModel({
      eventType,
      message,
      data,
      level,
      tradeId,
      signalId,
      accountId: accountId || this.mt5Service.getCurrentAccountId(),
    });
    
    await log.save();
    
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
  ): Promise<TradingSignalDocument | null> {
    try {
      // Use M5 for scalping mode, otherwise use provided timeframe
      const analysisTimeframe = this.scalpingMode ? 'M5' : timeframe;
      
      // Get price history from MT5 - reduced count for scalping (today's data only has ~50-60 candles)
      const candles = await this.mt5Service.getPriceHistory(symbol, analysisTimeframe, 100);
      
      // Reduced minimum for aggressive scalping - only need 20 candles
      const minCandles = this.scalpingMode ? 20 : 50;
      if (candles.length < minCandles) {
        await this.logEvent(
          TradingEventType.MARKET_ANALYSIS,
          `Insufficient candles for analysis: ${candles.length} (need ${minCandles})`,
          { symbol, timeframe: analysisTimeframe, candleCount: candles.length, required: minCandles },
          'warn',
        );
        return null;
      }

      this.logger.log(`Analyzing ${candles.length} candles for ${symbol} ${analysisTimeframe}`);

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

        // AI CONFIRMATION: Only for trades with ICT confidence >= 50%
        // This filters out low-quality setups while keeping speed for obvious trades
        const AI_CONFIRMATION_THRESHOLD = 50;
        
        if (scalpSetup.confidence >= AI_CONFIRMATION_THRESHOLD) {
          if (this.openAiService.isAvailable()) {
            this.logger.log(`🤖 ICT confidence ${scalpSetup.confidence}% >= ${AI_CONFIRMATION_THRESHOLD}% - Getting AI confirmation...`);

            try {
              // Run FULL ICT analysis for AI to have complete market context
              const fullIctAnalysis = this.ictStrategyService.analyzeMarket(
                formattedCandles,
                symbol,
                analysisTimeframe,
              );

              // Override the trade setup with our scalping setup
              fullIctAnalysis.tradeSetup = scalpSetup;
              const regimeTelemetry = this.getScalpingRegimeTelemetry(scalpSetup);
              const config = this.scalpingStrategy.getConfig();
              const minRiskReward = regimeTelemetry.regime === 'RANGE'
                ? config.rangeMinRiskReward
                : config.minRiskReward;

              this.logger.log(`📊 Sending full ICT analysis to AI: ${fullIctAnalysis.orderBlocks.length} OBs, ${fullIctAnalysis.fairValueGaps.length} FVGs, ${fullIctAnalysis.liquidityLevels.length} liquidity levels`);

              const aiRecommendation = await this.openAiService.analyzeMarket(
                fullIctAnalysis,
                formattedCandles.slice(-20),
                currentPrice,
                {
                  mode: 'SCALPING',
                  minRiskReward,
                  minConfidence: 50,
                },
              );

              // Check if AI agrees with the trade direction
              const aiAgrees = aiRecommendation.shouldTrade &&
                              aiRecommendation.direction === scalpSetup.direction &&
                              aiRecommendation.confidence >= 50;

              if (!aiAgrees) {
                this.logger.log(
                  `❌ AI REJECTED scalp: AI says ${aiRecommendation.direction} (${aiRecommendation.confidence}% confidence), ` +
                  `ICT says ${scalpSetup.direction}. Skipping trade.`
                );
                await this.logEvent(
                  TradingEventType.MARKET_ANALYSIS,
                  `AI rejected scalp signal: AI ${aiRecommendation.direction} vs ICT ${scalpSetup.direction}`,
                  {
                    ictDirection: scalpSetup.direction,
                    ictConfidence: scalpSetup.confidence,
                    aiDirection: aiRecommendation.direction,
                    aiConfidence: aiRecommendation.confidence,
                    aiReasoning: aiRecommendation.reasoning,
                  },
                  'info',
                );
                return null;
              }

              this.logger.log(
                `✅ AI CONFIRMED: ${aiRecommendation.direction} with ${aiRecommendation.confidence}% confidence`
              );

              // Boost confidence when AI agrees
              scalpSetup.confidence = Math.min(100, scalpSetup.confidence + 15);
              scalpSetup.reasons.push(`AI confirmation: ${aiRecommendation.reasoning?.substring(0, 100) || 'Agrees with setup'}`);

              // Create scalping signal WITH AI data
              const signal = await this.createScalpingSignal(scalpSetup, symbol, analysisTimeframe, currentPrice, aiRecommendation);

              await this.logEvent(
                TradingEventType.SIGNAL_GENERATED,
                `SCALP signal: ${signal.signalType} with ${signal.confidence}% confidence (AI confirmed)`,
                {
                  signalId: (signal as any)._id?.toString(),
                  mode: 'SCALPING_AI_CONFIRMED',
                  aiDirection: aiRecommendation.direction,
                  aiConfidence: aiRecommendation.confidence,
                  aiReasoning: aiRecommendation.reasoning,
                  ictReasons: scalpSetup.reasons,
                  confluences: scalpSetup.confluences,
                },
                'info',
                undefined,
                (signal as any)._id?.toString(),
              );

              return signal;
            } catch (aiError) {
              this.logger.warn(`AI confirmation failed, proceeding with ICT signal only: ${aiError.message}`);
              // Continue without AI if it fails - don't block the trade
            }
          } else {
            this.logger.warn('OpenAI not available - proceeding with ICT-only scalping signal');
          }
        } else {
          this.logger.log(`⚡ ICT confidence ${scalpSetup.confidence}% < ${AI_CONFIRMATION_THRESHOLD}% - Skipping (low confidence setup)`);
          return null;
        }

        // Create scalping signal without AI (fallback)
        const signal = await this.createScalpingSignal(scalpSetup, symbol, analysisTimeframe, currentPrice);

        await this.logEvent(
          TradingEventType.SIGNAL_GENERATED,
          `SCALP signal: ${signal.signalType} with ${signal.confidence}% confidence (ICT only)`,
          { 
            signalId: (signal as any)._id?.toString(),
            mode: 'SCALPING',
            reasons: scalpSetup.reasons,
            confluences: scalpSetup.confluences,
          },
          'info',
          undefined,
          (signal as any)._id?.toString(),
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

      // currentPrice already defined above

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
        {
          mode: 'STANDARD',
          minRiskReward: 1.5,
          minConfidence: 50,
        },
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
          signalId: (signal as any)._id?.toString(), 
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
        (signal as any)._id?.toString(),
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
   * Analyze from pre-fetched data pushed by the EA (no mtapi.io calls)
   */
  async analyzeFromPushedData(
    candles: Candle[],
    currentPrice: number,
    spread: number,
    accountId: string,
    symbol: string,
    timeframe: string = 'M5',
  ): Promise<TradingSignalDocument | null> {
    try {
      const minCandles = this.scalpingMode ? 20 : 50;
      if (candles.length < minCandles) {
        this.logger.warn(`EA pushed insufficient candles: ${candles.length} (need ${minCandles})`);
        return null;
      }

      this.logger.log(`[EA] Analyzing ${candles.length} candles for ${symbol} ${timeframe} (account ${accountId})`);

      if (this.scalpingMode) {
        if (this.ictStrategyService.isHighImpactNewsTime()) {
          this.logger.log('[EA] Scalping paused — high-impact news time');
          return null;
        }

        const scalpSetup = this.scalpingStrategy.analyzeForScalp(candles, currentPrice, spread);
        if (!scalpSetup) {
          this.logger.log('[EA] No scalping setup found');
          return null;
        }

        this.logger.log(
          `[EA] SCALP SIGNAL: ${scalpSetup.direction} | Confidence: ${scalpSetup.confidence}% | ` +
          `Entry: ${currentPrice.toFixed(2)} | SL: ${scalpSetup.stopLoss.toFixed(2)} | ` +
          `TP: ${scalpSetup.takeProfit.toFixed(2)} | R:R ${scalpSetup.riskRewardRatio}`
        );

        const AI_CONFIRMATION_THRESHOLD = 50;

        if (scalpSetup.confidence >= AI_CONFIRMATION_THRESHOLD) {
          if (this.openAiService.isAvailable()) {
            this.logger.log(`[EA] Confidence ${scalpSetup.confidence}% >= ${AI_CONFIRMATION_THRESHOLD}% — getting AI confirmation`);

            try {
              const fullIctAnalysis = this.ictStrategyService.analyzeMarket(candles, symbol, timeframe);
              fullIctAnalysis.tradeSetup = scalpSetup;
              const regimeTelemetry = this.getScalpingRegimeTelemetry(scalpSetup);
              const config = this.scalpingStrategy.getConfig();
              const minRiskReward = regimeTelemetry.regime === 'RANGE'
                ? config.rangeMinRiskReward
                : config.minRiskReward;

              const aiRecommendation = await this.openAiService.analyzeMarket(
                fullIctAnalysis,
                candles.slice(-20),
                currentPrice,
                {
                  mode: 'SCALPING',
                  minRiskReward,
                  minConfidence: 50,
                },
              );

              const aiAgrees =
                aiRecommendation.shouldTrade &&
                aiRecommendation.direction === scalpSetup.direction &&
                aiRecommendation.confidence >= 50;

              if (!aiAgrees) {
                this.logger.log(`[EA] AI REJECTED: AI says ${aiRecommendation.direction} (${aiRecommendation.confidence}%), ICT says ${scalpSetup.direction}`);
                return null;
              }

              this.logger.log(`[EA] AI CONFIRMED: ${aiRecommendation.direction} (${aiRecommendation.confidence}%)`);
              scalpSetup.confidence = Math.min(100, scalpSetup.confidence + 15);
              scalpSetup.reasons.push(`AI confirmation: ${aiRecommendation.reasoning?.substring(0, 100) || 'Agrees with setup'}`);

              return await this.createScalpingSignalForAccount(scalpSetup, symbol, timeframe, currentPrice, accountId, aiRecommendation);
            } catch (aiError) {
              this.logger.warn(`[EA] AI failed, proceeding with ICT signal only: ${aiError.message}`);
            }
          } else {
            this.logger.warn('[EA] OpenAI not available - proceeding with ICT-only scalping signal');
          }
        } else {
          this.logger.log(`[EA] Confidence ${scalpSetup.confidence}% < ${AI_CONFIRMATION_THRESHOLD}% — skipping`);
          return null;
        }

        return await this.createScalpingSignalForAccount(scalpSetup, symbol, timeframe, currentPrice, accountId);
      }

      // Standard ICT mode
      const ictAnalysis = this.ictStrategyService.analyzeMarket(candles, symbol, timeframe);
      const aiRecommendation = await this.openAiService.analyzeMarket(
        ictAnalysis,
        candles.slice(-20),
        currentPrice,
        {
          mode: 'STANDARD',
          minRiskReward: 1.5,
          minConfidence: 50,
        },
      );

      const signal = await this.createSignalForAccount(ictAnalysis, aiRecommendation, currentPrice, accountId);

      await this.logEvent(
        TradingEventType.SIGNAL_GENERATED,
        `[EA] Signal: ${signal.signalType} (${signal.confidence}% confidence)`,
        { signalId: (signal as any)._id?.toString() },
        'info',
        undefined,
        (signal as any)._id?.toString(),
        accountId,
      );

      return signal;
    } catch (error) {
      this.logger.error(`[EA] Analysis failed for ${accountId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Build regime telemetry from scalping setup text signals.
   */
  private getScalpingRegimeTelemetry(
    scalpSetup: TradeSetup,
  ): { regime: string; regimeReason: string } {
    const reasons = scalpSetup.reasons || [];
    const confluences = scalpSetup.confluences || [];
    const rangeReason =
      reasons.find((r) => /ranging regime|range/i.test(r)) ||
      confluences.find((c) => /range/i.test(c));

    if (rangeReason) {
      return { regime: 'RANGE', regimeReason: rangeReason };
    }

    const trendReason =
      reasons.find((r) => /momentum|break|trend|engulfing|reversal/i.test(r)) ||
      reasons[0] ||
      confluences[0] ||
      'Trend-following scalping conditions';

    return { regime: 'TREND', regimeReason: trendReason };
  }

  /**
   * Create scalping signal with explicit accountId (for EA bridge)
   */
  private async createScalpingSignalForAccount(
    scalpSetup: TradeSetup,
    symbol: string,
    timeframe: string,
    currentPrice: number,
    accountId: string,
    aiRecommendation?: AiTradeRecommendation,
  ): Promise<TradingSignalDocument> {
    const signalType = scalpSetup.direction === 'BUY' ? SignalType.BUY : SignalType.SELL;
    const regimeTelemetry = this.getScalpingRegimeTelemetry(scalpSetup);

    let strength: SignalStrength;
    if (scalpSetup.confidence >= 70) strength = SignalStrength.VERY_STRONG;
    else if (scalpSetup.confidence >= 50) strength = SignalStrength.STRONG;
    else if (scalpSetup.confidence >= 30) strength = SignalStrength.MODERATE;
    else strength = SignalStrength.WEAK;

    const aiAnalysisData = aiRecommendation
      ? {
          mode: 'SCALPING_AI_CONFIRMED',
          aiConfirmed: true,
          aiDirection: aiRecommendation.direction,
          aiConfidence: aiRecommendation.confidence,
          aiReasoning: aiRecommendation.reasoning,
          ictReasons: scalpSetup.reasons,
          confluences: scalpSetup.confluences,
          riskReward: scalpSetup.riskRewardRatio,
        }
      : {
          mode: 'SCALPING_EA',
          aiConfirmed: false,
          ictReasons: scalpSetup.reasons,
          confluences: scalpSetup.confluences,
          riskReward: scalpSetup.riskRewardRatio,
        };

    const reasoning = aiRecommendation
      ? `AI CONFIRMED: ${aiRecommendation.reasoning || 'Validated'}. ICT: ${scalpSetup.reasons.join(', ')}`
      : `SCALP: ${scalpSetup.reasons.join(', ')}. Confluences: ${scalpSetup.confluences.join(', ')}`;

    const signal = new this.signalModel({
      accountId,
      symbol,
      timeframe,
      signalType,
      strength,
      entryPrice: currentPrice,
      stopLoss: scalpSetup.stopLoss,
      takeProfit: scalpSetup.takeProfit,
      confidence: scalpSetup.confidence,
      ictAnalysis: {
        marketStructure: aiRecommendation ? 'SCALPING_AI_CONFIRMED' : 'SCALPING_EA',
        regime: regimeTelemetry.regime,
        regimeReason: regimeTelemetry.regimeReason,
        orderBlocks: [],
        fairValueGaps: [],
        liquidityLevels: [],
        killZone: 'Scalping Mode',
        sessionBias: scalpSetup.direction,
      },
      aiAnalysis: JSON.stringify(aiAnalysisData),
      reasoning,
      executed: false,
    });

    return await signal.save();
  }

  /**
   * Create a trading signal with explicit accountId (for EA bridge)
   */
  private async createSignalForAccount(
    ictAnalysis: IctAnalysisResult,
    aiRecommendation: AiTradeRecommendation,
    currentPrice: number,
    accountId: string,
  ): Promise<TradingSignalDocument> {
    let signalType: SignalType;
    let entryPrice: number;
    let stopLoss: number;
    let takeProfit: number;
    let confidence: number;

    if (aiRecommendation.shouldTrade) {
      signalType = aiRecommendation.direction === 'BUY' ? SignalType.BUY :
                   aiRecommendation.direction === 'SELL' ? SignalType.SELL : SignalType.HOLD;
      entryPrice = aiRecommendation.entryPrice;
      stopLoss = aiRecommendation.stopLoss;
      takeProfit = aiRecommendation.takeProfit;
      confidence = aiRecommendation.confidence;
    } else if (ictAnalysis.tradeSetup) {
      signalType = ictAnalysis.tradeSetup.direction === 'BUY' ? SignalType.BUY : SignalType.SELL;
      entryPrice = ictAnalysis.tradeSetup.entryPrice;
      stopLoss = ictAnalysis.tradeSetup.stopLoss;
      takeProfit = ictAnalysis.tradeSetup.takeProfit;
      confidence = ictAnalysis.tradeSetup.confidence;
    } else {
      signalType = SignalType.HOLD;
      entryPrice = currentPrice;
      stopLoss = currentPrice;
      takeProfit = currentPrice;
      confidence = 0;
    }

    let strength: SignalStrength;
    if (confidence >= 80) strength = SignalStrength.VERY_STRONG;
    else if (confidence >= 60) strength = SignalStrength.STRONG;
    else if (confidence >= 40) strength = SignalStrength.MODERATE;
    else strength = SignalStrength.WEAK;

    const signal = new this.signalModel({
      accountId,
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
        regime: ictAnalysis.marketStructure.trend,
        regimeReason: `ICT market structure trend is ${ictAnalysis.marketStructure.trend}`,
        orderBlocks: ictAnalysis.orderBlocks.filter((ob) => ob.valid).slice(0, 5),
        fairValueGaps: ictAnalysis.unfilledFVGs.slice(0, 5),
        liquidityLevels: [...ictAnalysis.buyLiquidity.slice(0, 3), ...ictAnalysis.sellLiquidity.slice(0, 3)],
        killZone: ictAnalysis.currentKillZone?.name || 'None',
        sessionBias: ictAnalysis.sessionBias,
      },
      aiAnalysis: JSON.stringify(aiRecommendation),
      reasoning: aiRecommendation.reasoning,
      executed: false,
    });

    return await signal.save();
  }

  /**
   * Create a trading signal from analysis results
   */
  private async createSignal(
    ictAnalysis: IctAnalysisResult,
    aiRecommendation: AiTradeRecommendation,
    currentPrice: number,
  ): Promise<TradingSignalDocument> {
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

    const signal = new this.signalModel({
      accountId: this.mt5Service.getCurrentAccountId(),
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
        regime: ictAnalysis.marketStructure.trend,
        regimeReason: `ICT market structure trend is ${ictAnalysis.marketStructure.trend}`,
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

    return await signal.save();
  }

  /**
   * Create a trading signal from scalping analysis (with AI confirmation)
   */
  private async createScalpingSignal(
    scalpSetup: TradeSetup,
    symbol: string,
    timeframe: string,
    currentPrice: number,
    aiRecommendation?: AiTradeRecommendation,
  ): Promise<TradingSignalDocument> {
    const signalType = scalpSetup.direction === 'BUY' ? SignalType.BUY : SignalType.SELL;
    const regimeTelemetry = this.getScalpingRegimeTelemetry(scalpSetup);
    
    // Scalping uses different strength thresholds (lower requirements)
    let strength: SignalStrength;
    if (scalpSetup.confidence >= 70) strength = SignalStrength.VERY_STRONG;
    else if (scalpSetup.confidence >= 50) strength = SignalStrength.STRONG;
    else if (scalpSetup.confidence >= 30) strength = SignalStrength.MODERATE;
    else strength = SignalStrength.WEAK;

    // Build AI analysis data for frontend display
    const aiAnalysisData = aiRecommendation ? {
      mode: 'SCALPING_AI_CONFIRMED',
      aiConfirmed: true,
      aiDirection: aiRecommendation.direction,
      aiConfidence: aiRecommendation.confidence,
      aiReasoning: aiRecommendation.reasoning,
      ictReasons: scalpSetup.reasons,
      confluences: scalpSetup.confluences,
      riskReward: scalpSetup.riskRewardRatio,
    } : {
      mode: 'SCALPING',
      aiConfirmed: false,
      ictReasons: scalpSetup.reasons,
      confluences: scalpSetup.confluences,
      riskReward: scalpSetup.riskRewardRatio,
    };

    // Build reasoning with AI insight
    const reasoning = aiRecommendation 
      ? `🤖 AI CONFIRMED: ${aiRecommendation.reasoning || 'Trade setup validated'}. ICT: ${scalpSetup.reasons.join(', ')}`
      : `SCALP: ${scalpSetup.reasons.join(', ')}. Confluences: ${scalpSetup.confluences.join(', ')}`;

    const signal = new this.signalModel({
      accountId: this.mt5Service.getCurrentAccountId(),
      symbol,
      timeframe,
      signalType,
      strength,
      entryPrice: currentPrice,
      stopLoss: scalpSetup.stopLoss,
      takeProfit: scalpSetup.takeProfit,
      confidence: scalpSetup.confidence,
      ictAnalysis: {
        marketStructure: aiRecommendation ? 'SCALPING_AI_CONFIRMED' : 'SCALPING',
        regime: regimeTelemetry.regime,
        regimeReason: regimeTelemetry.regimeReason,
        orderBlocks: [],
        fairValueGaps: [],
        liquidityLevels: [],
        killZone: 'Scalping Mode',
        sessionBias: scalpSetup.direction,
      },
      aiAnalysis: JSON.stringify(aiAnalysisData),
      reasoning,
      executed: false,
    });

    return await signal.save();
  }

  /**
   * Execute a trade based on a signal
   * Uses distributed locking to prevent race conditions in serverless environment
   */
  async executeTrade(signal: TradingSignalDocument): Promise<TradeDocument | null> {
    // Use the currently connected MT5 account, fallback to env variable
    const accountId: string = this.mt5Service.getCurrentAccountId() || this.configService.get('MT5_USER', 'default');
    
    // ===== ACQUIRE DISTRIBUTED LOCK =====
    // This prevents race conditions where multiple serverless instances try to trade at the same time
    const lockId = await this.acquireTradeLock(accountId);
    if (!lockId) {
      this.logger.log(`⏳ Could not acquire trade lock for account ${accountId} - another trade in progress`);
      await this.logEvent(
        TradingEventType.CRON_EXECUTION,
        `Trade skipped: Lock not acquired (another trade in progress)`,
        { accountId },
        'info',
      );
      return null;
    }

    try {
      // Check if auto trading is enabled
      const autoTradingEnabled = this.configService.get('AUTO_TRADING_ENABLED', 'true') === 'true';
      if (!autoTradingEnabled) {
        this.logger.log('Auto trading is disabled, skipping execution');
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // Check if signal is valid for trading
      if (signal.signalType === SignalType.HOLD) {
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // Minimum confidence threshold for scalping mode (20% vs 30%)
      const minConfidence = this.scalpingMode ? 20 : 30;
      if (signal.confidence < minConfidence) {
        this.logger.log(`Signal confidence too low: ${signal.confidence}% (min: ${minConfidence}%)`);
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // ===== MONEY MANAGEMENT CHECKS =====
      const mmStatus = await this.moneyManagementService.getMoneyManagementStatus(accountId);
      
      // Check if we should stop trading (daily target reached or loss limit)
      // DISABLED FOR TESTING - uncomment to re-enable daily target limits
      // if (mmStatus.shouldStopTrading.stop) {
      //   this.logger.log(`Trading stopped: ${mmStatus.shouldStopTrading.reason}`);
      //   await this.logEvent(
      //     TradingEventType.CRON_EXECUTION,
      //     `Trade skipped: ${mmStatus.shouldStopTrading.reason}`,
      //     { 
      //       signalId: signal.id,
      //       dailyProfit: mmStatus.accountState.dailyProfit,
      //       dailyTarget: mmStatus.currentLevel.dailyTarget,
      //     },
      //   );
      //   return null;
      // }
      this.logger.log(`Daily target check DISABLED for testing - would have stopped: ${mmStatus.shouldStopTrading.stop ? 'YES' : 'NO'}`);

      // Get dynamic lot size based on current balance level
      let lotSize = mmStatus.recommendedLotSize;
      let currentLevel = mmStatus.currentLevel;
      const currentBalance = Number(mmStatus.accountState.currentBalance);
      
      // SANITY CHECK: Verify lot size matches balance
      // For balances under $100, lot size should ALWAYS be 0.01
      if (currentBalance < 100 && lotSize > 0.01) {
        this.logger.error(`🚨 LOT SIZE MISMATCH! Balance $${currentBalance.toFixed(2)} should use 0.01 lot but got ${lotSize} - CORRECTING to 0.01`);
        await this.logEvent(
          TradingEventType.ERROR,
          `Lot size sanity check failed: Balance $${currentBalance.toFixed(2)} but lot size ${lotSize} - corrected to 0.01`,
          { accountId, balance: currentBalance, originalLotSize: lotSize, correctedLotSize: 0.01 },
          'error',
          accountId,
        );
        // Force safe lot size
        lotSize = 0.01;
        currentLevel = { ...currentLevel, level: 1, lotSize: 0.01 };
      }
      
      this.logger.log(
        `Money Management: Level ${currentLevel.level}, Balance $${mmStatus.accountState.currentBalance}, ` +
        `LotSize ${lotSize}, Daily Target Progress: ${mmStatus.dailyTargetProgress.toFixed(1)}%`
      );

      // ===== CRITICAL: VERIFY MT5 CONNECTION STILL MATCHES OUR ACCOUNT =====
      // In serverless environment, the MT5 connection might have been switched to a different account
      const currentConnectedAccount = this.mt5Service.getCurrentAccountId();
      if (currentConnectedAccount !== accountId) {
        this.logger.warn(`🚨 MT5 connection mismatch! Expected: ${accountId}, Got: ${currentConnectedAccount}. Aborting trade.`);
        await this.logEvent(
          TradingEventType.ERROR,
          `Trade aborted: MT5 connection switched to different account`,
          { expectedAccount: accountId, actualAccount: currentConnectedAccount },
          'error',
          accountId,
        );
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // Check max positions - each account should only have 1 open position at a time
      const maxPositions = 1;
      const allOpenOrders = await this.mt5Service.getOpenedOrders();
      
      // Double-check account is still correct after MT5 API call
      const postCheckAccount = this.mt5Service.getCurrentAccountId();
      if (postCheckAccount !== accountId) {
        this.logger.warn(`🚨 MT5 connection switched during order check! Expected: ${accountId}, Got: ${postCheckAccount}. Aborting.`);
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }
      
      if (allOpenOrders.length >= maxPositions) {
        this.logger.log(`Max positions reached for account ${accountId}: ${allOpenOrders.length}/${maxPositions} (limit 1 per account)`);
        await this.logEvent(
          TradingEventType.CRON_EXECUTION,
          `Trade skipped: Max positions reached (${allOpenOrders.length}/${maxPositions})`,
          { accountId, openPositions: allOpenOrders.length, maxPositions },
          'info',
        );
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // Check if market is open
      const isOpen = await this.mt5Service.isTradeSession(signal.symbol);
      if (!isOpen) {
        this.logger.log(`Market is closed for ${signal.symbol}`);
        await this.logEvent(
          TradingEventType.CRON_EXECUTION,
          `Trade skipped: Market closed for ${signal.symbol}`,
          { symbol: signal.symbol },
          'info',
        );
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // Lot size already determined by money management above

      // ===== FINAL SAFETY CHECK: Verify account JUST before placing order =====
      const preOrderAccount = this.mt5Service.getCurrentAccountId();
      if (preOrderAccount !== accountId) {
        this.logger.error(`🚨 CRITICAL: Account mismatch just before order! Expected: ${accountId}, Got: ${preOrderAccount}`);
        await this.logEvent(
          TradingEventType.ERROR,
          `Trade aborted at order stage: Account mismatch`,
          { expectedAccount: accountId, actualAccount: preOrderAccount },
          'error',
          accountId,
        );
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // ===== FINAL CHECK: Re-verify open orders immediately before placing trade =====
      const finalOrderCheck = await this.mt5Service.getOpenedOrders();
      if (finalOrderCheck.length >= maxPositions) {
        this.logger.warn(`🚨 Final check: Open orders detected (${finalOrderCheck.length}). Aborting duplicate trade.`);
        await this.logEvent(
          TradingEventType.CRON_EXECUTION,
          `Trade aborted: Last-second order check found ${finalOrderCheck.length} open positions`,
          { accountId, openPositions: finalOrderCheck.length },
          'info',
        );
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // Send order to MT5
      const direction = signal.signalType === SignalType.BUY ? 'BUY' : 'SELL';
      const signalIdStr = (signal as any)._id?.toString() || '';
      
      const orderResult = await this.mt5Service.sendOrder({
        symbol: signal.symbol,
        type: direction,
        volume: lotSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        comment: `ICT_L${currentLevel.level}_${signalIdStr.substring(0, 6)}`,
      });

      if (orderResult.error) {
        await this.logEvent(
          TradingEventType.ERROR,
          `Order execution failed: ${orderResult.error}`,
          { signal: signalIdStr, orderResult },
          'error',
          undefined,
          signalIdStr,
        );
        await this.releaseTradeLock(accountId, lockId);
        return null;
      }

      // Some brokers don't accept SL/TP in the initial order
      // Try to modify the order to set SL/TP if they weren't applied
      if (signal.stopLoss && signal.takeProfit) {
        try {
          // Wait for the order to be fully processed
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Get the ticket from the order result, or find it from open orders
          let ticketToModify = orderResult.order;
          
          if (!ticketToModify) {
            // Order ticket not returned, find the most recent order for this symbol
            const openOrders = await this.mt5Service.getOpenedOrdersForSymbol(signal.symbol);
            if (openOrders.length > 0) {
              // Get the most recent order (should be the one we just opened)
              const latestOrder = openOrders.sort((a, b) => 
                new Date(b.openTime).getTime() - new Date(a.openTime).getTime()
              )[0];
              ticketToModify = latestOrder.ticket?.toString();
              this.logger.log(`📋 Found order ticket from open orders: ${ticketToModify}`);
            }
          }
          
          if (ticketToModify) {
            const modifyResult = await this.mt5Service.modifyOrder({
              ticket: ticketToModify,
              stopLoss: signal.stopLoss,
              takeProfit: signal.takeProfit,
            });
            
            if (modifyResult) {
              this.logger.log(`✅ SL/TP set on order ${ticketToModify}: SL=${signal.stopLoss}, TP=${signal.takeProfit}`);
              await this.logEvent(
                TradingEventType.TRADE_MODIFIED,
                `SL/TP set: SL=${signal.stopLoss}, TP=${signal.takeProfit}`,
                { ticket: ticketToModify, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit },
              );
            } else {
              this.logger.warn(`⚠️ Could not set SL/TP on order ${ticketToModify}`);
            }
          } else {
            this.logger.warn(`⚠️ Could not find order ticket to set SL/TP`);
          }
        } catch (modifyError) {
          this.logger.warn(`⚠️ Failed to modify order for SL/TP: ${modifyError.message}`);
        }
      }

      // Create trade record - reuse accountId from top of function
      const trade = new this.tradeModel({
        accountId,
        mt5Ticket: orderResult.order,
        symbol: signal.symbol,
        direction: direction === 'BUY' ? TradeDirection.BUY : TradeDirection.SELL,
        entryPrice: orderResult.price || signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        lotSize,
        status: TradeStatus.OPEN,
        signalId: signal._id?.toString(),
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
        openedAt: new Date(),
      });

      const savedTrade = await trade.save();

      // Update signal as executed
      await this.signalModel.updateOne(
        { _id: signal._id },
        { executed: true, tradeId: savedTrade._id?.toString() }
      );

      await this.logEvent(
        TradingEventType.TRADE_OPENED,
        `Trade opened: ${direction} ${lotSize} ${signal.symbol} @ ${orderResult.price}`,
        { trade: savedTrade.toObject(), orderResult },
        'info',
        savedTrade._id?.toString(),
        signal._id?.toString(),
      );

      // Release the lock after successful trade
      await this.releaseTradeLock(accountId, lockId);
      return savedTrade;
    } catch (error) {
      await this.logEvent(
        TradingEventType.ERROR,
        `Trade execution error: ${error.message}`,
        { error: error.message, signalId: signal._id?.toString() },
        'error',
        undefined,
        signal._id?.toString(),
      );
      // Release the lock on error
      await this.releaseTradeLock(accountId, lockId);
      return null;
    }
  }

  /**
   * Get open trades - optionally filtered by accountId
   */
  async getOpenTrades(accountId?: string): Promise<TradeDocument[]> {
    const query: any = { status: TradeStatus.OPEN };
    if (accountId) {
      query.accountId = accountId;
    }
    return this.tradeModel.find(query).sort({ openedAt: -1 }).exec();
  }

  /**
   * Get closed trades - optionally filtered by accountId, with pagination
   */
  async getClosedTrades(
    accountId?: string,
    days: number = 30,
    page: number = 1,
    pageSize: number = 50,
  ): Promise<{
    data: TradeDocument[];
    total: number;
    totalProfit: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const query: any = { status: TradeStatus.CLOSED };
    if (accountId) {
      query.accountId = accountId;
    }
    if (days && days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      query.closedAt = { $gte: since };
    }

    const total = await this.tradeModel.countDocuments(query);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const skip = (currentPage - 1) * pageSize;

    const data = await this.tradeModel
      .find(query)
      .sort({ closedAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .exec();

    const totalProfitAgg = await this.tradeModel.aggregate([
      { $match: query },
      { $group: { _id: null, totalProfit: { $sum: '$profit' } } },
    ]);
    const totalProfit = totalProfitAgg?.[0]?.totalProfit ?? 0;

    return {
      data,
      total,
      totalProfit: Math.round(totalProfit * 100) / 100,
      page: currentPage,
      pageSize,
      totalPages,
    };
  }

  /**
   * Get recent signals - optionally filtered by accountId
   */
  async getRecentSignals(limit: number = 20, accountId?: string): Promise<TradingSignalDocument[]> {
    const query: any = {};
    if (accountId) {
      query.accountId = accountId;
    }
    return this.signalModel.find(query).sort({ createdAt: -1 }).limit(limit).exec();
  }

  /**
   * Get signal performance grouped by regime from signal telemetry.
   * Links signals to trades via trade.signalId.
   */
  async getSignalStatsByRegime(
    accountId?: string,
    days: number = 30,
  ): Promise<{
    periodDays: number;
    accountId?: string;
    totals: {
      signals: number;
      executedSignals: number;
      closedTrades: number;
      winningTrades: number;
      losingTrades: number;
      winRate: number;
      totalProfit: number;
    };
    regimes: Array<{
      regime: string;
      regimeReason: string;
      signals: number;
      executedSignals: number;
      closedTrades: number;
      winningTrades: number;
      losingTrades: number;
      winRate: number;
      totalProfit: number;
      avgProfitPerClosedTrade: number;
      avgConfidence: number;
    }>;
  }> {
    const match: any = {};
    if (accountId) {
      match.accountId = accountId;
    }
    if (days && days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      match.createdAt = { $gte: since };
    }

    const regimes = await this.signalModel.aggregate([
      { $match: match },
      {
        $addFields: {
          regime: { $ifNull: ['$ictAnalysis.regime', 'UNKNOWN'] },
          regimeReason: {
            $ifNull: ['$ictAnalysis.regimeReason', 'No regime reason captured'],
          },
          signalIdStr: { $toString: '$_id' },
        },
      },
      {
        $lookup: {
          from: 'trades',
          let: { signalIdStr: '$signalIdStr' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$signalId', '$$signalIdStr'] },
              },
            },
          ],
          as: 'linkedTrades',
        },
      },
      {
        $addFields: {
          closedTrades: {
            $filter: {
              input: '$linkedTrades',
              as: 't',
              cond: { $eq: ['$$t.status', 'CLOSED'] },
            },
          },
        },
      },
      {
        $addFields: {
          closedTradeCount: { $size: '$closedTrades' },
          winsCount: {
            $size: {
              $filter: {
                input: '$closedTrades',
                as: 't',
                cond: { $gt: ['$$t.profit', 0] },
              },
            },
          },
          lossesCount: {
            $size: {
              $filter: {
                input: '$closedTrades',
                as: 't',
                cond: { $lt: ['$$t.profit', 0] },
              },
            },
          },
          signalProfit: {
            $reduce: {
              input: '$closedTrades',
              initialValue: 0,
              in: { $add: ['$$value', { $ifNull: ['$$this.profit', 0] }] },
            },
          },
        },
      },
      {
        $group: {
          _id: { regime: '$regime', regimeReason: '$regimeReason' },
          signals: { $sum: 1 },
          executedSignals: { $sum: { $cond: ['$executed', 1, 0] } },
          closedTrades: { $sum: '$closedTradeCount' },
          winningTrades: { $sum: '$winsCount' },
          losingTrades: { $sum: '$lossesCount' },
          totalProfit: { $sum: '$signalProfit' },
          avgConfidence: { $avg: '$confidence' },
        },
      },
      {
        $project: {
          _id: 0,
          regime: '$_id.regime',
          regimeReason: '$_id.regimeReason',
          signals: 1,
          executedSignals: 1,
          closedTrades: 1,
          winningTrades: 1,
          losingTrades: 1,
          winRate: {
            $cond: [
              { $gt: ['$closedTrades', 0] },
              { $multiply: [{ $divide: ['$winningTrades', '$closedTrades'] }, 100] },
              0,
            ],
          },
          totalProfit: 1,
          avgProfitPerClosedTrade: {
            $cond: [
              { $gt: ['$closedTrades', 0] },
              { $divide: ['$totalProfit', '$closedTrades'] },
              0,
            ],
          },
          avgConfidence: { $round: ['$avgConfidence', 2] },
        },
      },
      { $sort: { signals: -1, regime: 1 } },
    ]);

    const totals = regimes.reduce(
      (acc, row) => {
        acc.signals += row.signals || 0;
        acc.executedSignals += row.executedSignals || 0;
        acc.closedTrades += row.closedTrades || 0;
        acc.winningTrades += row.winningTrades || 0;
        acc.losingTrades += row.losingTrades || 0;
        acc.totalProfit += Number(row.totalProfit || 0);
        return acc;
      },
      {
        signals: 0,
        executedSignals: 0,
        closedTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalProfit: 0,
      },
    );

    const overallWinRate =
      totals.closedTrades > 0 ? (totals.winningTrades / totals.closedTrades) * 100 : 0;

    return {
      periodDays: days,
      accountId,
      totals: {
        ...totals,
        winRate: Math.round(overallWinRate * 100) / 100,
        totalProfit: Math.round(totals.totalProfit * 100) / 100,
      },
      regimes: regimes.map((r) => ({
        ...r,
        winRate: Math.round((r.winRate || 0) * 100) / 100,
        totalProfit: Math.round((r.totalProfit || 0) * 100) / 100,
        avgProfitPerClosedTrade: Math.round((r.avgProfitPerClosedTrade || 0) * 100) / 100,
      })),
    };
  }

  /**
   * Get trading logs - optionally filtered by accountId
   */
  async getTradingLogs(limit: number = 50, accountId?: string): Promise<TradingLogDocument[]> {
    const query: any = {};
    if (accountId) {
      query.accountId = accountId;
    }
    return this.logModel.find(query).sort({ createdAt: -1 }).limit(limit).exec();
  }

  /**
   * Get trade statistics - combines database trades with live MT5 data
   * Optionally filtered by accountId
   */
  async getTradeStats(accountId?: string): Promise<{
    totalTrades: number;
    openTrades: number;
    closedTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalProfit: number;
  }> {
    // Get trades from database - filter by accountId if provided
    const query: any = {};
    if (accountId) {
      query.accountId = accountId;
    }
    const dbTrades = await this.tradeModel.find(query).exec();
    
    // Also get live open trades from MT5 to ensure accuracy
    let mt5OpenCount = 0;
    try {
      const mt5Orders = await this.mt5Service.getOpenedOrders();
      // Filter to only trading orders (not balance operations)
      const tradeOrders = mt5Orders.filter(o => 
        o.symbol && o.symbol.length > 0 && 
        (o.type === 'Buy' || o.type === 'Sell' || 
         o.type === 'BuyLimit' || o.type === 'SellLimit' ||
         o.type === 'BuyStop' || o.type === 'SellStop')
      );
      mt5OpenCount = tradeOrders.length;
    } catch (error) {
      this.logger.warn('Could not fetch MT5 orders for stats');
    }
    
    const dbOpenTrades = dbTrades.filter(t => t.status === TradeStatus.OPEN);
    const closedTrades = dbTrades.filter(t => t.status === TradeStatus.CLOSED);
    const winningTrades = closedTrades.filter(t => t.profit > 0);
    const losingTrades = closedTrades.filter(t => t.profit < 0);
    const totalProfit = closedTrades.reduce((sum, t) => sum + Number(t.profit), 0);
    
    // Use the higher of DB open trades or MT5 open trades for accuracy
    const openTradesCount = Math.max(dbOpenTrades.length, mt5OpenCount);
    const totalTradesCount = openTradesCount + closedTrades.length;

    return {
      totalTrades: totalTradesCount,
      openTrades: openTradesCount,
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
        await this.tradeModel.updateOne(
          { _id: trade._id },
          { status: TradeStatus.CLOSED, closedAt: new Date() }
        );
        
        // Get current account balance to update money management
        const accountSummary = await this.mt5Service.getAccountSummary();
        const currentBalance = accountSummary?.balance || 0;
        
        // Try to calculate profit from previous balance if we don't have it
        // The profit should be the difference or stored in trade metadata
        const profit = trade.profit || 0;

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
          { trade: trade.toObject(), profit },
          'info',
          trade._id?.toString(),
        );
      } else {
        // Update profit
        await this.tradeModel.updateOne(
          { _id: trade._id },
          { profit: mt5Order.profit }
        );
      }
    }
  }
}
