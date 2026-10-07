/**
 * telegram.ts — client Telegram minimal et robuste pour les notifications du bot.
 *
 * - `check()` vérifie le token (getMe) ET le chat (getChat) et renvoie un diagnostic
 *   lisible : token invalide, chat introuvable (« envoie /start au bot »), bot bloqué…
 * - `send()` met les messages en file : un envoi à la fois, ≥ 1,1 s d'écart (limite
 *   Telegram ≈ 1 msg/s par chat), respect de `retry_after` sur HTTP 429, 3 essais sur
 *   erreur réseau, repli en texte brut si le HTML est refusé, découpe à 4096 caractères.
 * - Le token n'apparaît JAMAIS dans un message d'erreur ou un log.
 * - Aucun envoi ne peut faire planter ni bloquer le bot : tout est asynchrone et capturé.
 */

export interface TelegramOptions {
  token: string;
  chatId: string;
  /** Écart minimal entre deux envois (ms). */
  minIntervalMs?: number;
  /** Taille max de la file (les plus anciens messages sont abandonnés au-delà). */
  maxQueue?: number;
  /** Injection pour les tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Journal (les erreurs sont déjà expurgées du token). */
  log?: (level: 'INFO' | 'WARN' | 'ERROR', msg: string) => void;
}

export interface TelegramCheck {
  ok: boolean;
  detail: string;
  botUsername?: string;
}

const MAX_LEN = 4096;
const API = 'https://api.telegram.org';

/** Lit la config depuis l'environnement. null si Telegram n'est pas configuré/activé. */
export function telegramConfigFromEnv(env: Record<string, string | undefined>): { token: string; chatId: string } | null {
  if ((env.TELEGRAM_ENABLED ?? '').toLowerCase() === 'false') return null;
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** Forme d'un token BotFather : `<id numérique>:<35 caractères>`. */
export function looksLikeBotToken(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token);
}

/** Découpe un texte trop long en morceaux ≤ 4096, de préférence sur un saut de ligne. */
export function splitMessage(text: string, max = MAX_LEN): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Retire les balises HTML et décode les entités de base (repli texte brut). */
export function htmlToPlain(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

interface TgResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  /** true si la réponse ne vient pas de l'API Telegram (corps non JSON : proxy, pare-feu). */
  foreign?: boolean;
  result?: { username?: string; title?: string; first_name?: string; type?: string };
}

export class TelegramClient {
  private readonly token: string;
  private readonly chatId: string;
  private readonly minIntervalMs: number;
  private readonly maxQueue: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (level: 'INFO' | 'WARN' | 'ERROR', msg: string) => void;
  private queue: string[] = [];
  private draining: Promise<void> | null = null;
  private lastSentAt = 0;
  /** Compteurs exposés pour le diagnostic. */
  readonly stats = { sent: 0, failed: 0, dropped: 0 };

  constructor(opts: TelegramOptions) {
    this.token = opts.token;
    this.chatId = opts.chatId;
    this.minIntervalMs = opts.minIntervalMs ?? 1100;
    this.maxQueue = opts.maxQueue ?? 50;
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.log = opts.log ?? (() => undefined);
  }

