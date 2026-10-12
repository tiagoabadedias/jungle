import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { MoneyDto } from '../../../shared/infrastructure/http/money.dto.ts';
import { SUBMITTABLE_KINDS } from '../../domain/wager-transaction-kind.ts';

/** Corpo de `POST /wagering/transactions` (§9). OPENING é interno e fica fora de `kind`. */
export class SubmitWagerTransactionDto {
  @IsString()
  @Length(1, 128)
  providerId!: string;

  @IsString()
  @Length(1, 256)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @Length(1, 256)
  roundId!: string;

  @IsString()
  @Length(1, 256)
  gameId!: string;

  @IsIn(SUBMITTABLE_KINDS)
  kind!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  referenceExternalTransactionId?: string;
}

/** `Idempotency-Key` é obrigatório e a fonte da verdade (§9). Header ausente ou inválido → 400. */
function parseIdempotencyKey(value: unknown): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new BadRequestException('Idempotency-Key header is required');
  }
  if (key.length > 512 || key !== key.trim()) {
    throw new BadRequestException('Idempotency-Key must have up to 512 characters without surrounding spaces');
  }
  return key;
}

export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  return parseIdempotencyKey(request.headers['idempotency-key']);
});
