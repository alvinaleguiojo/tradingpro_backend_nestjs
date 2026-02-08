import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EaCommandDocument = EaCommand & Document;

export enum EaCommandType {
  BUY = 'BUY',
  SELL = 'SELL',
  CLOSE = 'CLOSE',
  MODIFY = 'MODIFY',
}

export enum EaCommandSource {
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
}

export enum EaCommandStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  EXECUTED = 'EXECUTED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

@Schema({ timestamps: true, collection: 'ea_commands' })
export class EaCommand {
  @Prop({ required: true, index: true })
  accountId: string;

  @Prop({ required: true, enum: EaCommandType })
  type: EaCommandType;

  @Prop({ required: true })
  symbol: string;

  @Prop()
  volume: number;

  @Prop()
  stopLoss: number;

  @Prop()
  takeProfit: number;

  @Prop()
  ticket: string;

  @Prop()
  comment: string;

  @Prop({ required: true, enum: EaCommandSource })
  source: EaCommandSource;

  @Prop({ required: true, enum: EaCommandStatus, default: EaCommandStatus.PENDING, index: true })
  status: EaCommandStatus;

  @Prop({ type: Object })
  result: {
    ticket: string;
    price: number;
    error: string;
  };

  @Prop()
  executedAt: Date;

  @Prop()
  sentAt: Date;

  @Prop()
  expiresAt: Date;

  @Prop()
  signalId: string;
}

export const EaCommandSchema = SchemaFactory.createForClass(EaCommand);

EaCommandSchema.index({ accountId: 1, status: 1 });
EaCommandSchema.index({ createdAt: -1 });
EaCommandSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
