import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TradingService } from './trading.service';
import { TradingController } from './trading.controller';
import { AutoTradingService } from './auto-trading.service';
import { Trade } from '../../entities/trade.entity';
import { TradingSignal } from '../../entities/trading-signal.entity';
import { TradingLog } from '../../entities/trading-log.entity';
import { Mt5Connection } from '../../entities/mt5-connection.entity';
import { Mt5Module } from '../mt5/mt5.module';
import { IctStrategyModule } from '../ict-strategy/ict-strategy.module';
import { OpenAiModule } from '../openai/openai.module';
import { MoneyManagementModule } from '../money-management/money-management.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Trade, TradingSignal, TradingLog, Mt5Connection]),
    Mt5Module,
    IctStrategyModule,
    OpenAiModule,
    MoneyManagementModule,
  ],
  controllers: [TradingController],
  providers: [TradingService, AutoTradingService],
  exports: [TradingService, AutoTradingService],
})
export class TradingModule {}
