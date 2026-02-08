export class EaSyncAccountDto {
  balance: number;
  equity: number;
  freeMargin: number;
  margin?: number;
  leverage: number;
  currency: string;
}

export class EaSyncQuoteDto {
  bid: number;
  ask: number;
  time: string;
}

export class EaSyncCandleDto {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
}

export class EaSyncPositionDto {
  ticket: string;
  symbol: string;
  type: string;
  volume: number;
  openPrice: number;
  stopLoss: number;
  takeProfit: number;
  profit: number;
  openTime: string;
  comment?: string;
}

export class EaSyncExecutionResultDto {
  commandId: string;
  success?: boolean;
  ticket?: string;
  price?: number;
  error?: string;
}

export class EaSyncRequestDto {
  accountId: string;
  symbol: string;
  account: EaSyncAccountDto;
  quote: EaSyncQuoteDto;
  candles: EaSyncCandleDto[];
  positions: EaSyncPositionDto[];
  executionResults?: EaSyncExecutionResultDto[];
  eaVersion?: string;
}
