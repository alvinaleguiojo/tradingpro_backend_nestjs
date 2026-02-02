import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { AnalysisService } from './analysis.service';

@ApiTags('analysis')
@Controller('analysis')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Get('full')
  @ApiOperation({ summary: 'Get comprehensive market analysis with ICT concepts and AI' })
  @ApiQuery({ name: 'symbol', required: false, example: 'XAUUSDm' })
  @ApiQuery({ name: 'timeframe', required: false, example: 'M15' })
  async getFullAnalysis(
    @Query('symbol') symbol: string = 'XAUUSDm',
    @Query('timeframe') timeframe: string = 'M15',
  ) {
    const analysis = await this.analysisService.getMarketAnalysis(symbol, timeframe);
    return {
      success: true,
      data: analysis,
    };
  }

  @Get('market-structure')
  @ApiOperation({ summary: 'Get market structure analysis' })
  @ApiQuery({ name: 'symbol', required: false, example: 'XAUUSDm' })
  @ApiQuery({ name: 'timeframe', required: false, example: 'M15' })
  async getMarketStructure(
    @Query('symbol') symbol: string = 'XAUUSDm',
    @Query('timeframe') timeframe: string = 'M15',
  ) {
    const result = await this.analysisService.getMarketStructure(symbol, timeframe);
    return {
      success: true,
      data: result,
    };
  }

  @Get('order-blocks')
  @ApiOperation({ summary: 'Get order blocks (ICT concept)' })
  @ApiQuery({ name: 'symbol', required: false, example: 'XAUUSDm' })
  @ApiQuery({ name: 'timeframe', required: false, example: 'M15' })
  async getOrderBlocks(
    @Query('symbol') symbol: string = 'XAUUSDm',
    @Query('timeframe') timeframe: string = 'M15',
  ) {
    const result = await this.analysisService.getOrderBlocks(symbol, timeframe);
    return {
      success: true,
      data: result,
    };
  }

  @Get('fair-value-gaps')
  @ApiOperation({ summary: 'Get fair value gaps (ICT concept)' })
  @ApiQuery({ name: 'symbol', required: false, example: 'XAUUSDm' })
  @ApiQuery({ name: 'timeframe', required: false, example: 'M15' })
  async getFairValueGaps(
    @Query('symbol') symbol: string = 'XAUUSDm',
    @Query('timeframe') timeframe: string = 'M15',
  ) {
    const result = await this.analysisService.getFairValueGaps(symbol, timeframe);
    return {
      success: true,
      data: result,
    };
  }

  @Get('liquidity')
  @ApiOperation({ summary: 'Get liquidity levels (ICT concept)' })
  @ApiQuery({ name: 'symbol', required: false, example: 'XAUUSDm' })
  @ApiQuery({ name: 'timeframe', required: false, example: 'M15' })
  async getLiquidityLevels(
    @Query('symbol') symbol: string = 'XAUUSDm',
    @Query('timeframe') timeframe: string = 'M15',
  ) {
    const result = await this.analysisService.getLiquidityLevels(symbol, timeframe);
    return {
      success: true,
      data: result,
    };
  }
}
