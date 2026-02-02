import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('mt5_connections')
export class Mt5Connection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  accountId: string;

  @Column({ type: 'text', nullable: true })
  token: string | null;

  @Column()
  user: string;

  @Column({ type: 'text', nullable: true })
  password: string | null;

  @Column()
  host: string;

  @Column()
  port: number;

  @Column({ default: false })
  isConnected: boolean;

  @Column('decimal', { precision: 15, scale: 2, nullable: true })
  balance: number;

  @Column('decimal', { precision: 15, scale: 2, nullable: true })
  equity: number;

  @Column('decimal', { precision: 15, scale: 2, nullable: true })
  freeMargin: number;

  @Column({ nullable: true })
  leverage: string;

  @Column({ nullable: true })
  currency: string;

  @Column({ nullable: true })
  serverName: string;

  @Column({ type: 'timestamp', nullable: true })
  lastConnectedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
