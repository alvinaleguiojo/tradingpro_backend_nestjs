import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum SignalType {
  BUY = 'BUY',
  SELL = 'SELL',
  HOLD = 'HOLD',
}

export enum SignalStrength {
  WEAK = 'WEAK',
  MODERATE = 'MODERATE',
  STRONG = 'STRONG',
  VERY_STRONG = 'VERY_STRONG',
}

export type TradingSignalDocument = TradingSignal & Document;

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'trading_signals' })
export class TradingSignal {
  @Prop({ index: true })
  accountId: string;

  @Prop({ required: true, index: true })
  symbol: string;

  @Prop({ required: true })
  timeframe: string;

  @Prop({ required: true, enum: SignalType, index: true })
  signalType: SignalType;

  @Prop({ required: true, enum: SignalStrength, index: true })
  strength: SignalStrength;

  @Prop({ required: true })
  entryPrice: number;

  @Prop({ required: true })
  stopLoss: number;

  @Prop({ required: true })
  takeProfit: number;

  @Prop({ required: true })
  confidence: number;

  // ICT Analysis Data
  @Prop({ type: Object })
  ictAnalysis: {
    marketStructure: string;
    regime?: string;
    regimeReason?: string;
    orderBlocks: any[];
    fairValueGaps: any[];
    liquidityLevels: any[];
    killZone: string;
    sessionBias: string;
  };

  // OpenAI Analysis
  @Prop()
  aiAnalysis: string;

  @Prop()
  reasoning: string;

  @Prop({ default: false })
  executed: boolean;

  @Prop()
  tradeId: string;
}

export const TradingSignalSchema = SchemaFactory.createForClass(TradingSignal);

// Compound indexes
TradingSignalSchema.index({ symbol: 1, createdAt: -1 });
TradingSignalSchema.index({ signalType: 1, strength: 1 });
TradingSignalSchema.index({ 'ictAnalysis.regime': 1, createdAt: -1 });
