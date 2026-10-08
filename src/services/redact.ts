/**
 * Masquage des secrets dans tout ce que le bot écrit (console/PM2, dashboard).
 *
 * Pourquoi : ethers recopie la valeur BRUTE dans ses erreurs. Une clé privée avec une
 * faute de frappe (63 caractères, un « O » pour un « 0 », un espace entre guillemets)
 * donnait `invalid hexlify value (… value="<la clé>" …)` dans paperbot.log, la page
 * Logs du dashboard et chez chaque spectateur WebSocket. De même, les erreurs RPC
 * d'ethers contiennent `url="…"` (clé d'API Alchemy/Infura/dRPC dans l'URL), et
 * clob-client imprime les en-têtes de la requête en échec (identifiants d'API POLY_*).
 *
 * On masque les VALEURS exactes connues (pas d'heuristique sur les hexadécimaux : les
 * hash de transaction et identifiants de marché doivent rester lisibles).
 */
const MASK = '[masqué]';

/** Variables dont la valeur entière est secrète. */
const SECRET_VARS = ['POLYMARKET_PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN', 'DASHBOARD_TOKEN', 'DEEPSEEK_API_KEY'];
/** Variables d'URL : seule l'origine reste visible si le chemin ou la requête porte une clé. */
const URL_VARS = ['POLYGON_RPC_URL'];

export type Redactor = (text: string) => string;

export function secretRedactor(env: Record<string, string | undefined> = process.env): Redactor {
  const pairs = new Map<string, string>();
  for (const name of SECRET_VARS) {
    const raw = env[name];
    const t = raw?.trim();
    if (!raw || !t) continue;
    // Brute (avec espaces éventuels), nettoyée, et sans préfixe 0x : ce qu'une erreur peut citer.
    for (const v of [raw, t, t.replace(/^0x/i, '')]) if (v.length >= 12) pairs.set(v, MASK);
  }
  for (const name of URL_VARS) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      const u = new URL(raw);
      // Un segment ou paramètre de 16+ caractères ressemble à une clé d'API (Alchemy /v2/<clé>,
      // Infura /v3/<clé>, dRPC ?dkey=<clé>) ; https://1rpc.io/matic reste lisible.
      if (/[A-Za-z0-9_-]{16,}/.test(u.pathname + u.search) || u.username || u.password) {
        pairs.set(raw, `${u.protocol}//${u.host}/${MASK}`);
        const rest = raw.slice(raw.indexOf(u.host) + u.host.length);
        if (rest.length >= 16) pairs.set(rest, `/${MASK}`); // URL citée sans son origine
      }
    } catch { /* URL invalide : rien à masquer de plus */ }
  }
  // Les plus longues d'abord : la clé avec 0x avant la même sans 0x.
  const list = [...pairs.entries()].sort((a, b) => b[0].length - a[0].length);
  if (!list.length) return (s) => s;
  return (s) => {
    for (const [secret, repl] of list) if (s.includes(secret)) s = s.split(secret).join(repl);
    return s;
  };
}

/** Masque les en-têtes d'authentification CLOB (POLY_API_KEY, POLY_SIGNATURE…) d'une requête. */
export function maskPolyHeaders(headers: unknown): void {
  if (!headers || typeof headers !== 'object') return;
  const h = headers as Record<string, unknown>;
  for (const k of Object.keys(h)) {
    if (/^poly[_-]/i.test(k) && !/^poly[_-]address$/i.test(k) && typeof h[k] === 'string') h[k] = MASK;
  }
}
