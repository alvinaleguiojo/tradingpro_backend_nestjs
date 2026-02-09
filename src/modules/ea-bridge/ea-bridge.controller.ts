import { Controller, Post, Get, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { EaBridgeService } from './ea-bridge.service';
import { EaSyncRequestDto } from './dto/ea-sync.dto';
import { EaCommandType } from '../../schemas/ea-command.schema';

@ApiTags('ea')
@Controller('ea')
export class EaBridgeController {
  constructor(private readonly eaBridgeService: EaBridgeService) {}

  @Post('sync')
  @ApiOperation({ summary: 'EA sync — pushes data, receives commands' })
  async sync(@Body() dto: EaSyncRequestDto) {
    return this.eaBridgeService.handleSync(dto);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Get all EA sessions' })
  async getSessions(@Query('onlineOnly') onlineOnly?: string) {
    const sessions =
      onlineOnly === 'true'
        ? await this.eaBridgeService.getOnlineSessions()
        : await this.eaBridgeService.getAllSessions();

    return {
      success: true,
      count: sessions.length,
      data: sessions.map((s) => ({
        accountId: s.accountId,
        symbol: s.symbol,
        isOnline: this.eaBridgeService.isSessionOnline(s),
        lastSyncAt: s.lastSyncAt,
        balance: s.accountInfo?.balance,
        equity: s.accountInfo?.equity,
        openPositions: s.openPositions?.length || 0,
        eaVersion: s.eaVersion,
      })),
    };
  }

  @Get('session/:accountId')
  @ApiOperation({ summary: 'Get EA session for an account' })
  async getSession(@Param('accountId') accountId: string) {
    const session = await this.eaBridgeService.getSessionByAccount(accountId);
    if (!session) {
      return { success: false, message: `No EA session found for account ${accountId}` };
    }
    return {
      success: true,
      data: {
        ...session.toObject(),
        isOnline: this.eaBridgeService.isSessionOnline(session),
      },
    };
  }

  @Get('commands/:id')
  @ApiOperation({ summary: 'Get command status' })
  async getCommandStatus(@Param('id') id: string) {
    const command = await this.eaBridgeService.getCommandStatus(id);
    if (!command) {
      return { success: false, message: 'Command not found' };
    }
    return { success: true, data: command };
  }

  @Get('commands')
  @ApiOperation({ summary: 'Get recent commands for an account' })
  async getCommands(
    @Query('accountId') accountId: string,
    @Query('limit') limit?: string,
  ) {
    if (!accountId) {
      return { success: false, message: 'accountId is required' };
    }
    const commands = await this.eaBridgeService.getRecentCommands(
      accountId,
      limit ? parseInt(limit, 10) : 20,
    );
    return { success: true, count: commands.length, data: commands };
  }

  @Post('command/send')
  @ApiOperation({ summary: 'Send a manual trade command to EA' })
  async sendCommand(
    @Body()
    body: {
      accountId: string;
      type: string;
      symbol: string;
      volume?: number;
      stopLoss?: number;
      takeProfit?: number;
      ticket?: string;
      comment?: string;
    },
  ) {
    try {
      const command = await this.eaBridgeService.createManualCommand(
        body.accountId,
        body.type as EaCommandType,
        body.symbol,
        body.volume,
        body.stopLoss,
        body.takeProfit,
        body.ticket,
        body.comment,
      );
      return {
        success: true,
        commandId: (command as any)._id.toString(),
        status: command.status,
        message: 'Command queued — EA will execute on next sync (~5 seconds)',
      };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }
}
