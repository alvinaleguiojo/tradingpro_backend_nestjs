import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MoneyManagementLevel } from '../../entities/money-management-level.entity';
import { TradingAccountState } from '../../entities/trading-account-state.entity';
import { Mt5Service } from '../mt5/mt5.service';
import { withRetry } from '../../utils/database.utils';

export interface MoneyLevel {
  level: number;
  balance: number;
  lotSize: number;
  dailyTarget: number;
  weeklyTarget: number;
  monthlyTarget: number;
  completed: boolean;
}

// Default money management levels (same as frontend)
const DEFAULT_LEVELS: MoneyLevel[] = [
  { level: 1, balance: 100.00, lotSize: 0.01, dailyTarget: 3.00, weeklyTarget: 15.00, monthlyTarget: 60.00, completed: false },
  { level: 2, balance: 150.00, lotSize: 0.01, dailyTarget: 4.50, weeklyTarget: 22.50, monthlyTarget: 90.00, completed: false },
  { level: 3, balance: 225.00, lotSize: 0.02, dailyTarget: 6.75, weeklyTarget: 33.75, monthlyTarget: 135.00, completed: false },
  { level: 4, balance: 337.50, lotSize: 0.03, dailyTarget: 10.13, weeklyTarget: 50.63, monthlyTarget: 202.50, completed: false },
  { level: 5, balance: 506.25, lotSize: 0.05, dailyTarget: 15.19, weeklyTarget: 75.94, monthlyTarget: 303.75, completed: false },
  { level: 6, balance: 759.38, lotSize: 0.08, dailyTarget: 22.78, weeklyTarget: 113.91, monthlyTarget: 455.63, completed: false },
  { level: 7, balance: 1139.06, lotSize: 0.12, dailyTarget: 34.17, weeklyTarget: 170.83, monthlyTarget: 683.44, completed: false },
  { level: 8, balance: 1708.59, lotSize: 0.2, dailyTarget: 51.26, weeklyTarget: 256.28, monthlyTarget: 1025.15, completed: false },
  { level: 9, balance: 2562.89, lotSize: 0.3, dailyTarget: 76.89, weeklyTarget: 384.44, monthlyTarget: 1537.78, completed: false },
  { level: 10, balance: 3844.34, lotSize: 0.5, dailyTarget: 115.33, weeklyTarget: 576.67, monthlyTarget: 2306.67, completed: false },
  { level: 11, balance: 5766.51, lotSize: 0.8, dailyTarget: 172.99, weeklyTarget: 864.94, monthlyTarget: 3459.75, completed: false },
  { level: 12, balance: 8649.76, lotSize: 1.3, dailyTarget: 259.49, weeklyTarget: 1297.46, monthlyTarget: 5189.84, completed: false },
  { level: 13, balance: 12974.63, lotSize: 2.0, dailyTarget: 389.24, weeklyTarget: 1946.19, monthlyTarget: 7784.75, completed: false },
  { level: 14, balance: 19461.94, lotSize: 3.0, dailyTarget: 583.86, weeklyTarget: 2919.32, monthlyTarget: 11677.28, completed: false },
  { level: 15, balance: 29192.91, lotSize: 5.0, dailyTarget: 875.79, weeklyTarget: 4378.93, monthlyTarget: 17515.71, completed: false },
  { level: 16, balance: 43789.37, lotSize: 8.0, dailyTarget: 1313.68, weeklyTarget: 6568.42, monthlyTarget: 26273.69, completed: false },
  { level: 17, balance: 65684.05, lotSize: 13.0, dailyTarget: 1970.52, weeklyTarget: 9852.60, monthlyTarget: 39410.40, completed: false },
  { level: 18, balance: 98526.08, lotSize: 20.0, dailyTarget: 2955.78, weeklyTarget: 14778.91, monthlyTarget: 59115.64, completed: false },
  { level: 19, balance: 147789.12, lotSize: 30.0, dailyTarget: 4433.67, weeklyTarget: 22168.36, monthlyTarget: 88673.44, completed: false },
  { level: 20, balance: 221683.68, lotSize: 50.0, dailyTarget: 6650.51, weeklyTarget: 33252.56, monthlyTarget: 133010.24, completed: false },
];

@Injectable()
export class MoneyManagementService implements OnModuleInit {
  private readonly logger = new Logger(MoneyManagementService.name);
  private levels: MoneyLevel[] = DEFAULT_LEVELS;

  constructor(
    private configService: ConfigService,
    @InjectRepository(MoneyManagementLevel)
    private levelRepo: Repository<MoneyManagementLevel>,
    @InjectRepository(TradingAccountState)
    private accountStateRepo: Repository<TradingAccountState>,
    private mt5Service: Mt5Service,
  ) {}

  async onModuleInit() {
    await this.initializeLevels();
  }

