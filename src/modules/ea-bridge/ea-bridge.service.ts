import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { EaSession, EaSessionDocument } from '../../schemas/ea-session.schema';
import {
  EaCommand,
  EaCommandDocument,
  EaCommandType,
  EaCommandSource,
  EaCommandStatus,
} from '../../schemas/ea-command.schema';
import { Trade, TradeDocument, TradeStatus } from '../../schemas/trade.schema';
import { TradingLog, TradingLogDocument, TradingEventType } from '../../schemas/trading-log.schema';
import { TradingService } from '../trading/trading.service';
import { EaSyncRequestDto, EaSyncExecutionResultDto } from './dto/ea-sync.dto';

@Injectable()
export class EaBridgeService {
  private readonly logger = new Logger(EaBridgeService.name);
  private readonly ONLINE_THRESHOLD_MS = 30000; // 30 seconds
  private readonly analysisIntervalMs: number;
  private readonly commandTtlSeconds: number;

  constructor(
    @InjectModel(EaSession.name) private eaSessionModel: Model<EaSessionDocument>,
    @InjectModel(EaCommand.name) private eaCommandModel: Model<EaCommandDocument>,
    @InjectModel(Trade.name) private tradeModel: Model<TradeDocument>,
    @InjectModel(TradingLog.name) private logModel: Model<TradingLogDocument>,
    private tradingService: TradingService,
    private configService: ConfigService,
  ) {
    this.analysisIntervalMs = parseInt(
      this.configService.get('EA_ANALYSIS_INTERVAL_MS', '300000'),
      10,
    );
    this.commandTtlSeconds = parseInt(
      this.configService.get('EA_COMMAND_TTL_SECONDS', '60'),
      10,
    );
  }

  /**
   * Main sync handler — called every ~5 seconds by each EA
   */
  async handleSync(dto: EaSyncRequestDto) {
    const now = new Date();

    try {
      // 1. Upsert EA session with pushed data
      await this.updateSession(dto, now);

      // 2. Process execution results from EA
      const execResults = dto.executionResults || [];
      if (execResults.length > 0) {
        await this.processExecutionResults(dto.accountId, execResults);
      }

      // 3. Sync positions — detect trades closed by SL/TP
      await this.syncPositions(dto.accountId, dto.positions);

      // 4. Check if analysis is due
      let analysisResult: any = null;
      const autoTradingEnabled = this.configService.get('AUTO_TRADING_ENABLED', 'true') === 'true';

      if (autoTradingEnabled && dto.candles?.length >= 20) {
        analysisResult = await this.checkAndRunAnalysis(dto, now);
      }

      // 5. Gather pending commands for this account
      const commands = await this.getPendingCommands(dto.accountId, now);

      // 6. Calculate seconds until next analysis
      const session = await this.eaSessionModel.findOne({ accountId: dto.accountId }).exec();
      const lastAnalysis = session?.lastAnalysisAt?.getTime() || 0;
      const nextAnalysisIn = Math.max(
        0,
        Math.round((this.analysisIntervalMs - (now.getTime() - lastAnalysis)) / 1000),
      );

      return {
        success: true,
        commands: commands.map((cmd) => ({
          id: (cmd as any)._id.toString(),
          type: cmd.type,
          symbol: cmd.symbol,
          volume: cmd.volume,
          stopLoss: cmd.stopLoss,
          takeProfit: cmd.takeProfit,
          ticket: cmd.ticket,
          comment: cmd.comment,
        })),
        commandCount: commands.length,
        analysisRun: !!analysisResult,
        signal: analysisResult,
        nextAnalysisIn,
      };
    } catch (error) {
      this.logger.error(`Sync error for account ${dto.accountId}: ${error.message}`);
      return {
        success: false,
        commands: [],
        commandCount: 0,
        analysisRun: false,
        signal: null,
        nextAnalysisIn: 0,
        error: error.message,
      };
    }
  }

