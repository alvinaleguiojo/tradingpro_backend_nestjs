import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { MarketData } from '../../entities/market-data.entity';
import { Mt5Module } from '../mt5/mt5.module';
import { IctStrategyModule } from '../ict-strategy/ict-strategy.module';
import { OpenAiModule } from '../openai/openai.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MarketData]),
    Mt5Module,
    IctStrategyModule,
    OpenAiModule,
  ],
  controllers: [AnalysisController],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
