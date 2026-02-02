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

    // Database - Optimized for Vercel Serverless + Supabase
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isProduction = configService.get('NODE_ENV') === 'production';
        const dbHost = configService.get('DATABASE_HOST', 'localhost');
        const isSupabase = dbHost.includes('supabase') || dbHost.includes('pooler');
        
        return {
          type: 'postgres',
          host: dbHost,
          port: configService.get('DATABASE_PORT', 5432),
          username: configService.get('DATABASE_USERNAME', 'postgres'),
          password: configService.get('DATABASE_PASSWORD', 'postgres'),
          database: configService.get('DATABASE_NAME', 'tradingpro'),
          entities: [__dirname + '/**/*.entity{.ts,.js}'],
          synchronize: !isProduction, // Disabled in production
          logging: false,
          ssl: isSupabase ? { rejectUnauthorized: false } : false,
          
          // Connection pool settings optimized for serverless
          extra: {
            // Connection pool size
            max: 3, // Small pool for serverless, but allow some concurrency
            min: 0, // No minimum, connections will be created on demand
            
            // Connection lifecycle
            idleTimeoutMillis: 10000, // Close idle connections after 10s
            connectionTimeoutMillis: 15000, // 15 second connection timeout
            
            // Query timeouts
            statement_timeout: 30000, // 30 second query timeout
            query_timeout: 30000, // 30 second query timeout
            
            // Keep-alive settings for connection stability
            keepAlive: true,
            keepAliveInitialDelayMillis: 5000,
            
            // Connection validation
            allowExitOnIdle: true, // Allow process to exit even with idle connections
          },
          
          // TypeORM retry settings
          retryAttempts: 5, // More retries for transient failures
          retryDelay: 1000, // 1 second between retries
          
          // Auto-reconnect on connection loss
          autoLoadEntities: false, // Already using entities array
          
          // Connection pooling behavior
          poolSize: 3,
          connectTimeoutMS: 15000,
          
          // Cache settings to reduce DB calls
          cache: {
            duration: 5000, // Cache queries for 5 seconds
          },
        };
      },
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
