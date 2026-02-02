import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { MoneyManagementService } from './money-management.service';
import { ConfigService } from '@nestjs/config';

@ApiTags('money-management')
@Controller('money-management')
export class MoneyManagementController {
  constructor(
    private readonly moneyManagementService: MoneyManagementService,
    private readonly configService: ConfigService,
  ) {}

  @Get('levels')
  @ApiOperation({ summary: 'Get all money management levels' })
  getAllLevels() {
    return {
      success: true,
      data: this.moneyManagementService.getAllLevels(),
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get money management status for account' })
  async getStatus() {
    const accountId = this.configService.get('MT5_USER', 'default');
    const status = await this.moneyManagementService.getMoneyManagementStatus(accountId);
    return {
      success: true,
      data: status,
    };
  }

  @Get('current-level')
  @ApiOperation({ summary: 'Get current level based on balance' })
  @ApiQuery({ name: 'balance', required: true, example: 1000 })
  getCurrentLevel(@Query('balance') balance: number) {
    const level = this.moneyManagementService.getCurrentLevel(balance);
    const nextLevel = this.moneyManagementService.getNextLevel(balance);
    const progress = this.moneyManagementService.getProgressToNextLevel(balance);
    
    return {
      success: true,
      data: {
        currentLevel: level,
        nextLevel,
        progressToNextLevel: progress,
        recommendedLotSize: level.lotSize,
      },
    };
  }

  @Get('lot-size')
  @ApiOperation({ summary: 'Get recommended lot size for current balance' })
  @ApiQuery({ name: 'balance', required: true, example: 1000 })
  getLotSize(@Query('balance') balance: number) {
    const lotSize = this.moneyManagementService.getLotSizeForBalance(balance);
    const level = this.moneyManagementService.getCurrentLevel(balance);
    
    return {
      success: true,
      data: {
        lotSize,
        level: level.level,
        balance,
        dailyTarget: level.dailyTarget,
      },
    };
  }

  @Get('daily-progress')
  @ApiOperation({ summary: 'Get daily target progress' })
  @ApiQuery({ name: 'balance', required: true, example: 1000 })
  @ApiQuery({ name: 'dailyProfit', required: true, example: 15 })
  getDailyProgress(
    @Query('balance') balance: number,
    @Query('dailyProfit') dailyProfit: number,
  ) {
    const level = this.moneyManagementService.getCurrentLevel(balance);
    const progress = this.moneyManagementService.getDailyTargetProgress(balance, dailyProfit);
    const remaining = this.moneyManagementService.getRemainingDailyTarget(balance, dailyProfit);
    const targetReached = this.moneyManagementService.isDailyTargetReached(balance, dailyProfit);
    
    return {
      success: true,
      data: {
        level: level.level,
        dailyTarget: level.dailyTarget,
        currentProfit: dailyProfit,
        remainingTarget: remaining,
        progressPercent: progress,
        targetReached,
      },
    };
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sync account state with MT5' })
  async syncWithMt5() {
    const accountId = this.configService.get('MT5_USER', 'default');
    const state = await this.moneyManagementService.syncWithMt5(accountId);
    
    return {
      success: true,
      data: state,
    };
  }

  @Get('should-trade')
  @ApiOperation({ summary: 'Check if should continue trading today' })
  async shouldContinueTrading() {
    const accountId = this.configService.get('MT5_USER', 'default');
    const status = await this.moneyManagementService.getMoneyManagementStatus(accountId);
    
    return {
      success: true,
      data: {
        shouldTrade: !status.shouldStopTrading.stop,
        reason: status.shouldStopTrading.reason || 'Trading allowed',
        dailyTargetReached: status.accountState.dailyTargetReached,
        dailyProfit: status.accountState.dailyProfit,
        dailyTarget: status.currentLevel.dailyTarget,
        currentLevel: status.currentLevel.level,
        lotSize: status.recommendedLotSize,
      },
    };
  }
}