  /**
   * Upsert the EA session with fresh data
   */
  private async updateSession(dto: EaSyncRequestDto, now: Date) {
    await this.eaSessionModel.findOneAndUpdate(
      { accountId: dto.accountId },
      {
        $set: {
          accountId: dto.accountId,
          symbol: dto.symbol,
          lastSyncAt: now,
          isOnline: true,
          accountInfo: dto.account,
          openPositions: dto.positions || [],
          lastQuote: dto.quote,
          candles: dto.candles || [],
          eaVersion: dto.eaVersion || 'unknown',
        },
      },
      { upsert: true, new: true },
    );
  }

  /**
   * Process execution results reported by EA
   */
  private async processExecutionResults(
    accountId: string,
    results: EaSyncExecutionResultDto[],
  ) {
    for (const result of results) {
      try {
        const command = await this.eaCommandModel.findById(result.commandId).exec();
        if (!command) {
          this.logger.warn(`Command not found: ${result.commandId}`);
          continue;
        }

        if (result.success) {
          command.status = EaCommandStatus.EXECUTED;
          command.result = {
            ticket: result.ticket || '',
            price: result.price || 0,
            error: '',
          };
          command.executedAt = new Date();
          await command.save();

          this.logger.log(
            `Command EXECUTED: ${command.type} ${command.symbol} → ticket #${result.ticket} @ ${result.price}`,
          );

          // Create Trade record for BUY/SELL commands
          if (command.type === EaCommandType.BUY || command.type === EaCommandType.SELL) {
            await this.createTradeRecord(command, result);
          }

          // Update Trade record for CLOSE commands
          if (command.type === EaCommandType.CLOSE) {
            await this.closeTradeRecord(command.ticket, result.price);
          }
        } else {
          command.status = EaCommandStatus.FAILED;
          command.result = {
            ticket: '',
            price: 0,
            error: result.error || 'Unknown error',
          };
          command.executedAt = new Date();
          await command.save();

          this.logger.warn(
            `Command FAILED: ${command.type} ${command.symbol} → ${result.error}`,
          );
        }

        // Log the event
        await this.logModel.create({
          accountId,
          eventType: result.success
            ? TradingEventType.TRADE_OPENED
            : TradingEventType.ERROR,
          message: result.success
            ? `EA executed ${command.type}: ticket #${result.ticket} @ ${result.price}`
            : `EA failed ${command.type}: ${result.error}`,
          data: { ...result },
        });
      } catch (err) {
        this.logger.error(`Error processing result for command ${result.commandId}: ${err.message}`);
      }
    }
  }

  /**
   * Create a Trade record after EA executes a BUY/SELL
   */
  private async createTradeRecord(
    command: EaCommandDocument,
    result: EaSyncExecutionResultDto,
  ) {
    try {
      const trade = new this.tradeModel({
        accountId: command.accountId,
        mt5Ticket: result.ticket,
        symbol: command.symbol,
        direction: command.type,
        entryPrice: result.price,
        stopLoss: command.stopLoss,
        takeProfit: command.takeProfit,
        lotSize: command.volume,
        status: TradeStatus.OPEN,
        signalId: command.signalId,
        openedAt: new Date(),
        metadata: {
          source: command.source,
          commandId: (command as any)._id.toString(),
        },
      });
      await trade.save();
      this.logger.log(`Trade record created: ${command.type} #${result.ticket}`);
    } catch (err) {
      this.logger.error(`Failed to create trade record: ${err.message}`);
    }
  }

  /**
   * Close a Trade record when EA closes a position
   */
  private async closeTradeRecord(ticket: string, exitPrice?: number) {
    try {
      await this.tradeModel.findOneAndUpdate(
        { mt5Ticket: ticket, status: TradeStatus.OPEN },
        {
          status: TradeStatus.CLOSED,
          closedAt: new Date(),
          ...(exitPrice ? { exitPrice } : {}),
        },
      );
    } catch (err) {
      this.logger.error(`Failed to close trade record for ticket ${ticket}: ${err.message}`);
    }
  }

