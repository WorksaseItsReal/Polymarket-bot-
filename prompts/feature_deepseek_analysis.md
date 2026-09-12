# Feature : Analyse LLM des marchés via DeepSeek Flash

> Module ajouté au repo `Polymarket-bot`. DeepSeek Flash **uniquement** — pas Qwen, pas de cloud Alibaba.

## Contexte

Le bot Polymarket place des trades en suivant des stratégies déterministes (smart money, arbitrage, dip-arb, trend-following). Cette feature ajoute une **couche d'analyse sémantique** qui passe par un grand modèle de langage pour évaluer un marché avant toute décision, en combinant l'ordre du livre (orderbook), le spread, la liquidité et le contexte texte du marché.

L'analyse se fait via l'**API OpenAI-compatible de DeepSeek** (`deepseek-chat` par défaut, `deepseek-v4-flash` possible), appelée avec **`fetch` natif** (Node 18+) — aucune dépendance `axios`.

## Objectif

- Décider `BUY_YES`, `BUY_NO` ou `HOLD` pour un marché donné, avec une confidence `0..1` et une justification.
- Toujours tomber sur **HOLD sûr** en cas de données insuffisantes ou de défaillance (jamais d'erreur bloquante).
- Contrôler le coût et le risque via un **budget d'appels journalier** persistant sur disque.

## Contraintes matérielles

- **Timeout court** : 1.5 s (`AbortSignal.timeout`). Le bot ne doit jamais être bloqué par le LLM.
- **Pas d'`axios`** : `fetch` natif uniquement.
- **Filtrage en amont** : l'appel LLM n'est déclenché que si la liquidité est `> 1000 $` **et** le spread `< 5%`. Sinon HOLD direct, sans réseau.
- **Respect de `canTrade()`** : aucun travail si le verrou multicoûts de risque est actif (pause / limites de perte).
- **Budget** : fichier `~/.polymarket/llm-calls.json`, compteur par jour, plafond `DEEPSEEK_MAX_CALLS_PER_DAY` (défaut 30). Au-delà → HOLD local.

## Actions

1. **Module `src/deepseek-analyzer.ts`** — fonction publique `analyzeMarket({marketId, orderbook, news, priceHistory, question, liquidityUsd, spreadPct})` retournant `{recommendation, confidence, reasoning, degraded}`. Jamais de rejet.
2. **Intégration `bot-with-dashboard.ts`** — `setupLLMAnalysis(sdk)`, appelé depuis `main()` après `setupDipArb`. Boucle : scan des trending markets → vérifie `canTrade()` → filtre spread/liquidité → appelle le LLM → log le signal `DeepSeek <question> → BUY_YES/BUY_NO/HOLD (conf x.xx)`.
3. **Documentation** — ce fichier + variables documentées dans `.env` et `.env.example`.

## Mode dégradé (SANS clé) — obligatoire

Si `DEEPSEEK_API_KEY` est absent/vide **ou** `DEEPSEEK_ANALYZER_ENABLED !== 'true'` :

- `analyzeMarket()` retourne **immédiatement** `{recommendation: 'HOLD', confidence: 0, ...}` avec `degraded: true`.
- **Aucun** appel réseau, **aucune** erreur levée.
- Le bot démarre et tourne normalement en `DRY_RUN` (même avec la clé Polymarket placeholder `0x0000...0001`).
- Le `setupLLMAnalysis` log `DEGRADED (local HOLD)` au démarrage.

## Résultat attendu

- `npx tsc --noEmit` : aucune erreur de syntaxe sur le nouveau module.
- Sans clé : test unitaire renvoyant HOLD + raison sans réseau.
- `timeout 40 npx tsx bot-with-dashboard.ts` : le bot démarre (init SDK en dry-run), logue le module LLM en mode dégradé, ne crash pas à cause de DeepSeek.