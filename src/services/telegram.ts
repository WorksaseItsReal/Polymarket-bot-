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
 * - `startPolling()` écoute les commandes (/status…) du SEUL chat configuré, par long polling
 *   (getUpdates) : jamais bloquant, reprise après erreur réseau, conflit 409 signalé une fois.
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
  /** Échec passager (réseau, panne serveur) : réessayer plus tard a un sens. Un token
   *  refusé ou un chat introuvable ne se corrige pas tout seul. */
  retryable?: boolean;
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
  result?: unknown;
}

interface TgChatLike { username?: string; title?: string; first_name?: string; type?: string }
interface TgUpdate {
  update_id: number;
  message?: { message_id?: number; date?: number; text?: string; chat?: { id?: number | string; type?: string }; from?: { username?: string; first_name?: string } };
}

/** Message reçu dans le chat configuré (commande de l'opérateur). */
export interface TelegramIncoming {
  text: string;
  chatId: string;
  /** Horodatage Telegram (s). */
  date: number;
  from?: string;
}
export type TelegramCommandHandler = (msg: TelegramIncoming) => string | null | Promise<string | null>;

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
  private polling = false;
  private pollOffset = 0;
  private conflictLoggedAt = -Infinity;
  private foreignLoggedAt = -Infinity;
  /** Type du chat configuré (private, group, supergroup…), connu après `check()`. */
  chatType: string | null = null;
  /** Compteurs exposés pour le diagnostic. */
  readonly stats = { sent: 0, failed: 0, dropped: 0, commands: 0 };

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

  private async call(method: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<TgResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        return { ok: false, retryable: true, detail: `api.telegram.org bloqué sur ce serveur (HTTP ${me.error_code} hors Telegram) : pare-feu ou proxy à ouvrir` };
      }
      if (!me.ok) {
        return {
          ok: false,
          retryable: (me.error_code ?? 0) >= 500 || me.error_code === 429,
          detail: me.error_code === 401 || me.error_code === 404
            ? `token refusé par Telegram (${me.error_code}) : régénère-le avec @BotFather et mets à jour TELEGRAM_BOT_TOKEN`
            : `getMe en échec (${me.error_code ?? '?'}) : ${this.redact(me.description ?? 'erreur inconnue')}`,
        };
      }
      const username = (me.result as TgChatLike | undefined)?.username;
      const chat = await this.call('getChat', { chat_id: this.chatId });
      const chatRes = chat.result as TgChatLike | undefined;
      if (!chat.ok) {
        const desc = (chat.description ?? '').toLowerCase();
        let detail = `chat ${this.chatId} inaccessible (${chat.error_code ?? '?'}) : ${this.redact(chat.description ?? '')}`;
        if (desc.includes('chat not found')) {
          detail = `chat ${this.chatId} introuvable : ouvre Telegram, envoie /start à @${username ?? 'ton_bot'} `
            + '(ou ajoute-le au groupe), puis vérifie TELEGRAM_CHAT_ID (un groupe commence par -100…)';
        } else if (chat.error_code === 403) {
          detail = `le bot @${username ?? '?'} est bloqué ou n'est plus membre du chat ${this.chatId} : débloque-le / ré-ajoute-le`;
        }
        return { ok: false, detail, botUsername: username, retryable: (chat.error_code ?? 0) >= 500 || chat.error_code === 429 };
      }
      const name = chatRes?.title ?? chatRes?.first_name ?? this.chatId;
      this.chatType = chatRes?.type ?? null;
      return { ok: true, detail: `connecté : @${username} → « ${name} » (${chatRes?.type ?? 'chat'})`, botUsername: username };
    } catch (err) {
      return { ok: false, retryable: true, detail: `api.telegram.org injoignable : ${this.redact(String((err as Error)?.message ?? err)).slice(0, 160)}` };
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

  /**
   * Écoute les commandes du chat configuré (long polling getUpdates, 20 s). Les messages
   * d'autres chats sont ignorés (signalé au plus une fois par heure) ; une commande plus
   * vieille que `maxAgeSec` (envoyée pendant un arrêt du bot) est ignorée. Ne lève jamais.
   */
  startPolling(handler: TelegramCommandHandler, opts: { maxAgeSec?: number } = {}): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollLoop(handler, opts.maxAgeSec ?? 300).catch(() => undefined).finally(() => { this.polling = false; });
  }

  stopPolling(): void {
    this.polling = false;
  }

  get isPolling(): boolean {
    return this.polling;
  }

  private async pollLoop(handler: TelegramCommandHandler, maxAgeSec: number): Promise<void> {
    let backoff = 5_000;
    while (this.polling) {
      const t0 = Date.now();
      let r: TgResponse;
      try {
        r = await this.call('getUpdates', { offset: this.pollOffset, timeout: 20, allowed_updates: ['message'] }, 30_000);
      } catch (err) {
        if (!this.polling) return;
        this.log('WARN', `Telegram (commandes) injoignable : ${this.redact(String((err as Error)?.message ?? err)).slice(0, 120)} — nouvel essai dans ${backoff / 1000} s`);
        await this.sleep(backoff);
        backoff = Math.min(60_000, backoff * 2);
        continue;
      }
      if (!this.polling) return;
      if (!r.ok) {
        if (r.error_code === 409) {
          if (Date.now() - this.conflictLoggedAt > 3_600_000) {
            this.conflictLoggedAt = Date.now();
            this.log('WARN', 'Telegram (commandes) : un autre programme lit déjà les messages de ce bot (getUpdates, conflit 409) — les commandes ne répondront pas tant qu\'il tourne.');
          }
          await this.sleep(30_000);
          continue;
        }
        if (r.error_code === 401) {
          this.log('ERROR', 'Telegram (commandes) : token refusé (401), écoute des commandes arrêtée.');
          return;
        }
        this.log('WARN', `Telegram (commandes) : getUpdates en échec (${r.error_code ?? '?'}) ${this.redact(r.description ?? '')} — nouvel essai dans ${backoff / 1000} s`.slice(0, 240));
        await this.sleep(backoff);
        backoff = Math.min(60_000, backoff * 2);
        continue;
      }
      backoff = 5_000;
      const updates = (Array.isArray(r.result) ? r.result : []) as TgUpdate[];
      for (const u of updates) {
        if (typeof u.update_id === 'number') this.pollOffset = u.update_id + 1;
        const msg = u.message;
        if (!msg || typeof msg.text !== 'string') continue;
        if (String(msg.chat?.id) !== this.chatId) {
          if (Date.now() - this.foreignLoggedAt > 3_600_000) {
            this.foreignLoggedAt = Date.now();
            this.log('WARN', `Telegram (commandes) : message d'un autre chat (${String(msg.chat?.id ?? '?')}) ignoré — seul TELEGRAM_CHAT_ID est écouté.`);
          }
          continue;
        }
        if (typeof msg.date === 'number' && Date.now() / 1000 - msg.date > maxAgeSec) continue; // envoyée pendant un arrêt
        this.stats.commands++;
        try {
          const reply = await handler({ text: msg.text, chatId: String(msg.chat?.id), date: msg.date ?? 0, from: msg.from?.username ?? msg.from?.first_name });
          if (reply) this.send(reply);
        } catch (err) {
          this.log('WARN', `Telegram (commandes) : erreur en traitant « ${msg.text.slice(0, 40)} » : ${this.redact(String((err as Error)?.message ?? err)).slice(0, 120)}`);
          this.send('⚠️ Erreur interne en traitant cette commande (voir les logs du bot).');
        }
      }
      // Anti-boucle serrée si le serveur répond sans attendre (proxy, faux serveur de test).
      const elapsed = Date.now() - t0;
      if (elapsed < 1000) await this.sleep(1000 - elapsed);
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const text = this.queue.shift() as string;
      try {
        const wait = this.lastSentAt + this.minIntervalMs - Date.now();
        if (wait > 0) await this.sleep(wait);
        await this.deliver(text);
      } catch {
        // `deliver` capture tout ; ne reste qu'un `sleep`/`log` injecté qui lève. La file ne
        // doit jamais mourir sur un message (sinon plus AUCUNE notification jusqu'au redémarrage).
        this.stats.failed++;
      }
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
