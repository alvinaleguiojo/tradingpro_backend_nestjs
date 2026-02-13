import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

type NewsEvent = {
  id: string;
  date: Date;
  country?: string;
  currency?: string;
  event?: string;
  importance: number;
};

@Injectable()
export class NewsCalendarService {
  private readonly logger = new Logger(NewsCalendarService.name);
  private cache: { events: NewsEvent[]; fetchedAt: number } = { events: [], fetchedAt: 0 };
  private inFlight?: Promise<void>;

  constructor(private readonly configService: ConfigService) {}

  isHighImpactWindow(now: Date = new Date()): boolean {
    if (!this.isEnabled()) return false;
    this.ensureCacheFresh();
    const window = this.getWindowMs();
    return this.cache.events.some((e) => {
      const t = e.date.getTime();
      return t >= now.getTime() - window.before && t <= now.getTime() + window.after;
    });
  }

  getActiveHighImpactEvents(now: Date = new Date()): NewsEvent[] {
    if (!this.isEnabled()) return [];
    this.ensureCacheFresh();
    const window = this.getWindowMs();
    return this.cache.events.filter((e) => {
      const t = e.date.getTime();
      return t >= now.getTime() - window.before && t <= now.getTime() + window.after;
    });
  }

  private isEnabled(): boolean {
    return this.configService.get('NEWS_ENABLED', 'true') === 'true';
  }

