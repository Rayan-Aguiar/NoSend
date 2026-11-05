// Buffer circular simples: mantém os `limit` itens mais recentes em ordem de inserção.
export class RingBuffer<T> {
  private items: T[] = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  push(x: T): void {
    this.items.push(x);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  setLimit(n: number): void {
    this.limit = Math.max(1, Math.floor(n));
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
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
