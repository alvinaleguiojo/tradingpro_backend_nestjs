import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type MarketSentimentBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN';

export type MarketSentiment = {
  source: 'CFTC_COT';
  market: string;
  symbol: string;
  asOf: string;
  managedMoneyNet: number;
  managedMoneyNetChange: number;
  managedMoneyNetPctOpenInterest: number;
  bias: MarketSentimentBias;
  summary: string;
};

@Injectable()
export class MarketSentimentService {
  private readonly logger = new Logger(MarketSentimentService.name);
  private cache: { sentiment: MarketSentiment | null; fetchedAt: number } = {
    sentiment: null,
    fetchedAt: 0,
  };
  private inFlight?: Promise<void>;

  constructor(private readonly configService: ConfigService) {}

  async getSentiment(symbol: string): Promise<MarketSentiment | null> {
    if (!this.isEnabled()) return null;
    await this.ensureCacheFresh(symbol);
    return this.cache.sentiment;
  }

  private isEnabled(): boolean {
    return this.configService.get('SENTIMENT_ENABLED', 'true') === 'true';
  }

  private async ensureCacheFresh(symbol: string): Promise<void> {
    const ttlMs = this.getCacheTtlMs();
    const now = Date.now();
    if (now - this.cache.fetchedAt < ttlMs) return;
    if (this.inFlight) return;
    this.inFlight = this.refreshCache(symbol)
      .catch((err) => {
        this.logger.warn(`Sentiment refresh failed: ${err?.message || err}`);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    await this.inFlight;
  }

  private async refreshCache(symbol: string): Promise<void> {
    const provider = this.getProvider();
    if (provider !== 'CFTC_COT') {
      this.cache = { sentiment: null, fetchedAt: Date.now() };
      return;
    }

    const marketName = this.resolveMarketName(symbol);
    if (!marketName) {
      this.cache = { sentiment: null, fetchedAt: Date.now() };
      return;
    }

    const url = this.configService.get(
      'SENTIMENT_CFTC_URL',
      'https://www.cftc.gov/dea/newcot/f_disagg.txt',
    );

    const response = await axios.get(url, {
      timeout: this.getRequestTimeoutMs(),
      responseType: 'text',
    });

    const rows = this.parseCsv(String(response.data || '').trim());
    if (rows.length < 2) {
      this.cache = { sentiment: null, fetchedAt: Date.now() };
      return;
    }

    const header = rows[0];
    const dataRows = rows.slice(1);
    const col = (name: string) => this.findColumn(header, name);

    const marketCol = col('Market_and_Exchange_Names');
    const dateCol =
      col('As_of_Date_In_Form_YYYY-MM-DD') ??
      col('As_of_Date_In_Form_MM/DD/YYYY') ??
      col('As_of_Date_In_Form_YYMMDD');
    const openInterestCol = col('Open_Interest_All');
    const mmLongCol = col('M_Money_Positions_Long_All');
    const mmShortCol = col('M_Money_Positions_Short_All');

    if (
      marketCol == null ||
      dateCol == null ||
      openInterestCol == null ||
      mmLongCol == null ||
      mmShortCol == null
    ) {
      this.logger.warn('CFTC COT columns not found in file header');
      this.cache = { sentiment: null, fetchedAt: Date.now() };
      return;
    }

    const filtered = dataRows
      .map((r) => ({
        market: r[marketCol],
        date: this.parseCftcDate(r[dateCol]),
        openInterest: Number(r[openInterestCol] || 0),
        mmLong: Number(r[mmLongCol] || 0),
        mmShort: Number(r[mmShortCol] || 0),
      }))
      .filter((r) => r.market === marketName && r.date)
      .sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));

    if (filtered.length === 0) {
      this.cache = { sentiment: null, fetchedAt: Date.now() };
      return;
    }

    const latest = filtered[filtered.length - 1];
    const prev = filtered.length > 1 ? filtered[filtered.length - 2] : null;
    const net = latest.mmLong - latest.mmShort;
    const prevNet = prev ? prev.mmLong - prev.mmShort : net;
    const netChange = net - prevNet;
    const netPct = latest.openInterest > 0 ? (net / latest.openInterest) * 100 : 0;

    const bias = this.getBias(netPct);
    const summary = `CFTC COT (Managed Money) net ${net.toLocaleString()} (${netPct.toFixed(1)}% OI), ` +
      `weekly change ${netChange >= 0 ? '+' : ''}${netChange.toLocaleString()} → ${bias}`;

    this.cache = {
      sentiment: {
        source: 'CFTC_COT',
        market: marketName,
        symbol,
        asOf: latest.date?.toISOString().slice(0, 10) || 'Unknown',
        managedMoneyNet: net,
        managedMoneyNetChange: netChange,
        managedMoneyNetPctOpenInterest: Number(netPct.toFixed(2)),
        bias,
        summary,
      },
      fetchedAt: Date.now(),
    };
  }

