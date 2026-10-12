import { Type } from 'class-transformer';
import { IsDefined, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import { MoneyDto } from '../../../shared/infrastructure/http/money.dto.ts';
import { LEDGER_PAGE_MAX } from '../../application/wallet-queries.use-case.ts';

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class LedgerQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,512}$/, { message: 'cursor is malformed' })
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LEDGER_PAGE_MAX)
  limit?: number;
}
