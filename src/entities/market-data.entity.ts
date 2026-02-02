import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('market_data')
@Index(['symbol', 'timeframe', 'timestamp'])
export class MarketData {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  symbol: string;

  @Column()
  timeframe: string;

  @Column('decimal', { precision: 10, scale: 5 })
  open: number;

  @Column('decimal', { precision: 10, scale: 5 })
  high: number;

  @Column('decimal', { precision: 10, scale: 5 })
  low: number;

  @Column('decimal', { precision: 10, scale: 5 })
  close: number;

  @Column('bigint')
  volume: number;

  @Column('decimal', { precision: 10, scale: 5, nullable: true })
  spread: number;

  @Column({ type: 'timestamp' })
  timestamp: Date;

  @CreateDateColumn()
  createdAt: Date;
}
