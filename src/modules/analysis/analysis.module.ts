import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { MarketData, MarketDataSchema } from '../../schemas/market-data.schema';
import { Mt5Module } from '../mt5/mt5.module';
import { IctStrategyModule } from '../ict-strategy/ict-strategy.module';
import { OpenAiModule } from '../openai/openai.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: MarketData.name, schema: MarketDataSchema }]),
    Mt5Module,
    IctStrategyModule,
    OpenAiModule,
  ],
  controllers: [AnalysisController],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
