// Buffer circular simples: mantém os `limit` itens mais recentes em ordem de inserção.
export class RingBuffer<T> {
  private items: T[] = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Insere e devolve os itens descartados por excesso. */
  push(x: T): T[] {
    this.items.push(x);
    return this.trim();
  }

  /** Ajusta o limite e devolve os itens descartados por excesso. */
  setLimit(n: number): T[] {
    this.limit = Math.max(1, Math.floor(n));
    return this.trim();
  }

  private trim(): T[] {
    return this.items.length > this.limit ? this.items.splice(0, this.items.length - this.limit) : [];
  }

  toArray(): T[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}
