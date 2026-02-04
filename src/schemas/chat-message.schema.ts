import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ChatMessageDocument = ChatMessage & Document;

@Schema({ timestamps: true })
export class ChatMessage {
  @Prop({ required: true })
  accountId: string;

  @Prop({ required: true })
  username: string;

  @Prop({ required: true })
  message: string;

  @Prop({ default: 'general' })
  channel: string; // 'general', 'signals', 'help'

  @Prop({ type: Object })
  metadata?: {
    avatar?: string;
    accountBalance?: number;
    tradeCount?: number;
  };

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop()
  createdAt?: Date;

  @Prop()
  updatedAt?: Date;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);

// Index for efficient querying
ChatMessageSchema.index({ channel: 1, createdAt: -1 });
ChatMessageSchema.index({ accountId: 1 });
