/** Gera identificadores únicos (UUID v7 na implementação de infraestrutura). */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
