import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Mt5Service } from './mt5.service';
import { Mt5Controller } from './mt5.controller';
import { Mt5Connection } from '../../entities/mt5-connection.entity';
import { TradingLog } from '../../entities/trading-log.entity';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    TypeOrmModule.forFeature([Mt5Connection, TradingLog]),
  ],
  controllers: [Mt5Controller],
  providers: [Mt5Service],
  exports: [Mt5Service],
})
export class Mt5Module {}
