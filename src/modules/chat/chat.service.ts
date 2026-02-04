import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ChatMessage, ChatMessageDocument } from '../../schemas/chat-message.schema';

export interface SendMessageDto {
  accountId: string;
  username: string;
  message: string;
  channel?: string;
  metadata?: {
    avatar?: string;
    accountBalance?: number;
    tradeCount?: number;
  };
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectModel(ChatMessage.name)
    private chatMessageModel: Model<ChatMessageDocument>,
  ) {}

  /**
   * Send a new message
   */
  async sendMessage(dto: SendMessageDto): Promise<ChatMessageDocument> {
    const message = new this.chatMessageModel({
      accountId: dto.accountId,
      username: dto.username,
      message: dto.message.trim(),
      channel: dto.channel || 'general',
      metadata: dto.metadata,
    });

    await message.save();
    this.logger.log(`Message sent by ${dto.username} in ${dto.channel || 'general'}`);
    return message;
  }

  /**
   * Get messages for a channel
   */
  async getMessages(
    channel: string = 'general',
    limit: number = 50,
    before?: string,
  ): Promise<ChatMessageDocument[]> {
    const query: any = { channel, isDeleted: false };
    
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    return this.chatMessageModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  /**
   * Get new messages since a timestamp (for polling)
   */
  async getNewMessages(
    channel: string = 'general',
    since: string,
  ): Promise<ChatMessageDocument[]> {
    return this.chatMessageModel
      .find({
        channel,
        isDeleted: false,
        createdAt: { $gt: new Date(since) },
      })
      .sort({ createdAt: 1 })
      .exec();
  }

  /**
   * Delete a message (soft delete)
   */
  async deleteMessage(messageId: string, accountId: string): Promise<boolean> {
    const result = await this.chatMessageModel.updateOne(
      { _id: messageId, accountId },
      { isDeleted: true },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Get online users count (users who sent messages in last 5 minutes)
   */
  async getActiveUsersCount(channel: string = 'general'): Promise<number> {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const result = await this.chatMessageModel.distinct('accountId', {
      channel,
      createdAt: { $gte: fiveMinutesAgo },
    });
    return result.length;
  }

  /**
   * Get message count per channel
   */
  async getChannelStats(): Promise<{ channel: string; count: number }[]> {
    return this.chatMessageModel.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$channel', count: { $sum: 1 } } },
      { $project: { channel: '$_id', count: 1, _id: 0 } },
    ]);
  }
}
