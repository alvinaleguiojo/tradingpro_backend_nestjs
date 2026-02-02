import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IctStrategyService } from './ict-strategy.service';
import { MarketStructureService } from './services/market-structure.service';
import { OrderBlockService } from './services/order-block.service';
import { FairValueGapService } from './services/fair-value-gap.service';
import { LiquidityService } from './services/liquidity.service';
import { KillZoneService } from './services/kill-zone.service';
import { TradingSignal } from '../../entities/trading-signal.entity';
import { MarketData } from '../../entities/market-data.entity';

@Module({
  imports: [TypeOrmModule.forFeature([TradingSignal, MarketData])],
  providers: [
    IctStrategyService,
    MarketStructureService,
    OrderBlockService,
    FairValueGapService,
    LiquidityService,
    KillZoneService,
  ],
  exports: [IctStrategyService],
})
export class IctStrategyModule {}
