import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('health')
@Controller()
export class HealthController {
  @Get('health')
  @ApiOperation({ summary: 'Health check endpoint' })
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }

  @Get()
  @ApiOperation({ summary: 'Root endpoint' })
  getRoot() {
    return {
      name: 'TradingPro Auto Trading API',
      version: '1.0.0',
      status: 'running',
    };
  }
}