  /**
   * Sync positions — detect trades closed by SL/TP on MT5
   */
  private async syncPositions(
    accountId: string,
    positions: EaSyncRequestDto['positions'],
  ) {
    const openTrades = await this.tradeModel
      .find({ accountId, status: TradeStatus.OPEN })
      .exec();

    if (openTrades.length === 0) return;

    const positionTickets = new Set(positions.map((p) => p.ticket));

    for (const trade of openTrades) {
      if (trade.mt5Ticket && !positionTickets.has(trade.mt5Ticket)) {
        // Trade was closed on MT5 (SL/TP hit or manual close)
        trade.status = TradeStatus.CLOSED;
        trade.closedAt = new Date();
        await trade.save();

        this.logger.log(
          `Trade #${trade.mt5Ticket} closed on MT5 (SL/TP or manual) — updated DB`,
        );
      } else if (trade.mt5Ticket) {
        // Update live profit
        const pos = positions.find((p) => p.ticket === trade.mt5Ticket);
        if (pos) {
          trade.profit = pos.profit;
          await trade.save();
        }
      }
    }
  }

  /**
   * Check if analysis is due and run it
   */
  private async checkAndRunAnalysis(dto: EaSyncRequestDto, now: Date) {
    const session = await this.eaSessionModel.findOne({ accountId: dto.accountId }).exec();
    const lastAnalysis = session?.lastAnalysisAt?.getTime() || 0;
    const elapsed = now.getTime() - lastAnalysis;

    if (elapsed < this.analysisIntervalMs) {
      return null; // Not time yet
    }

    this.logger.log(
      `Running analysis for account ${dto.accountId} (${Math.round(elapsed / 1000)}s since last)`,
    );

    try {
      // Convert EA candles to the Candle format the strategy expects
      const formattedCandles = dto.candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.tickVolume,
      }));

      const currentPrice = dto.quote?.bid || formattedCandles[formattedCandles.length - 1].close;
      const spread = dto.quote ? (dto.quote.ask - dto.quote.bid) * 10 : 0;

      // Call trading service to analyze with pushed data
      const signal = await this.tradingService.analyzeFromPushedData(
        formattedCandles,
        currentPrice,
        spread,
        dto.accountId,
        dto.symbol,
      );

      // Update last analysis time
      await this.eaSessionModel.updateOne(
        { accountId: dto.accountId },
        { lastAnalysisAt: now },
      );

      if (signal && signal.signalType !== 'HOLD') {
        // Check max positions
        const openPositionCount = dto.positions?.length || 0;
        const maxPositions = parseInt(this.configService.get('TRADING_MAX_POSITIONS', '2'), 10);

        if (openPositionCount >= maxPositions) {
          this.logger.log(
            `Max positions (${maxPositions}) reached for account ${dto.accountId} — skipping trade`,
          );
          return signal;
        }

        // Create an EA command to execute the trade
        const commandTtl = new Date(now.getTime() + this.commandTtlSeconds * 1000);
        await this.eaCommandModel.create({
          accountId: dto.accountId,
          type: signal.signalType === 'BUY' ? EaCommandType.BUY : EaCommandType.SELL,
          symbol: dto.symbol,
          volume: this.getRecommendedLotSize(dto.account?.balance),
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
          comment: `AUTO_${signal.signalType}_${signal.confidence}`,
          source: EaCommandSource.AUTO,
          status: EaCommandStatus.PENDING,
          expiresAt: commandTtl,
          signalId: (signal as any)._id?.toString(),
        });

        this.logger.log(
          `Auto-trade command queued: ${signal.signalType} ${dto.symbol} SL:${signal.stopLoss} TP:${signal.takeProfit}`,
        );
      }

      return signal;
    } catch (err) {
      this.logger.error(`Analysis error for ${dto.accountId}: ${err.message}`);
      // Still update lastAnalysisAt to prevent rapid retries
      await this.eaSessionModel.updateOne(
        { accountId: dto.accountId },
        { lastAnalysisAt: now },
      );
      return null;
    }
  }

  /**
   * Get recommended lot size based on balance
   */
  private getRecommendedLotSize(balance?: number): number {
    if (!balance || balance < 100) return 0.01;
    if (balance < 500) return 0.01;
    if (balance < 1000) return 0.02;
    if (balance < 5000) return 0.05;
    return 0.1;
  }

  /**
   * Get pending commands and mark them as SENT
   */
  private async getPendingCommands(accountId: string, now: Date): Promise<EaCommandDocument[]> {
    const commands = await this.eaCommandModel
      .find({
        accountId,
        status: EaCommandStatus.PENDING,
        $or: [
          { expiresAt: { $gt: now } },
          { expiresAt: { $exists: false } },
        ],
      })
      .sort({ createdAt: 1 })
      .exec();

    if (commands.length > 0) {
      // Mark as SENT so they're not sent again
      const ids = commands.map((c) => (c as any)._id);
      await this.eaCommandModel.updateMany(
        { _id: { $in: ids } },
        { status: EaCommandStatus.SENT, sentAt: now },
      );
      this.logger.log(`Sending ${commands.length} commands to EA for account ${accountId}`);
    }

    return commands;
  }

  /**
   * Create a manual command (from frontend)
   */
  async createManualCommand(
    accountId: string,
    type: EaCommandType,
    symbol: string,
    volume?: number,
    stopLoss?: number,
    takeProfit?: number,
    ticket?: string,
    comment?: string,
  ): Promise<EaCommandDocument> {
    // Check if EA is online
    const session = await this.getSessionByAccount(accountId);
    if (!session || !this.isSessionOnline(session)) {
      throw new Error(`EA is offline for account ${accountId}. Start the EA on MT5 terminal first.`);
    }

    const commandTtl = new Date(Date.now() + this.commandTtlSeconds * 1000);

    const command = await this.eaCommandModel.create({
      accountId,
      type,
      symbol,
      volume: volume || 0.01,
      stopLoss: stopLoss || 0,
      takeProfit: takeProfit || 0,
      ticket: ticket || '',
      comment: comment || `MANUAL_${type}`,
      source: EaCommandSource.MANUAL,
      status: EaCommandStatus.PENDING,
      expiresAt: commandTtl,
    });

    this.logger.log(
      `Manual command created: ${type} ${symbol} for account ${accountId} → ${(command as any)._id}`,
    );

    return command;
  }

  /**
   * Get command status by ID
   */
  async getCommandStatus(commandId: string) {
    return this.eaCommandModel.findById(commandId).exec();
  }

  /**
   * Get recent commands for an account
   */
  async getRecentCommands(accountId: string, limit: number = 20) {
    return this.eaCommandModel
      .find({ accountId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  /**
   * Get all online EA sessions
   */
  async getOnlineSessions(): Promise<EaSessionDocument[]> {
    const threshold = new Date(Date.now() - this.ONLINE_THRESHOLD_MS);
    return this.eaSessionModel
      .find({ lastSyncAt: { $gte: threshold } })
      .exec();
  }

  /**
   * Get all sessions (including offline)
   */
  async getAllSessions(): Promise<EaSessionDocument[]> {
    return this.eaSessionModel.find().sort({ lastSyncAt: -1 }).exec();
  }

  /**
   * Get session by account ID
   */
  async getSessionByAccount(accountId: string): Promise<EaSessionDocument | null> {
    return this.eaSessionModel.findOne({ accountId }).exec();
  }

  /**
   * Check if a session is online
   */
  isSessionOnline(session: EaSessionDocument): boolean {
    if (!session?.lastSyncAt) return false;
    return Date.now() - session.lastSyncAt.getTime() < this.ONLINE_THRESHOLD_MS;
  }
}