  /** Remplace toute occurrence du token par `***` (une URL d'erreur peut le contenir). */
  private redact(s: string): string {
    return this.token ? s.split(this.token).join('***') : s;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<TgResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let json: TgResponse;
      try {
        json = (await res.json()) as TgResponse;
      } catch {
        json = { ok: false, error_code: res.status, description: `réponse non-Telegram (HTTP ${res.status})`, foreign: true };
      }
      if (!json.ok && json.error_code === undefined) json.error_code = res.status;
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Vérifie token + chat. Ne lève jamais. */
  async check(): Promise<TelegramCheck> {
    if (!looksLikeBotToken(this.token)) {
      return { ok: false, detail: 'TELEGRAM_BOT_TOKEN mal formé (attendu « 123456789:ABC… » fourni par @BotFather)' };
    }
    try {
      const me = await this.call('getMe', {});
      if (!me.ok && me.foreign) {
        return { ok: false, detail: `api.telegram.org bloqué sur ce serveur (HTTP ${me.error_code} hors Telegram) : pare-feu ou proxy à ouvrir` };
      }
      if (!me.ok) {
        return {
          ok: false,
          detail: me.error_code === 401 || me.error_code === 404
            ? 'token refusé par Telegram (401) : régénère-le avec @BotFather et mets à jour TELEGRAM_BOT_TOKEN'
            : `getMe en échec (${me.error_code ?? '?'}) : ${this.redact(me.description ?? 'erreur inconnue')}`,
        };
      }
      const username = me.result?.username;
      const chat = await this.call('getChat', { chat_id: this.chatId });
      if (!chat.ok) {
        const desc = (chat.description ?? '').toLowerCase();
        let detail = `chat ${this.chatId} inaccessible (${chat.error_code ?? '?'}) : ${this.redact(chat.description ?? '')}`;
        if (desc.includes('chat not found')) {
          detail = `chat ${this.chatId} introuvable : ouvre Telegram, envoie /start à @${username ?? 'ton_bot'} `
            + '(ou ajoute-le au groupe), puis vérifie TELEGRAM_CHAT_ID (un groupe commence par -100…)';
        } else if (chat.error_code === 403) {
          detail = `le bot @${username ?? '?'} est bloqué ou n'est plus membre du chat ${this.chatId} : débloque-le / ré-ajoute-le`;
        }
        return { ok: false, detail, botUsername: username };
      }
      const name = chat.result?.title ?? chat.result?.first_name ?? this.chatId;
      return { ok: true, detail: `connecté : @${username} → « ${name} » (${chat.result?.type ?? 'chat'})`, botUsername: username };
    } catch (err) {
      return { ok: false, detail: `api.telegram.org injoignable : ${this.redact(String((err as Error)?.message ?? err)).slice(0, 160)}` };
    }
  }

  /** Met un message (HTML Telegram) en file. Ne lève jamais, ne bloque pas l'appelant. */
  send(html: string): void {
    for (const part of splitMessage(html)) {
      if (this.queue.length >= this.maxQueue) {
        this.queue.shift();
        this.stats.dropped++;
      }
      this.queue.push(part);
    }
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
  }

  /** Attend que la file soit vide (arrêt propre, tests). */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const text = this.queue.shift() as string;
      const wait = this.lastSentAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      await this.deliver(text);
      this.lastSentAt = Date.now();
    }
  }

  private async deliver(text: string): Promise<void> {
    let html = true;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await this.call('sendMessage', {
          chat_id: this.chatId,
          text: html ? text : htmlToPlain(text),
          ...(html ? { parse_mode: 'HTML' } : {}),
          disable_web_page_preview: true,
        });
        if (r.ok) {
          this.stats.sent++;
          return;
        }
        if (r.error_code === 429) {
          const s = Math.min(60, Math.max(1, r.parameters?.retry_after ?? 5));
          await this.sleep(s * 1000);
          continue;
        }
        if (r.foreign || (r.error_code ?? 0) >= 500) {
          // Panne passagère (5xx, passerelle) : même traitement qu'une erreur réseau.
          throw new Error(r.description ?? `HTTP ${r.error_code}`);
        }
        if (r.error_code === 400 && html && /parse entities|can't parse/i.test(r.description ?? '')) {
          html = false; // HTML refusé → on renvoie le même contenu en texte brut
          continue;
        }
        this.stats.failed++;
        this.log('WARN', `Telegram : message refusé (${r.error_code ?? '?'}) ${this.redact(r.description ?? '')}`.slice(0, 240));
        return; // erreur définitive (chat introuvable, bot bloqué…) : inutile d'insister
      } catch (err) {
        if (attempt === 4) {
          this.stats.failed++;
          this.log('WARN', `Telegram injoignable après 4 essais : ${this.redact(String((err as Error)?.message ?? err))}`.slice(0, 240));
          return;
        }
        await this.sleep(1000 * 2 ** (attempt - 1));
      }
    }
    this.stats.failed++;
    this.log('WARN', 'Telegram : abandon du message après plusieurs limitations de débit (429)');
  }
}