  private ensureCacheFresh(): void {
    const ttlMs = this.getCacheTtlMs();
    const now = Date.now();
    if (now - this.cache.fetchedAt < ttlMs) return;
    if (this.inFlight) return;
    this.inFlight = this.refreshCache()
      .catch((err) => {
        this.logger.warn(`News calendar refresh failed: ${err?.message || err}`);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
  }

  private async refreshCache(): Promise<void> {
    const provider = this.getProvider();
    if (provider === 'TRADING_ECONOMICS') {
      await this.refreshFromTradingEconomics();
      return;
    }

    await this.refreshFromForexFactory();
  }

  private async refreshFromForexFactory(): Promise<void> {
    const url = this.configService.get(
      'NEWS_FF_URL',
      'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    );

    const response = await axios.get(url, {
      timeout: this.getRequestTimeoutMs(),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const events = Array.isArray(response.data)
      ? response.data
      : Array.isArray(response.data?.calendar)
        ? response.data.calendar
        : [];

    const now = Date.now();
    const lookaheadMs = this.getLookaheadHours() * 60 * 60 * 1000;
    const from = now - lookaheadMs;
    const to = now + lookaheadMs;

    const parsed = events
      .map((e) => this.parseEvent(e))
      .filter((e): e is NewsEvent => !!e)
      .filter((e) => {
        const t = e.date.getTime();
        return t >= from && t <= to;
      })
      .filter((e) => this.matchesFilters(e));

    this.cache = { events: parsed, fetchedAt: Date.now() };
  }

  private async refreshFromTradingEconomics(): Promise<void> {
    const apiKey = this.configService.get('NEWS_TE_API_KEY', '').trim();
    if (!apiKey) {
      this.logger.warn('NEWS_TE_API_KEY is not set - news calendar disabled');
      this.cache = { events: [], fetchedAt: Date.now() };
      return;
    }

    const baseUrl = this.configService.get('NEWS_TE_BASE_URL', 'https://api.tradingeconomics.com');
    const countries = this.getCountriesParam();
    const importance = this.getImportanceThreshold();

    const url = countries
      ? `${baseUrl}/calendar/country/${encodeURIComponent(countries)}`
      : `${baseUrl}/calendar`;

    const response = await axios.get(url, {
      params: {
        c: apiKey,
        importance,
      },
      timeout: this.getRequestTimeoutMs(),
    });

    const events = Array.isArray(response.data) ? response.data : [];
    const now = Date.now();
    const lookaheadMs = this.getLookaheadHours() * 60 * 60 * 1000;
    const from = now - lookaheadMs;
    const to = now + lookaheadMs;

    const parsed = events
      .map((e) => this.parseEvent(e))
      .filter((e): e is NewsEvent => !!e)
      .filter((e) => {
        const t = e.date.getTime();
        return t >= from && t <= to;
      })
      .filter((e) => this.matchesFilters(e));

    this.cache = { events: parsed, fetchedAt: Date.now() };
  }

  private parseEvent(raw: any): NewsEvent | null {
    const date = this.parseEventDate(raw);
    if (!date) return null;

    const importanceRaw = raw?.Importance ?? raw?.importance ?? raw?.impact;
    const importance = this.normalizeImportance(importanceRaw);
    if (importance < this.getImportanceThreshold()) return null;

    return {
      id: String(raw?.CalendarId ?? raw?.Id ?? raw?.id ?? `${raw?.Event || raw?.title}-${date.toISOString()}`),
      date,
      country: raw?.Country ?? raw?.country,
      currency: raw?.Currency ?? raw?.currency,
      event: raw?.Event ?? raw?.event ?? raw?.title,
      importance,
    };
  }

  private parseEventDate(raw: any): Date | null {
    const timestamp = raw?.timestamp ?? raw?.Timestamp ?? raw?.ts;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const datetime = raw?.Date || raw?.date || raw?.Datetime || raw?.datetime;
    if (datetime && typeof datetime === 'string' && datetime.includes('T')) {
      const d = new Date(datetime);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const datePart = raw?.date ?? raw?.Date;
    const timePart = raw?.time ?? raw?.Time ?? raw?.timeLabel;
    if (!datePart || !timePart || typeof datePart !== 'string' || typeof timePart !== 'string') {
      return null;
    }

    return this.parseDateTimeLocal(datePart, timePart);
  }

  private parseDateTimeLocal(datePart: string, timePart: string): Date | null {
    if (/all day|tentative/i.test(timePart)) return null;

    const [monthStr, dayStr, yearStr] = datePart.trim().split(/\s+/);
    const month = this.parseMonth(monthStr);
    const day = Number(dayStr);
    const year = Number(yearStr);
    if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;

    const timeMatch = timePart.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
    if (!timeMatch) return null;
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || '0');
    const meridian = timeMatch[3].toLowerCase();
    if (meridian === 'pm' && hour < 12) hour += 12;
    if (meridian === 'am' && hour === 12) hour = 0;

    const offsetHours = this.getTimezoneOffsetHours();
    const utc = Date.UTC(year, month - 1, day, hour - offsetHours, minute, 0, 0);
    const d = new Date(utc);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private parseMonth(monthStr: string): number | null {
    const map: Record<string, number> = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };
    const key = monthStr.slice(0, 3).toLowerCase();
    return map[key] || null;
  }

  private normalizeImportance(value: any): number {
    if (typeof value === 'number') return value;
    const str = String(value || '').toLowerCase();
    if (str === 'high') return 3;
    if (str === 'medium') return 2;
    if (str === 'low') return 1;
    if (str === 'high impact expected') return 3;
    if (str === 'med impact expected') return 2;
    if (str === 'low impact expected') return 1;
    const parsed = Number(str);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private getCountriesParam(): string {
    const raw = this.configService.get('NEWS_COUNTRIES', '').trim();
    if (!raw) return '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(',');
  }

  private getImportanceThreshold(): number {
    const raw = this.configService.get('NEWS_IMPORTANCE', '3');
    return this.normalizeImportance(raw) || 3;
  }

  private getLookaheadHours(): number {
    const raw = Number(this.configService.get('NEWS_LOOKAHEAD_HOURS', '48'));
    return Number.isFinite(raw) ? raw : 48;
  }

  private getCacheTtlMs(): number {
    const raw = Number(this.configService.get('NEWS_CACHE_TTL_SECONDS', '300'));
    return (Number.isFinite(raw) ? raw : 300) * 1000;
  }

  private getRequestTimeoutMs(): number {
    const raw = Number(this.configService.get('NEWS_REQUEST_TIMEOUT_MS', '4000'));
    return Number.isFinite(raw) ? raw : 4000;
  }

  private getWindowMs(): { before: number; after: number } {
    const before = Number(this.configService.get('NEWS_PRE_MINUTES', '30'));
    const after = Number(this.configService.get('NEWS_POST_MINUTES', '15'));
    return {
      before: (Number.isFinite(before) ? before : 30) * 60 * 1000,
      after: (Number.isFinite(after) ? after : 15) * 60 * 1000,
    };
  }

  private getProvider(): 'FOREX_FACTORY' | 'TRADING_ECONOMICS' {
    const raw = (this.configService.get('NEWS_PROVIDER', 'FOREX_FACTORY') || '').toUpperCase();
    return raw === 'TRADING_ECONOMICS' ? 'TRADING_ECONOMICS' : 'FOREX_FACTORY';
  }

  private getTimezoneOffsetHours(): number {
    const raw = Number(this.configService.get('NEWS_TIMEZONE_OFFSET_HOURS', '0'));
    return Number.isFinite(raw) ? raw : 0;
  }

  private matchesFilters(event: NewsEvent): boolean {
    const countries = this.getCountriesParam();
    if (!countries) return true;
    const set = new Set(countries.split(',').map((c) => c.trim()));
    if (event.currency && set.has(event.currency)) return true;
    if (event.country && set.has(event.country)) return true;
    return false;
  }
}
