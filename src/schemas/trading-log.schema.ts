import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum TradingEventType {
  SIGNAL_GENERATED = 'SIGNAL_GENERATED',
  TRADE_OPENED = 'TRADE_OPENED',
  TRADE_CLOSED = 'TRADE_CLOSED',
  TRADE_MODIFIED = 'TRADE_MODIFIED',
  CONNECTION_ESTABLISHED = 'CONNECTION_ESTABLISHED',
  CONNECTION_LOST = 'CONNECTION_LOST',
  ERROR = 'ERROR',
  CRON_EXECUTION = 'CRON_EXECUTION',
  MARKET_ANALYSIS = 'MARKET_ANALYSIS',
}

export type TradingLogDocument = TradingLog & Document;

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'trading_logs' })
export class TradingLog {
  @Prop({ required: true, enum: TradingEventType, index: true })
  eventType: TradingEventType;

  @Prop({ required: true })
  message: string;

  @Prop({ type: Object })
  data: Record<string, any>;

  @Prop()
  tradeId: string;

  @Prop()
  signalId: string;

  @Prop({ default: 'info' })
  level: string;
}

export const TradingLogSchema = SchemaFactory.createForClass(TradingLog);

// Auto-expire logs after 30 days to save space
TradingLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
