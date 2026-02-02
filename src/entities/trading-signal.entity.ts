import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum SignalType {
  BUY = 'BUY',
  SELL = 'SELL',
  HOLD = 'HOLD',
}

export enum SignalStrength {
  WEAK = 'WEAK',
  MODERATE = 'MODERATE',
  STRONG = 'STRONG',
  VERY_STRONG = 'VERY_STRONG',
}

@Entity('trading_signals')
@Index(['symbol', 'createdAt'])
@Index(['signalType', 'strength'])
export class TradingSignal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  symbol: string;

  @Column()
  timeframe: string;

  @Column({
    type: 'enum',
    enum: SignalType,
  })
  signalType: SignalType;

  @Column({
    type: 'enum',
    enum: SignalStrength,
  })
  strength: SignalStrength;

  @Column('decimal', { precision: 10, scale: 5 })
  entryPrice: number;

  @Column('decimal', { precision: 10, scale: 5 })
  stopLoss: number;

  @Column('decimal', { precision: 10, scale: 5 })
  takeProfit: number;

  @Column('decimal', { precision: 5, scale: 2 })
  confidence: number;

  // ICT Analysis Data
  @Column('jsonb', { nullable: true })
  ictAnalysis: {
    marketStructure: string;
    orderBlocks: any[];
    fairValueGaps: any[];
    liquidityLevels: any[];
    killZone: string;
    sessionBias: string;
  };

  // OpenAI Analysis
  @Column('text', { nullable: true })
  aiAnalysis: string;

  @Column('text', { nullable: true })
  reasoning: string;

  @Column({ default: false })
  executed: boolean;

  @Column({ nullable: true })
  tradeId: string;

  @CreateDateColumn()
  createdAt: Date;
}
