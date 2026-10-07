/**
 * Borne la durée d'une promesse : rejette avec `TimeoutError` après `ms`.
 * La promesse d'origine n'est pas annulée (elle se termine en arrière-plan) mais
 * l'appelant n'attend plus : une requête bloquée ne peut plus figer une boucle.
 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} : pas de réponse après ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'opération'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
