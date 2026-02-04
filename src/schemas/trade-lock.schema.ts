import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TradeLockDocument = TradeLock & Document;

/**
 * Trade Lock Schema - Used to prevent race conditions in serverless environment
 * Implements a distributed lock pattern using MongoDB
 */
@Schema({ timestamps: true })
export class TradeLock {
  @Prop({ required: true, unique: true, index: true })
  accountId: string;

  @Prop({ required: true })
  lockId: string;

  @Prop({ required: true })
  lockedAt: Date;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: false })
  released: boolean;
}

export const TradeLockSchema = SchemaFactory.createForClass(TradeLock);

// TTL index to automatically clean up expired locks after 5 minutes
TradeLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
