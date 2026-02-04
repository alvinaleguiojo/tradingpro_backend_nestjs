import { Controller, Get, Post, Delete, Body, Query, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
import { ChatService, SendMessageDto } from './chat.service';

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('messages')
  @ApiOperation({ summary: 'Send a chat message' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        username: { type: 'string' },
        message: { type: 'string' },
        channel: { type: 'string', default: 'general' },
      },
      required: ['accountId', 'username', 'message'],
    },
  })
  async sendMessage(@Body() dto: SendMessageDto) {
    // Basic validation
    if (!dto.message || dto.message.trim().length === 0) {
      return { success: false, error: 'Message cannot be empty' };
    }
    if (dto.message.length > 500) {
      return { success: false, error: 'Message too long (max 500 characters)' };
    }
    if (!dto.username || dto.username.trim().length === 0) {
      return { success: false, error: 'Username is required' };
    }

    const message = await this.chatService.sendMessage(dto);
    return {
      success: true,
      data: message,
    };
  }

  @Get('messages')
  @ApiOperation({ summary: 'Get chat messages' })
  @ApiQuery({ name: 'channel', required: false, example: 'general' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'before', required: false, description: 'ISO timestamp for pagination' })
  async getMessages(
    @Query('channel') channel: string = 'general',
    @Query('limit') limit: number = 50,
    @Query('before') before?: string,
  ) {
    const messages = await this.chatService.getMessages(channel, Math.min(limit, 100), before);
    return {
      success: true,
      data: messages.reverse(), // Return in chronological order
      count: messages.length,
    };
  }

  @Get('messages/new')
  @ApiOperation({ summary: 'Get new messages since timestamp (for polling)' })
  @ApiQuery({ name: 'channel', required: false, example: 'general' })
  @ApiQuery({ name: 'since', required: true, description: 'ISO timestamp' })
  async getNewMessages(
    @Query('channel') channel: string = 'general',
    @Query('since') since: string,
  ) {
    if (!since) {
      return { success: false, error: 'since parameter is required' };
    }
    const messages = await this.chatService.getNewMessages(channel, since);
    return {
      success: true,
      data: messages,
      count: messages.length,
    };
  }

  @Delete('messages/:id')
  @ApiOperation({ summary: 'Delete a message' })
  async deleteMessage(
    @Param('id') messageId: string,
    @Body('accountId') accountId: string,
  ) {
    const deleted = await this.chatService.deleteMessage(messageId, accountId);
    return {
      success: deleted,
      message: deleted ? 'Message deleted' : 'Message not found or unauthorized',
    };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get chat statistics' })
  @ApiQuery({ name: 'channel', required: false, example: 'general' })
  async getStats(@Query('channel') channel: string = 'general') {
    const [activeUsers, channelStats] = await Promise.all([
      this.chatService.getActiveUsersCount(channel),
      this.chatService.getChannelStats(),
    ]);
    return {
      success: true,
      data: {
        activeUsers,
        channels: channelStats,
      },
    };
  }
}
