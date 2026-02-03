import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MoneyManagementLevelDocument = MoneyManagementLevel & Document;

@Schema({ timestamps: true, collection: 'money_management_levels' })
export class MoneyManagementLevel {
  @Prop({ required: true, unique: true, index: true })
  level: number;

  @Prop({ required: true })
  balance: number;

  @Prop({ required: true })
  lotSize: number;

  @Prop({ required: true })
  dailyTarget: number;

  @Prop({ required: true })
  weeklyTarget: number;

  @Prop({ required: true })
  monthlyTarget: number;

  @Prop({ default: false })
  completed: boolean;
}

export const MoneyManagementLevelSchema = SchemaFactory.createForClass(MoneyManagementLevel);