  private getBias(netPct: number): MarketSentimentBias {
    const bull = this.getNetPctBull();
    const bear = this.getNetPctBear();
    if (netPct >= bull) return 'BULLISH';
    if (netPct <= bear) return 'BEARISH';
    return 'NEUTRAL';
  }

  private resolveMarketName(symbol: string): string | null {
    const mapRaw = this.configService.get(
      'SENTIMENT_SYMBOL_MAP',
      'XAUUSDm=GOLD - COMMODITY EXCHANGE INC.',
    );
    const map = new Map<string, string>();
    mapRaw
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .forEach((pair) => {
        const [key, value] = pair.split('=').map((p) => p.trim());
        if (key && value) map.set(key, value);
      });
    return map.get(symbol) || this.configService.get('SENTIMENT_CFTC_MARKET_NAME', '') || null;
  }

  private parseCftcDate(raw: string | undefined): Date | null {
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const d = new Date(`${raw}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
      const [m, d, y] = raw.split('/').map((n) => Number(n));
      const date = new Date(Date.UTC(y, m - 1, d));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (/^\d{6}$/.test(raw)) {
      const y = Number(raw.slice(0, 2)) + 2000;
      const m = Number(raw.slice(2, 4));
      const d = Number(raw.slice(4, 6));
      const date = new Date(Date.UTC(y, m - 1, d));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return null;
  }

  private parseCsv(text: string): string[][] {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.map((line) => this.splitCsvLine(line));
  }

  private splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        const next = line[i + 1];
        if (inQuotes && next === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === ',' && !inQuotes) {
        out.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    out.push(current);
    return out;
  }

  private findColumn(header: string[], name: string): number | null {
    const normalized = header.map((h) => h.trim().toLowerCase());
    const target = name.trim().toLowerCase();
    const idx = normalized.indexOf(target);
    return idx >= 0 ? idx : null;
  }

  private getProvider(): 'CFTC_COT' {
    return 'CFTC_COT';
  }

  private getCacheTtlMs(): number {
    const raw = Number(this.configService.get('SENTIMENT_CACHE_TTL_SECONDS', '21600'));
    return (Number.isFinite(raw) ? raw : 21600) * 1000;
  }

  private getRequestTimeoutMs(): number {
    const raw = Number(this.configService.get('SENTIMENT_REQUEST_TIMEOUT_MS', '5000'));
    return Number.isFinite(raw) ? raw : 5000;
  }

  private getNetPctBull(): number {
    const raw = Number(this.configService.get('SENTIMENT_NET_PCT_BULL', '10'));
    return Number.isFinite(raw) ? raw : 10;
  }

  private getNetPctBear(): number {
    const raw = Number(this.configService.get('SENTIMENT_NET_PCT_BEAR', '-10'));
    return Number.isFinite(raw) ? raw : -10;
  }
}
