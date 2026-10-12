import { IsString, Matches } from 'class-validator';

/**
 * Contrato monetário (§6.1): `amount` é string decimal com exatamente 2 casas, nunca number.
 * A validação definitiva acontece em `Money.from`; aqui o erro sai cedo com mensagem clara.
 */
export class MoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d*)\.\d{2}$/, { message: 'amount must be a non-negative decimal string with 2 decimal places, e.g. "25.00"' })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code with 3 uppercase letters' })
  currency!: string;
}
