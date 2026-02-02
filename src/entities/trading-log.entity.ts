import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum TradingEventType {
  SIGNAL_GENERATED = 'SIGNAL_GENERATED',
  TRADE_OPENED = 'TRADE_OPENED',
  TRADE_CLOSED = 'TRADE_CLOSED',
  TRADE_MODIFIED = 'TRADE_MODIFIED',
  CONNECTION_ESTABLISHED = 'CONNECTION_ESTABLISHED',
  CONNECTION_LOST = 'CONNECTION_LOST',
  ERROR = 'ERROR',
  CRON_EXECUTION = 'CRON_EXECUTION',
  MARKET_ANALYSIS = 'MARKET_ANALYSIS',
}

@Entity('trading_logs')
export class TradingLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: TradingEventType,
  })
  eventType: TradingEventType;

  @Column('text')
  message: string;

  @Column('jsonb', { nullable: true })
  data: Record<string, any>;

  @Column({ nullable: true })
  tradeId: string;

  @Column({ nullable: true })
  signalId: string;

  @Column({ default: 'info' })
  level: string;

  @CreateDateColumn()
  createdAt: Date;
}
