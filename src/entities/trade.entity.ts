import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum TradeDirection {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum TradeStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
  ERROR = 'ERROR',
}

@Entity('trades')
@Index(['symbol', 'status'])
@Index(['openedAt'])
export class Trade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  mt5Ticket: string;

  @Column()
  symbol: string;

  @Column({
    type: 'enum',
    enum: TradeDirection,
  })
  direction: TradeDirection;

  @Column('decimal', { precision: 10, scale: 5 })
  entryPrice: number;

  @Column('decimal', { precision: 10, scale: 5, nullable: true })
  exitPrice: number;

  @Column('decimal', { precision: 10, scale: 5 })
  stopLoss: number;

  @Column('decimal', { precision: 10, scale: 5 })
  takeProfit: number;

  @Column('decimal', { precision: 10, scale: 2 })
  lotSize: number;

  @Column({
    type: 'enum',
    enum: TradeStatus,
    default: TradeStatus.PENDING,
  })
  status: TradeStatus;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  profit: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  commission: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  swap: number;

  @Column({ nullable: true })
  signalId: string;

  @Column('text', { nullable: true })
  notes: string;

  @Column('jsonb', { nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  openedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  closedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