  /**
   * Initialize money management levels in database
   */
  private async initializeLevels(): Promise<void> {
    try {
      const existingLevels = await withRetry(
        () => this.levelRepo.find(),
        { operationName: 'Load money management levels', maxRetries: 3 }
      );
      
      if (existingLevels.length === 0) {
        // Seed default levels
        for (const level of DEFAULT_LEVELS) {
          await withRetry(
            () => this.levelRepo.save(this.levelRepo.create(level)),
            { operationName: 'Save money management level', maxRetries: 3 }
          );
        }
        this.logger.log('Money management levels initialized');
      } else {
        // Load from database
        this.levels = existingLevels.map(l => ({
          level: l.level,
          balance: Number(l.balance),
          lotSize: Number(l.lotSize),
          dailyTarget: Number(l.dailyTarget),
          weeklyTarget: Number(l.weeklyTarget),
          monthlyTarget: Number(l.monthlyTarget),
          completed: l.completed,
        }));
      }
    } catch (error) {
      this.logger.warn('Could not initialize levels from database, using defaults');
    }
  }

  /**
   * Get all money management levels
   */
  getAllLevels(): MoneyLevel[] {
    return this.levels;
  }

  /**
   * Get current level based on account balance
   */
  getCurrentLevel(balance: number): MoneyLevel {
    // Find the highest level where balance meets or exceeds the threshold
    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (balance >= this.levels[i].balance) {
        return this.levels[i];
      }
    }
    return this.levels[0]; // Default to level 1
  }

  /**
   * Get the appropriate lot size for current balance
   */
  getLotSizeForBalance(balance: number): number {
    const level = this.getCurrentLevel(balance);
    return level.lotSize;
  }

  /**
   * Get next level target
   */
  getNextLevel(balance: number): MoneyLevel | null {
    const currentLevel = this.getCurrentLevel(balance);
    const nextIndex = this.levels.findIndex(l => l.level === currentLevel.level) + 1;
    
    if (nextIndex < this.levels.length) {
      return this.levels[nextIndex];
    }
    return null; // Already at max level
  }

  /**
   * Calculate progress to next level (0-100%)
   */
  getProgressToNextLevel(balance: number): number {
    const currentLevel = this.getCurrentLevel(balance);
    const nextLevel = this.getNextLevel(balance);
    
    if (!nextLevel) return 100; // Max level reached
    
    const progress = ((balance - currentLevel.balance) / (nextLevel.balance - currentLevel.balance)) * 100;
    return Math.min(Math.max(progress, 0), 100);
  }

  /**
   * Check if daily target is reached
   */
  isDailyTargetReached(balance: number, dailyProfit: number): boolean {
    const currentLevel = this.getCurrentLevel(balance);
    return dailyProfit >= currentLevel.dailyTarget;
  }

  /**
   * Get remaining target for the day
   */
  getRemainingDailyTarget(balance: number, dailyProfit: number): number {
    const currentLevel = this.getCurrentLevel(balance);
    return Math.max(0, currentLevel.dailyTarget - dailyProfit);
  }

  /**
   * Get daily target progress percentage
   */
  getDailyTargetProgress(balance: number, dailyProfit: number): number {
    const currentLevel = this.getCurrentLevel(balance);
    if (currentLevel.dailyTarget <= 0) return 0;
    return Math.min((dailyProfit / currentLevel.dailyTarget) * 100, 100);
  }

  /**
   * Get or create account state
   */
  async getOrCreateAccountState(accountId: string): Promise<TradingAccountState> {
    let state = await withRetry(
      () => this.accountStateRepo.findOne({ where: { accountId } }),
      { operationName: 'Find account state', maxRetries: 3 }
    );
    
    if (!state) {
      // Get balance from MT5
      const accountSummary = await this.mt5Service.getAccountSummary();
      const balance = accountSummary?.balance || 100;
      const level = this.getCurrentLevel(balance);
      
      state = this.accountStateRepo.create({
        accountId,
        initialBalance: balance,
        currentBalance: balance,
        currentLevel: level.level,
        currentLotSize: level.lotSize,
        dailyProfit: 0,
        weeklyProfit: 0,
        monthlyProfit: 0,
        totalProfit: 0,
        lastTradingDay: new Date(),
        weekStartDate: this.getWeekStartDate(),
        monthStartDate: this.getMonthStartDate(),
      });
      
      await withRetry(
        () => this.accountStateRepo.save(state),
        { operationName: 'Save account state', maxRetries: 3 }
      );
      this.logger.log(`Created account state for ${accountId} at level ${level.level}`);
    }
    
    return state;
  }

  /**
   * Update account state after trade
   */
  async updateAccountState(
    accountId: string,
    profit: number,
    newBalance: number,
  ): Promise<TradingAccountState> {
    const state = await this.getOrCreateAccountState(accountId);
    const today = new Date();
    
    // Reset daily profit if new day
    if (!this.isSameDay(state.lastTradingDay, today)) {
      state.dailyProfit = 0;
      state.dailyTargetReached = false;
    }
    
    // Reset weekly profit if new week
    if (!this.isSameWeek(state.weekStartDate, today)) {
      state.weeklyProfit = 0;
      state.weeklyTargetReached = false;
      state.weekStartDate = this.getWeekStartDate();
    }
    
    // Reset monthly profit if new month
    if (!this.isSameMonth(state.monthStartDate, today)) {
      state.monthlyProfit = 0;
      state.monthlyTargetReached = false;
      state.monthStartDate = this.getMonthStartDate();
    }
    
    // Update profits
    state.dailyProfit = Number(state.dailyProfit) + profit;
    state.weeklyProfit = Number(state.weeklyProfit) + profit;
    state.monthlyProfit = Number(state.monthlyProfit) + profit;
    state.totalProfit = Number(state.totalProfit) + profit;
    state.currentBalance = newBalance;
    state.lastTradingDay = today;
    
    // Update level based on new balance
    const newLevel = this.getCurrentLevel(newBalance);
    state.currentLevel = newLevel.level;
    state.currentLotSize = newLevel.lotSize;
    
    // Check targets
    state.dailyTargetReached = this.isDailyTargetReached(newBalance, state.dailyProfit);
    state.weeklyTargetReached = state.weeklyProfit >= newLevel.weeklyTarget;
    state.monthlyTargetReached = state.monthlyProfit >= newLevel.monthlyTarget;
    
    await withRetry(
      () => this.accountStateRepo.save(state),
      { operationName: 'Update account state', maxRetries: 3 }
    );
    
    this.logger.log(
      `Account ${accountId} updated: Balance=$${newBalance}, Level=${newLevel.level}, ` +
      `LotSize=${newLevel.lotSize}, DailyProfit=$${state.dailyProfit}`
    );
    
    return state;
  }

  /**
   * Sync account state with MT5
   */
  async syncWithMt5(accountId: string): Promise<TradingAccountState> {
    const accountSummary = await this.mt5Service.getAccountSummary();
    
    if (!accountSummary) {
      throw new Error('Could not get MT5 account summary');
    }
    
    const state = await this.getOrCreateAccountState(accountId);
    const newBalance = accountSummary.balance;
    const profitDiff = newBalance - Number(state.currentBalance);
    
    if (profitDiff !== 0) {
      return this.updateAccountState(accountId, profitDiff, newBalance);
    }
    
    return state;
  }

  /**
   * Check if should stop trading for the day (target reached)
   * NOTE: Temporarily disabled for testing - always returns false
   */
  shouldStopTradingToday(state: TradingAccountState): { stop: boolean; reason: string } {
    // DISABLED FOR TESTING - uncomment below to re-enable daily limits
    return { stop: false, reason: '' };
    
    /*
    if (state.dailyTargetReached) {
      return { 
        stop: true, 
        reason: `Daily target of $${this.getCurrentLevel(Number(state.currentBalance)).dailyTarget} reached` 
      };
    }
    
    // Optional: Also check if daily loss limit is hit (e.g., -3% of balance)
    const dailyLossLimit = Number(state.currentBalance) * -0.03;
    if (state.dailyProfit <= dailyLossLimit) {
      return {
        stop: true,
        reason: `Daily loss limit of ${dailyLossLimit.toFixed(2)} reached`,
      };
    }
    
    return { stop: false, reason: '' };
    */
  }

  /**
   * Get comprehensive money management status
   */
  async getMoneyManagementStatus(accountId: string): Promise<{
    accountState: TradingAccountState;
    currentLevel: MoneyLevel;
    nextLevel: MoneyLevel | null;
    progressToNextLevel: number;
    dailyTargetProgress: number;
    recommendedLotSize: number;
    shouldStopTrading: { stop: boolean; reason: string };
  }> {
    const state = await this.syncWithMt5(accountId);
    const balance = Number(state.currentBalance);
    const currentLevel = this.getCurrentLevel(balance);
    const nextLevel = this.getNextLevel(balance);
    
    return {
      accountState: state,
      currentLevel,
      nextLevel,
      progressToNextLevel: this.getProgressToNextLevel(balance),
      dailyTargetProgress: this.getDailyTargetProgress(balance, Number(state.dailyProfit)),
      recommendedLotSize: currentLevel.lotSize,
      shouldStopTrading: this.shouldStopTradingToday(state),
    };
  }

  // Helper methods
  private getWeekStartDate(): Date {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    return new Date(now.setDate(diff));
  }

  private getMonthStartDate(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  private isSameDay(date1: Date, date2: Date): boolean {
    if (!date1) return false;
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    return d1.toDateString() === d2.toDateString();
  }

  private isSameWeek(weekStart: Date, date: Date): boolean {
    if (!weekStart) return false;
    const currentWeekStart = this.getWeekStartDate();
    return new Date(weekStart).toDateString() === currentWeekStart.toDateString();
  }

  private isSameMonth(monthStart: Date, date: Date): boolean {
    if (!monthStart) return false;
    const d1 = new Date(monthStart);
    const d2 = new Date(date);
    return d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear();
  }
}
