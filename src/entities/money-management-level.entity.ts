import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('money_management_levels')
export class MoneyManagementLevel {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  level: number;

  @Column('decimal', { precision: 15, scale: 2 })
  balance: number;

  @Column('decimal', { precision: 10, scale: 2 })
  lotSize: number;

  @Column('decimal', { precision: 10, scale: 2 })
  dailyTarget: number;

  @Column('decimal', { precision: 10, scale: 2 })
  weeklyTarget: number;

  @Column('decimal', { precision: 10, scale: 2 })
  monthlyTarget: number;

  @Column({ default: false })
  completed: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
