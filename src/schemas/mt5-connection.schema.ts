import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type Mt5ConnectionDocument = Mt5Connection & Document;

@Schema({ timestamps: true, collection: 'mt5_connections' })
export class Mt5Connection {
  @Prop({ required: true, unique: true, index: true })
  accountId: string;

  @Prop()
  token: string;

  @Prop({ required: true })
  user: string;

  @Prop()
  password: string;

  @Prop({ required: true })
  host: string;

  @Prop({ required: true })
  port: number;

  @Prop({ default: false })
  isConnected: boolean;

  @Prop()
  balance: number;

  @Prop()
  equity: number;

  @Prop()
  freeMargin: number;

  @Prop()
  leverage: string;

  @Prop()
  currency: string;

  @Prop()
  serverName: string;

  @Prop()
  lastConnectedAt: Date;
}

export const Mt5ConnectionSchema = SchemaFactory.createForClass(Mt5Connection);
