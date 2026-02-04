import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TradingService } from './trading.service';
import { TradingController } from './trading.controller';
import { AutoTradingService } from './auto-trading.service';
import { Trade, TradeSchema } from '../../schemas/trade.schema';
import { TradingSignal, TradingSignalSchema } from '../../schemas/trading-signal.schema';
import { TradingLog, TradingLogSchema } from '../../schemas/trading-log.schema';
import { Mt5Connection, Mt5ConnectionSchema } from '../../schemas/mt5-connection.schema';
import { TradeLock, TradeLockSchema } from '../../schemas/trade-lock.schema';
import { Mt5Module } from '../mt5/mt5.module';
import { IctStrategyModule } from '../ict-strategy/ict-strategy.module';
import { OpenAiModule } from '../openai/openai.module';
import { MoneyManagementModule } from '../money-management/money-management.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Trade.name, schema: TradeSchema },
      { name: TradingSignal.name, schema: TradingSignalSchema },
      { name: TradingLog.name, schema: TradingLogSchema },
      { name: Mt5Connection.name, schema: Mt5ConnectionSchema },
      { name: TradeLock.name, schema: TradeLockSchema },
    ]),
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
