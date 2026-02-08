import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MongooseModule } from '@nestjs/mongoose';
import { Mt5Service } from './mt5.service';
import { Mt5Controller } from './mt5.controller';
import { Mt5Connection, Mt5ConnectionSchema } from '../../schemas/mt5-connection.schema';
import { TradingLog, TradingLogSchema } from '../../schemas/trading-log.schema';
import { EaSession, EaSessionSchema } from '../../schemas/ea-session.schema';
import { EaCommand, EaCommandSchema } from '../../schemas/ea-command.schema';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
    MongooseModule.forFeature([
      { name: Mt5Connection.name, schema: Mt5ConnectionSchema },
      { name: TradingLog.name, schema: TradingLogSchema },
      { name: EaSession.name, schema: EaSessionSchema },
      { name: EaCommand.name, schema: EaCommandSchema },
    ]),
  ],
  controllers: [Mt5Controller],
  providers: [Mt5Service],
  exports: [Mt5Service],
})
export class Mt5Module {}
