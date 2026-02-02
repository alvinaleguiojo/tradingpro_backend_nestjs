import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('trading_account_state')
export class TradingAccountState {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  accountId: string;

  @Column('decimal', { precision: 15, scale: 2 })
  initialBalance: number;

  @Column('decimal', { precision: 15, scale: 2 })
  currentBalance: number;

  @Column()
  currentLevel: number;

  @Column('decimal', { precision: 10, scale: 2 })
  currentLotSize: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  dailyProfit: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  weeklyProfit: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  monthlyProfit: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  totalProfit: number;

  @Column({ type: 'date', nullable: true })
  lastTradingDay: Date;

  @Column({ type: 'date', nullable: true })
  weekStartDate: Date;

  @Column({ type: 'date', nullable: true })
  monthStartDate: Date;

  @Column({ default: false })
  dailyTargetReached: boolean;

  @Column({ default: false })
  weeklyTargetReached: boolean;

  @Column({ default: false })
  monthlyTargetReached: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
