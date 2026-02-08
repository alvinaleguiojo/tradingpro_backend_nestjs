import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EaSessionDocument = EaSession & Document;

@Schema({ timestamps: true, collection: 'ea_sessions' })
export class EaSession {
  @Prop({ required: true, unique: true, index: true })
  accountId: string;

  @Prop({ required: true })
  symbol: string;

  @Prop({ required: true })
  lastSyncAt: Date;

  @Prop({ default: false })
  isOnline: boolean;

  @Prop({ type: Object })
  accountInfo: {
    balance: number;
    equity: number;
    freeMargin: number;
    margin: number;
    leverage: number;
    currency: string;
  };

  @Prop({ type: [Object] })
  openPositions: Array<{
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
  }>;

  @Prop({ type: Object })
  lastQuote: {
    bid: number;
    ask: number;
    time: string;
  };

  @Prop({ type: [Object] })
  candles: Array<{
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    tickVolume: number;
  }>;

  @Prop()
  lastAnalysisAt: Date;

  @Prop()
  eaVersion: string;
}

export const EaSessionSchema = SchemaFactory.createForClass(EaSession);
