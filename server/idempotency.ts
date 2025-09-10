export class IdempotencyCache {
  private cache = new Map<string, unknown>();

  private keyFor(idempotencyKey: string | undefined, toolName: string, args: unknown) {
    return `${idempotencyKey ?? ''}::${toolName}::${JSON.stringify(args)}`;
  }

  get(idempotencyKey: string | undefined, toolName: string, args: unknown) {
    const k = this.keyFor(idempotencyKey, toolName, args);
    return this.cache.get(k);
  }

  set(idempotencyKey: string | undefined, toolName: string, args: unknown, value: unknown) {
    const k = this.keyFor(idempotencyKey, toolName, args);
    this.cache.set(k, value);
  }
}
