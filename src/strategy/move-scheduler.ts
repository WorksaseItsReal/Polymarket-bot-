/**
 * move-scheduler.ts — transforme les événements « le spot a bougé » en évaluations de
 * la stratégie, sans rafale : regroupement court (debounce), au plus une évaluation par
 * coin toutes les `minIntervalMs`, et nouvel essai si la stratégie était occupée.
 */
export interface MoveSchedulerOptions {
  /** Lance une évaluation pour ces coins ; false = occupé, rien n'a été fait. */
  run: (coins: string[]) => Promise<boolean>;
  minIntervalMs?: number;
  debounceMs?: number;
  retryMs?: number;
  now?: () => number;
}

export class MoveScheduler {
  private readonly pending = new Set<string>();
  private readonly lastRun = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly o: Required<MoveSchedulerOptions>;

  constructor(opts: MoveSchedulerOptions) {
    this.o = { minIntervalMs: 1500, debounceMs: 200, retryMs: 500, now: Date.now, ...opts };
  }

  onMove(coin: string): void {
    if (this.stopped) return;
    this.pending.add(coin);
    this.arm(this.o.debounceMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private arm(ms: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => { void this.flush(); }, ms);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const now = this.o.now();
    const coins = [...this.pending].filter(c => now - (this.lastRun.get(c) ?? -Infinity) >= this.o.minIntervalMs);
    if (coins.length) {
      coins.forEach(c => { this.pending.delete(c); this.lastRun.set(c, now); });
      let ran = false;
      try {
        ran = await this.o.run(coins);
      } catch {
        ran = true; // la stratégie gère ses erreurs ; on ne boucle pas sur une exception
      }
      if (!ran) coins.forEach(c => { this.pending.add(c); this.lastRun.delete(c); });
    }
    if (this.pending.size) this.arm(this.o.retryMs);
  }
}
