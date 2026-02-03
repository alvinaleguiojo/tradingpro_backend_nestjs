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

    // Database - Optimized for Vercel Serverless + Supabase Session Mode
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
          
          // CRITICAL: Configuration for Supabase Transaction Mode (PgBouncer)
          // Transaction mode allows many more concurrent connections
          // IMPORTANT: Use port 6543 (pooler) not 5432 (direct)
          extra: {
            // Single connection per function to avoid transaction conflicts
            max: 1, // Only 1 connection per function instance
            min: 0, // No minimum, create on demand
            
            // Aggressive connection release for serverless
            idleTimeoutMillis: 3000, // Release idle connections after 3 seconds
            connectionTimeoutMillis: 10000, // 10 second connection timeout (more time for cold starts)
            
            // Query timeouts
            statement_timeout: 25000, // 25 second query timeout
            query_timeout: 25000, // 25 second query timeout
            
            // Allow immediate connection release
            allowExitOnIdle: true,
            
            // Acquire timeout - how long to wait for a connection
            acquireTimeoutMillis: 15000, // 15 seconds to acquire connection
            
            // Create timeout for new connections
            createTimeoutMillis: 10000, // 10 seconds to create connection
            
            // Destroy timeout for closing connections
            destroyTimeoutMillis: 3000, // 3 seconds to destroy connection
            
            // Retry settings within pg pool
            createRetryIntervalMillis: 500, // Wait 500ms between connection attempts
            
            // Propagate create error to fail fast
            propagateCreateError: true,
            
            // PgBouncer Transaction Mode compatibility
            application_name: 'tradingpro_backend',
            
            // CRITICAL: Required for PgBouncer Transaction Mode
            // Disables prepared statements which don't work in transaction mode
            prepare: false,
          },
          
          // TypeORM retry settings - faster fail for serverless
          retryAttempts: 3, // Fewer retries to fail fast
          retryDelay: 1000, // 1 second between retries
          
          // Minimal pool size
          poolSize: 1,
          connectTimeoutMS: 5000,
          
          // Cache to reduce DB calls
          cache: {
            duration: 10000, // Cache queries for 10 seconds
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
