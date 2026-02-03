import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export enum TradeDirection {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum TradeStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
  ERROR = 'ERROR',
}

export type TradeDocument = Trade & Document;

@Schema({ timestamps: true, collection: 'trades' })
export class Trade {
  @Prop()
  mt5Ticket: string;

  @Prop({ required: true, index: true })
  symbol: string;

  @Prop({ required: true, enum: TradeDirection })
  direction: TradeDirection;

  @Prop({ required: true })
  entryPrice: number;

  @Prop()
  exitPrice: number;

  @Prop({ required: true })
  stopLoss: number;

  @Prop({ required: true })
  takeProfit: number;

  @Prop({ required: true })
  lotSize: number;

  @Prop({ required: true, enum: TradeStatus, default: TradeStatus.PENDING, index: true })
  status: TradeStatus;

  @Prop({ default: 0 })
  profit: number;

  @Prop({ default: 0 })
  commission: number;

  @Prop({ default: 0 })
  swap: number;

  @Prop()
  signalId: string;

  @Prop()
  notes: string;

  @Prop({ type: Object })
  metadata: Record<string, any>;

  @Prop({ index: true })
  openedAt: Date;

  @Prop()
  closedAt: Date;
}

export const TradeSchema = SchemaFactory.createForClass(Trade);

// Compound indexes
TradeSchema.index({ symbol: 1, status: 1 });
TradeSchema.index({ openedAt: -1 });
