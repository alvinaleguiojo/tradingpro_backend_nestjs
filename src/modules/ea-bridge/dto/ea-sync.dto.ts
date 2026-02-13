import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EaSyncAccountDto {
  @IsNumber()
  balance: number;

  @IsNumber()
  equity: number;

  @IsNumber()
  freeMargin: number;

  @IsOptional()
  @IsNumber()
  margin?: number;

  @IsNumber()
  leverage: number;

  @IsString()
  currency: string;
}

export class EaSyncQuoteDto {
  @IsNumber()
  bid: number;

  @IsNumber()
  ask: number;

  @IsString()
  time: string;
}

export class EaSyncCandleDto {
  @IsString()
  time: string;

  @IsNumber()
  open: number;

  @IsNumber()
  high: number;

  @IsNumber()
  low: number;

  @IsNumber()
  close: number;

  @IsNumber()
  tickVolume: number;
}

export class EaSyncPositionDto {
  @IsString()
  ticket: string;

  @IsString()
  symbol: string;

  @IsString()
  type: string;

  @IsNumber()
  volume: number;

  @IsNumber()
  openPrice: number;

  @IsNumber()
  stopLoss: number;

  @IsNumber()
  takeProfit: number;

  @IsNumber()
  profit: number;

  @IsString()
  openTime: string;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class EaSyncExecutionResultDto {
  @IsString()
  commandId: string;

  @IsOptional()
  @IsBoolean()
  success?: boolean;

  @IsOptional()
  @IsString()
  ticket?: string;

  @IsOptional()
  @IsNumber()
  price?: number;

  @IsOptional()
  @IsString()
  error?: string;
}

export class EaSyncClosedDealDto {
  @IsString()
  ticket: string;

  @IsOptional()
  @IsString()
  positionTicket?: string;

  @IsString()
  symbol: string;

  @IsString()
  type: string;

  @IsNumber()
  volume: number;

  @IsNumber()
  closePrice: number;

  @IsNumber()
  profit: number;

  @IsOptional()
  @IsNumber()
  commission?: number;

  @IsOptional()
  @IsNumber()
  swap?: number;

  @IsString()
  closeTime: string;
}

export class EaSyncRequestDto {
  @IsString()
  accountId: string;

  @IsString()
  symbol: string;

  @ValidateNested()
  @Type(() => EaSyncAccountDto)
  account: EaSyncAccountDto;

  @ValidateNested()
  @Type(() => EaSyncQuoteDto)
  quote: EaSyncQuoteDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EaSyncCandleDto)
  candles: EaSyncCandleDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EaSyncPositionDto)
  positions: EaSyncPositionDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EaSyncExecutionResultDto)
  executionResults?: EaSyncExecutionResultDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EaSyncClosedDealDto)
  closedDeals?: EaSyncClosedDealDto[];

  @IsOptional()
  @IsString()
  eaVersion?: string;
}
