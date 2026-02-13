import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Mt5Service } from '../mt5/mt5.service';
import { IctStrategyService } from '../ict-strategy/ict-strategy.service';
import { OpenAiService } from '../openai/openai.service';
import { MarketSentimentService } from '../ict-strategy/services/market-sentiment.service';
import { MarketData, MarketDataDocument } from '../../schemas/market-data.schema';
import { Candle, IctAnalysisResult } from '../ict-strategy/types';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    @InjectModel(MarketData.name)
    private marketDataModel: Model<MarketDataDocument>,
    private mt5Service: Mt5Service,
    private ictStrategyService: IctStrategyService,
    private openAiService: OpenAiService,
    private marketSentimentService: MarketSentimentService,
  ) {}

  /**
   * Get comprehensive market analysis
   */
  async getMarketAnalysis(
    symbol: string,
    timeframe: string,
  ): Promise<{
    ictAnalysis: IctAnalysisResult;
    aiRecommendation: any;
    currentPrice: number;
    quote: any;
    summary: string;
  }> {
    // Get price history
    const candles = await this.mt5Service.getPriceHistory(symbol, timeframe, 200);
    
    if (candles.length < 50) {
      throw new Error('Insufficient data for analysis');
    }

    // Format candles
    const formattedCandles: Candle[] = candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.tickVolume,
    }));

    // Get current quote
    const quote = await this.mt5Service.getQuote(symbol);
    const currentPrice = quote?.bid || formattedCandles[formattedCandles.length - 1].close;

    // Perform ICT analysis
    const ictAnalysis = this.ictStrategyService.analyzeMarket(
      formattedCandles,
      symbol,
      timeframe,
    );

    // Get AI recommendation
    const sentiment = await this.marketSentimentService.getSentiment(symbol);
    const aiRecommendation = await this.openAiService.analyzeMarket(
      ictAnalysis,
      formattedCandles.slice(-20),
      currentPrice,
      {},
      sentiment,
    );

    // Generate summary
    const summary = await this.openAiService.generateTradeSummary(aiRecommendation, ictAnalysis);

    return {
      ictAnalysis,
      aiRecommendation,
      currentPrice,
      quote,
      summary,
    };
  }

  /**
   * Get market structure analysis only
   */
  async getMarketStructure(symbol: string, timeframe: string) {
    const candles = await this.mt5Service.getPriceHistory(symbol, timeframe, 100);
    
    const formattedCandles: Candle[] = candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.tickVolume,
    }));

    const analysis = this.ictStrategyService.analyzeMarket(formattedCandles, symbol, timeframe);
    
    return {
      marketStructure: analysis.marketStructure,
      currentKillZone: analysis.currentKillZone,
      sessionBias: analysis.sessionBias,
    };
  }

  /**
   * Get order blocks
   */
  async getOrderBlocks(symbol: string, timeframe: string) {
    const candles = await this.mt5Service.getPriceHistory(symbol, timeframe, 200);
    
    const formattedCandles: Candle[] = candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.tickVolume,
    }));

    const analysis = this.ictStrategyService.analyzeMarket(formattedCandles, symbol, timeframe);
    
    return {
      orderBlocks: analysis.orderBlocks.filter(ob => ob.valid),
      nearestBullishOB: analysis.nearestBullishOB,
      nearestBearishOB: analysis.nearestBearishOB,
    };
  }

  /**
   * Get fair value gaps
   */
  async getFairValueGaps(symbol: string, timeframe: string) {
    const candles = await this.mt5Service.getPriceHistory(symbol, timeframe, 200);
    
    const formattedCandles: Candle[] = candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.tickVolume,
    }));

    const analysis = this.ictStrategyService.analyzeMarket(formattedCandles, symbol, timeframe);
    
    return {
      fairValueGaps: analysis.fairValueGaps,
      unfilledFVGs: analysis.unfilledFVGs,
    };
  }

  /**
   * Get liquidity levels
   */
  async getLiquidityLevels(symbol: string, timeframe: string) {
    const candles = await this.mt5Service.getPriceHistory(symbol, timeframe, 200);
    
    const formattedCandles: Candle[] = candles.map(c => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.tickVolume,
    }));

    const analysis = this.ictStrategyService.analyzeMarket(formattedCandles, symbol, timeframe);
    
    return {
      liquidityLevels: analysis.liquidityLevels,
      buyLiquidity: analysis.buyLiquidity,
      sellLiquidity: analysis.sellLiquidity,
    };
  }

  /**
   * Save market data to database
   */
  async saveMarketData(
    symbol: string,
    timeframe: string,
    candles: any[],
  ): Promise<void> {
    const marketDataDocs = candles.map(candle => ({
      symbol,
      timeframe,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.tickVolume || candle.volume || 0,
      timestamp: new Date(candle.time),
    }));

    await this.marketDataModel.insertMany(marketDataDocs);
  }

  /**
   * Get historical market data from database
   */
  async getHistoricalData(
    symbol: string,
    timeframe: string,
    startDate: Date,
    endDate: Date,
  ): Promise<MarketDataDocument[]> {
    return this.marketDataModel.find({
      symbol,
      timeframe,
      timestamp: { $gte: startDate, $lte: endDate }
    }).sort({ timestamp: 1 }).exec();
  }
}
