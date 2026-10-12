import type { Wallet } from '../../domain/wallet.ts';

export interface WalletRepository {
  /** Lê e trava a linha da wallet até o fim da transação (`SELECT … FOR UPDATE`). */
  lockForUpdate(walletId: string): Promise<Wallet | undefined>;
  /** Lê com lock compartilhado (`FOR SHARE`): snapshot consistente para reconciliação. */
  lockForShare(walletId: string): Promise<Wallet | undefined>;
  findById(walletId: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** Persiste saldo e version; `expectedVersion` é a version lida antes da alteração. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}
