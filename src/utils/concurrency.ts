import os from 'node:os';

/** Default worker count: small, bounded, and enough to hide I/O latency. */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, os.cpus().length));
}

/**
 * Map over `items` with a bounded number of in-flight tasks.
 * Results come back in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
