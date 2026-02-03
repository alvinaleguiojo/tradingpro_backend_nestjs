import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TradingAccountStateDocument = TradingAccountState & Document;

@Schema({ timestamps: true, collection: 'trading_account_states' })
export class TradingAccountState {
  @Prop({ required: true, unique: true, index: true })
  accountId: string;

  @Prop({ required: true })
  initialBalance: number;

  @Prop({ required: true })
  currentBalance: number;

  @Prop({ required: true })
  currentLevel: number;

  @Prop({ required: true })
  currentLotSize: number;

  @Prop({ default: 0 })
  dailyProfit: number;

  @Prop({ default: 0 })
  weeklyProfit: number;

  @Prop({ default: 0 })
  monthlyProfit: number;

  @Prop({ default: 0 })
  totalProfit: number;

  @Prop()
  lastTradingDay: Date;

  @Prop()
  weekStartDate: Date;

  @Prop()
  monthStartDate: Date;

  @Prop({ default: false })
  dailyTargetReached: boolean;

  @Prop({ default: false })
  weeklyTargetReached: boolean;

  @Prop({ default: false })
  monthlyTargetReached: boolean;
}

export const TradingAccountStateSchema = SchemaFactory.createForClass(TradingAccountState);
