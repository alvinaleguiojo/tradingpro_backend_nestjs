import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { IctStrategyService } from './ict-strategy.service';
import { MarketStructureService } from './services/market-structure.service';
import { OrderBlockService } from './services/order-block.service';
import { FairValueGapService } from './services/fair-value-gap.service';
import { LiquidityService } from './services/liquidity.service';
import { KillZoneService } from './services/kill-zone.service';
import { ScalpingStrategyService } from './services/scalping-strategy.service';
import { TradingSignal, TradingSignalSchema } from '../../schemas/trading-signal.schema';
import { MarketData, MarketDataSchema } from '../../schemas/market-data.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: TradingSignal.name, schema: TradingSignalSchema },
      { name: MarketData.name, schema: MarketDataSchema },
    ]),
  ],
  providers: [
    IctStrategyService,
    MarketStructureService,
    OrderBlockService,
    FairValueGapService,
    LiquidityService,
    KillZoneService,
    ScalpingStrategyService,
  ],
  exports: [IctStrategyService, KillZoneService, ScalpingStrategyService],
})
export class IctStrategyModule {}
