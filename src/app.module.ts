import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { Mt5Module } from './modules/mt5/mt5.module';
import { TradingModule } from './modules/trading/trading.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { IctStrategyModule } from './modules/ict-strategy/ict-strategy.module';
import { OpenAiModule } from './modules/openai/openai.module';
import { MoneyManagementModule } from './modules/money-management/money-management.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Database
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DATABASE_HOST', 'localhost'),
        port: configService.get('DATABASE_PORT', 5432),
        username: configService.get('DATABASE_USERNAME', 'postgres'),
        password: configService.get('DATABASE_PASSWORD', 'postgres'),
        database: configService.get('DATABASE_NAME', 'tradingpro'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: true, // Set to false in production
        logging: false,
        ssl: configService.get('DATABASE_HOST', '').includes('supabase') 
          ? { rejectUnauthorized: false } 
          : false,
        // Serverless connection pooling settings
        extra: {
          max: 2, // Maximum connections per serverless instance
          min: 0,
          idleTimeoutMillis: 10000,
          connectionTimeoutMillis: 10000,
        },
      }),
    }),

    // Scheduling for cron jobs
    ScheduleModule.forRoot(),

    // Feature modules
    Mt5Module,
    TradingModule,
    AnalysisModule,
    IctStrategyModule,
    OpenAiModule,
    MoneyManagementModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
