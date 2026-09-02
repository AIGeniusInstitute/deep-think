/**
 * Type declaration for the optional 'redis' dependency.
 *
 * The `redis` npm package is an optional peer dependency — only needed when
 * REDIS_URL is set (Phase 2: multi-replica mode). In single-replica mode
 * (Phase 1, the default), redis-client.ts never actually imports it.
 *
 * This declaration lets `tsc --noEmit` pass without installing the package.
 */
declare module 'redis' {
  export interface RedisClientType {
    on(event: string, listener: (...args: any[]) => void): this;
    connect(): Promise<void>;
    publish(channel: string, message: string): Promise<number>;
    subscribe(channel: string, listener: (message: string) => void): Promise<number>;
    set(
      key: string,
      value: string,
      options?: { NX?: boolean; PX?: number },
    ): Promise<string | null>;
    get(key: string): Promise<string | null>;
    del(...keys: string[]): Promise<number>;
    incr(key: string): Promise<number>;
    decr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<boolean>;
    quit(): Promise<void>;
  }

  export function createClient(options: { url: string }): RedisClientType;
}
