export class ConcurrencyHelper {
  static chunk<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));

    return chunks;
  }

  // `limit` lanes pull items from a shared index, so at most `limit` workers run at once.
  static async run<T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const lane = async () => {
      while (next < items.length) await worker(items[next++]!);
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  }
}
