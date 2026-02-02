import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MoneyManagementService } from './money-management.service';
import { MoneyManagementController } from './money-management.controller';
import { MoneyManagementLevel } from '../../entities/money-management-level.entity';
import { TradingAccountState } from '../../entities/trading-account-state.entity';
import { Mt5Module } from '../mt5/mt5.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MoneyManagementLevel, TradingAccountState]),
    Mt5Module,
  ],
  controllers: [MoneyManagementController],
  providers: [MoneyManagementService],
  exports: [MoneyManagementService],
})
export class MoneyManagementModule {}
