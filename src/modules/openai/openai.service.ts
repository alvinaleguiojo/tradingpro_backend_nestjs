import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { IctAnalysisResult, TradeSetup } from '../ict-strategy/types';
import { MarketSentiment } from '../ict-strategy/services/market-sentiment.service';

export interface AiTradeRecommendation {
  shouldTrade: boolean;
  direction: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reasoning: string;
  riskAssessment: string;
  marketSentiment: string;
  keyLevels: string[];
  warnings: string[];
}

export interface AiAnalysisOptions {
  mode?: 'SCALPING' | 'STANDARD';
  minRiskReward?: number;
  minConfidence?: number;
}

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);
  private openai: OpenAI;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    } else {
      this.logger.warn('OpenAI API key not configured');
    }
  }

  isAvailable(): boolean {
    return !!this.openai;
  }

  /**
   * Analyze market data and ICT analysis using GPT-4
   */
  async analyzeMarket(
    ictAnalysis: IctAnalysisResult,
    recentCandles: { open: number; high: number; low: number; close: number; time: string | Date }[],
    currentPrice: number,
    options: AiAnalysisOptions = {},
    sentiment?: MarketSentiment | null,
  ): Promise<AiTradeRecommendation> {
    if (!this.openai) {
      return this.getDefaultRecommendation('OpenAI not configured');
    }

    try {
      const mode = options.mode || 'STANDARD';
      const minRiskReward = options.minRiskReward ?? 1.5;
      const minConfidence = options.minConfidence ?? 50;
      const prompt = this.buildAnalysisPrompt(ictAnalysis, recentCandles, currentPrice, {
        mode,
        minRiskReward,
        minConfidence,
      }, sentiment);

      const configuredModel = this.configService.get<string>('OPENAI_MODEL') || 'gpt-5-chat-latest';
      const modelCandidates = Array.from(new Set([
        configuredModel,
        'gpt-5',
        'gpt-4o',
      ]));

      let response: any = null;
      let lastError: any = null;

      for (const model of modelCandidates) {
        try {
          response = await this.openai.chat.completions.create({
            model,
            messages: [
                {
                  role: 'system',
                  content: this.getSystemPrompt({
                    mode,
                    minRiskReward,
                    minConfidence,
                  }),
                },
              {
                role: 'user',
                content: prompt,
              },
            ],
            temperature: 0.3, // Lower temperature for more consistent analysis
            max_tokens: 1500,
            response_format: { type: 'json_object' },
          });
          // Success, stop trying fallbacks
          if (model !== configuredModel) {
            this.logger.warn(`OpenAI fallback used: ${model} (primary: ${configuredModel})`);
          }
          break;
        } catch (err) {
          lastError = err;
          this.logger.warn(`OpenAI model failed: ${model} - ${err.message}`);
        }
      }

      if (!response) {
        throw lastError || new Error('All OpenAI models failed');
      }

      const content = response.choices[0]?.message?.content;
      
      if (!content) {
        return this.getDefaultRecommendation('No response from AI');
      }

      const recommendation = JSON.parse(content) as AiTradeRecommendation;
      
      // Validate and sanitize the recommendation
      return this.validateRecommendation(recommendation, currentPrice, {
        mode,
        minRiskReward,
        minConfidence,
      });
      
    } catch (error) {
      this.logger.error('OpenAI analysis failed', error);
      return this.getDefaultRecommendation(`AI analysis error: ${error.message}`);
    }
  }

  /**
   * Get system prompt for the trading AI
   */
  private getSystemPrompt(options: Required<AiAnalysisOptions>): string {
    return `You are an expert forex and commodities trader specializing in ICT (Inner Circle Trader) concepts for trading Gold (XAU/USD).

Your expertise includes:
- Market Structure Analysis (Higher Highs, Higher Lows, Break of Structure, Change of Character)
- Order Blocks (Bullish and Bearish institutional order flow areas)
- Fair Value Gaps (Imbalances in price that tend to get filled)
- Liquidity Concepts (Buy-side and Sell-side liquidity, liquidity sweeps)
- Kill Zones (London, New York session optimal trading times)
- Smart Money Concepts (Institutional trading behavior)

You must analyze the provided market data and ICT analysis to give a trading recommendation.

CRITICAL RULES:
1. Only recommend trades with at least 2 confluences
2. Minimum risk-reward ratio of at least ${options.minRiskReward}:1
3. **RESPECT THE HIGHER TIMEFRAME TREND** - If the overall trend is BEARISH (lower highs, lower lows in price action), prefer SELL trades. If BULLISH, prefer BUY trades.
4. **DO NOT keep recommending BUY during downtrends** - A single bullish candle in a downtrend is NOT a reversal
5. Prefer trades during Kill Zones (London/NY sessions), but if mode is SCALPING do not reject valid setups solely because they are outside kill zones
6. Be conservative - when in doubt, recommend HOLD
7. Account for Gold's average daily range (typically $20-40)
8. **BALANCED ANALYSIS** - Consider both bullish AND bearish scenarios equally. Do not have a bias toward one direction.
9. For a valid reversal, require: Change of Character (CHoCH) or Break of Structure (BoS) in the opposite direction
10. "Oversold" alone is NOT a buy signal - markets can stay oversold during strong downtrends
11. Minimum confidence to mark shouldTrade=true is ${options.minConfidence}%
12. If market sentiment is strongly bullish or bearish, use it as a confirming filter. Do not trade against strong sentiment unless there is clear structural reversal (CHoCH or BOS).

MODE:
- Current mode is ${options.mode}.
- If mode is SCALPING: prioritize short-horizon M5 execution quality, quick invalidation, and realistic targets.
- If mode is STANDARD: prioritize higher-quality swing setups and stronger confirmation.

REVERSAL REQUIREMENTS (must have AT LEAST 2):
- Change of Character (CHoCH) on the timeframe
- Break of Structure (BoS) against the trend
- Strong engulfing pattern with follow-through
- Price rejecting from a valid order block
- Liquidity sweep followed by reversal

Respond with a JSON object containing:
{
  "shouldTrade": boolean,
  "direction": "BUY" | "SELL" | "HOLD",
  "confidence": number (0-100),
  "entryPrice": number,
  "stopLoss": number,
  "takeProfit": number,
  "reasoning": string,
  "riskAssessment": string,
  "marketSentiment": string,
  "keyLevels": string[],
  "warnings": string[]
}`;
  }

  /**
   * Build the analysis prompt with market data
   */
  private buildAnalysisPrompt(
    ictAnalysis: IctAnalysisResult,
    recentCandles: { open: number; high: number; low: number; close: number; time: string | Date }[],
    currentPrice: number,
    options: Required<AiAnalysisOptions>,
    sentiment?: MarketSentiment | null,
  ): string {
    const last10Candles = recentCandles.slice(-10);
    
    return `
Analyze the following Gold (${ictAnalysis.symbol}) market data on the ${ictAnalysis.timeframe} timeframe:

CURRENT PRICE: ${currentPrice}
MODE: ${options.mode}
CONSTRAINTS:
- Minimum Risk/Reward: ${options.minRiskReward}:1
- Minimum Trade Confidence: ${options.minConfidence}%

MARKET STRUCTURE:
- Trend: ${ictAnalysis.marketStructure.trend}
- Break of Structure: ${ictAnalysis.marketStructure.breakOfStructure}
- Change of Character: ${ictAnalysis.marketStructure.changeOfCharacter}
- Current Swing High: ${ictAnalysis.marketStructure.currentSwingHigh?.price || 'N/A'}
- Current Swing Low: ${ictAnalysis.marketStructure.currentSwingLow?.price || 'N/A'}

ORDER BLOCKS:
- Total Order Blocks: ${ictAnalysis.orderBlocks.length}
- Valid Bullish OBs: ${ictAnalysis.orderBlocks.filter(ob => ob.valid && ob.type === 'BULLISH').length}
- Valid Bearish OBs: ${ictAnalysis.orderBlocks.filter(ob => ob.valid && ob.type === 'BEARISH').length}
- Nearest Bullish OB: ${ictAnalysis.nearestBullishOB ? `${ictAnalysis.nearestBullishOB.low} - ${ictAnalysis.nearestBullishOB.high}` : 'None'}
- Nearest Bearish OB: ${ictAnalysis.nearestBearishOB ? `${ictAnalysis.nearestBearishOB.low} - ${ictAnalysis.nearestBearishOB.high}` : 'None'}

FAIR VALUE GAPS:
- Total FVGs: ${ictAnalysis.fairValueGaps.length}
- Unfilled FVGs: ${ictAnalysis.unfilledFVGs.length}
- Bullish FVGs below price: ${ictAnalysis.unfilledFVGs.filter(f => f.type === 'BULLISH' && f.high < currentPrice).length}
- Bearish FVGs above price: ${ictAnalysis.unfilledFVGs.filter(f => f.type === 'BEARISH' && f.low > currentPrice).length}

LIQUIDITY:
- Buy-side liquidity levels above: ${ictAnalysis.buyLiquidity.slice(0, 3).map(l => l.price).join(', ') || 'None identified'}
- Sell-side liquidity levels below: ${ictAnalysis.sellLiquidity.slice(0, 3).map(l => l.price).join(', ') || 'None identified'}

SESSION INFO:
- Current Kill Zone: ${ictAnalysis.currentKillZone?.name || 'Outside Kill Zone'}
- Session Bias: ${ictAnalysis.sessionBias}

MARKET SENTIMENT (CFTC COT):
${sentiment ? `
- Source: ${sentiment.source}
- Market: ${sentiment.market}
- As Of: ${sentiment.asOf}
- Managed Money Net: ${sentiment.managedMoneyNet}
- Net % OI: ${sentiment.managedMoneyNetPctOpenInterest}
- Weekly Change: ${sentiment.managedMoneyNetChange}
- Bias: ${sentiment.bias}
- Summary: ${sentiment.summary}
` : '- No sentiment data available'}

ICT TRADE SETUP (if any):
${ictAnalysis.tradeSetup ? `
- Direction: ${ictAnalysis.tradeSetup.direction}
- Entry: ${ictAnalysis.tradeSetup.entryPrice}
- Stop Loss: ${ictAnalysis.tradeSetup.stopLoss}
- Take Profit: ${ictAnalysis.tradeSetup.takeProfit}
- Risk/Reward: ${ictAnalysis.tradeSetup.riskRewardRatio}
- Confidence: ${ictAnalysis.tradeSetup.confidence}%
- Reasons: ${ictAnalysis.tradeSetup.reasons.join(', ')}
- Confluences: ${ictAnalysis.tradeSetup.confluences.join(', ')}
` : 'No setup identified by ICT analysis'}

RECENT PRICE ACTION (Last 10 ${ictAnalysis.timeframe} candles):
${last10Candles.map((c, i) => {
  const open = typeof c.open === 'number' ? c.open.toFixed(2) : 'N/A';
  const high = typeof c.high === 'number' ? c.high.toFixed(2) : 'N/A';
  const low = typeof c.low === 'number' ? c.low.toFixed(2) : 'N/A';
  const close = typeof c.close === 'number' ? c.close.toFixed(2) : 'N/A';
  return `${i + 1}. O: ${open} H: ${high} L: ${low} C: ${close}`;
}).join('\n')}

Based on this analysis, provide your trading recommendation in JSON format.
Consider the ICT concepts carefully and only recommend a trade if there are strong confluences.
`;
  }

  /**
   * Validate and sanitize the AI recommendation
   */
  private validateRecommendation(
    recommendation: AiTradeRecommendation,
    currentPrice: number,
    options: Required<AiAnalysisOptions>,
  ): AiTradeRecommendation {
    // Ensure all required fields exist
    const validated: AiTradeRecommendation = {
      shouldTrade: recommendation.shouldTrade || false,
      direction: recommendation.direction || 'HOLD',
      confidence: Math.min(100, Math.max(0, recommendation.confidence || 0)),
      entryPrice: recommendation.entryPrice || currentPrice,
      stopLoss: recommendation.stopLoss || 0,
      takeProfit: recommendation.takeProfit || 0,
      reasoning: recommendation.reasoning || 'No reasoning provided',
      riskAssessment: recommendation.riskAssessment || 'Unknown',
      marketSentiment: recommendation.marketSentiment || 'Neutral',
      keyLevels: recommendation.keyLevels || [],
      warnings: recommendation.warnings || [],
    };

    // Validate stop loss and take profit logic
    if (validated.direction === 'BUY') {
      if (validated.stopLoss >= validated.entryPrice) {
        validated.stopLoss = validated.entryPrice * 0.995; // Default 0.5% below
      }
      if (validated.takeProfit <= validated.entryPrice) {
        validated.takeProfit = validated.entryPrice * 1.01; // Default 1% above
      }
    } else if (validated.direction === 'SELL') {
      if (validated.stopLoss <= validated.entryPrice) {
        validated.stopLoss = validated.entryPrice * 1.005;
      }
      if (validated.takeProfit >= validated.entryPrice) {
        validated.takeProfit = validated.entryPrice * 0.99;
      }
    }

    // Calculate risk-reward ratio
    if (validated.shouldTrade) {
      const risk = Math.abs(validated.entryPrice - validated.stopLoss);
      const reward = Math.abs(validated.takeProfit - validated.entryPrice);
      const rr = reward / risk;

      if (rr < options.minRiskReward) {
        validated.shouldTrade = false;
        validated.warnings.push(`Risk-reward ratio below minimum threshold of ${options.minRiskReward}`);
      }
    }

    // Don't trade with low confidence
    if (validated.confidence < options.minConfidence && validated.shouldTrade) {
      validated.shouldTrade = false;
      validated.warnings.push(`Confidence too low for trade execution (min ${options.minConfidence})`);
    }

    return validated;
  }

  /**
   * Get default recommendation when AI is unavailable
   */
  private getDefaultRecommendation(reason: string): AiTradeRecommendation {
    return {
      shouldTrade: false,
      direction: 'HOLD',
      confidence: 0,
      entryPrice: 0,
      stopLoss: 0,
      takeProfit: 0,
      reasoning: reason,
      riskAssessment: 'Unable to assess',
      marketSentiment: 'Unknown',
      keyLevels: [],
      warnings: [reason],
    };
  }

  /**
   * Generate a summary of the trading decision for logging
   */
  async generateTradeSummary(
    recommendation: AiTradeRecommendation,
    ictAnalysis: IctAnalysisResult,
  ): Promise<string> {
    const summary = `
=== Trading Analysis Summary ===
Time: ${ictAnalysis.timestamp.toISOString()}
Symbol: ${ictAnalysis.symbol}
Timeframe: ${ictAnalysis.timeframe}

Market Structure: ${ictAnalysis.marketStructure.trend}
Session Bias: ${ictAnalysis.sessionBias}
Kill Zone: ${ictAnalysis.currentKillZone?.name || 'Outside Kill Zone'}

AI Recommendation: ${recommendation.direction}
Confidence: ${recommendation.confidence}%
Should Trade: ${recommendation.shouldTrade}

${recommendation.shouldTrade ? `
Entry: ${recommendation.entryPrice}
Stop Loss: ${recommendation.stopLoss}
Take Profit: ${recommendation.takeProfit}
` : ''}

Reasoning: ${recommendation.reasoning}
Risk Assessment: ${recommendation.riskAssessment}

${recommendation.warnings.length > 0 ? `Warnings: ${recommendation.warnings.join(', ')}` : ''}
================================
`;
    return summary;
  }
}
