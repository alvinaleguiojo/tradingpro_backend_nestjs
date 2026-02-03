import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MoneyManagementService } from './money-management.service';
import { MoneyManagementController } from './money-management.controller';
import { MoneyManagementLevel, MoneyManagementLevelSchema } from '../../schemas/money-management-level.schema';
import { TradingAccountState, TradingAccountStateSchema } from '../../schemas/trading-account-state.schema';
import { Mt5Module } from '../mt5/mt5.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MoneyManagementLevel.name, schema: MoneyManagementLevelSchema },
      { name: TradingAccountState.name, schema: TradingAccountStateSchema },
    ]),
    Mt5Module,
  ],
  controllers: [MoneyManagementController],
  providers: [MoneyManagementService],
  exports: [MoneyManagementService],
})
export class MoneyManagementModule {}
