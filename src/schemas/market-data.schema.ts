import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MarketDataDocument = MarketData & Document;

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'market_data' })
export class MarketData {
  @Prop({ required: true, index: true })
  symbol: string;

  @Prop({ required: true, index: true })
  timeframe: string;

  @Prop({ required: true })
  open: number;

  @Prop({ required: true })
  high: number;

  @Prop({ required: true })
  low: number;

  @Prop({ required: true })
  close: number;

  @Prop({ required: true })
  volume: number;

  @Prop()
  spread: number;

  @Prop({ required: true, index: true })
  timestamp: Date;
}

export const MarketDataSchema = SchemaFactory.createForClass(MarketData);

// Compound index for efficient querying
MarketDataSchema.index({ symbol: 1, timeframe: 1, timestamp: -1 });
