import { plainToInstance, Type } from 'class-transformer';
import { Equals, IsDefined, IsISO8601, IsString, Length, ValidateNested, validateSync } from 'class-validator';
import { SubmitWagerTransactionDto } from '../http/wagering.dto.ts';

/** `data` da mensagem: o mesmo contrato do HTTP + a idempotency key, que na fila vem no corpo. */
export class WagerTransactionRequestedData extends SubmitWagerTransactionDto {
  @IsString()
  @Length(1, 512)
  idempotencyKey!: string;
}

/** Envelope `WagerTransactionRequested` (§10). */
export class WagerTransactionRequestedMessage {
  @IsString()
  @Length(1, 256)
  messageId!: string;

  @Equals('WagerTransactionRequested')
  type!: string;

  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => WagerTransactionRequestedData)
  data!: WagerTransactionRequestedData;
}

/** Mensagem que nunca poderá ser processada (JSON inválido, contrato violado): vai para a DLQ. */
export class InvalidMessageError extends Error {
  readonly code = 'INVALID_MESSAGE';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

export function parseWagerMessage(body: string | undefined): WagerTransactionRequestedMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new InvalidMessageError('message body is not valid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new InvalidMessageError('message body must be a JSON object');
  }
  const message = plainToInstance(WagerTransactionRequestedMessage, json);
  const errors = validateSync(message, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    const fields = errors.map((error) => error.property).join(', ');
    throw new InvalidMessageError(`message violates the WagerTransactionRequested contract (${fields})`);
  }
  return message;
}
