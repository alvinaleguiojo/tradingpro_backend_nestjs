import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EaBridgeController } from './ea-bridge.controller';
import { EaBridgeService } from './ea-bridge.service';
import { EaSession, EaSessionSchema } from '../../schemas/ea-session.schema';
import { EaCommand, EaCommandSchema } from '../../schemas/ea-command.schema';
import { Trade, TradeSchema } from '../../schemas/trade.schema';
import { TradingLog, TradingLogSchema } from '../../schemas/trading-log.schema';
import { TradingModule } from '../trading/trading.module';
import { MoneyManagementModule } from '../money-management/money-management.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EaSession.name, schema: EaSessionSchema },
      { name: EaCommand.name, schema: EaCommandSchema },
      { name: Trade.name, schema: TradeSchema },
      { name: TradingLog.name, schema: TradingLogSchema },
    ]),
    forwardRef(() => TradingModule),
    MoneyManagementModule,
  ],
  controllers: [EaBridgeController],
  providers: [EaBridgeService],
  exports: [EaBridgeService],
})
export class EaBridgeModule {}
