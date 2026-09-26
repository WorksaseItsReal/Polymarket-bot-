# Audit — service temps réel (`realtime-service-v2.ts`) & service DipArb (`dip-arb-service.ts`)

- **Date :** 2026-09-26
- **Périmètre édité :** `src/services/realtime-service-v2.ts`, `src/services/dip-arb-service.ts` (fichiers possédés par cet agent).
- **Hors périmètre (non touché) :** `bot-with-dashboard.ts`, `.env`, `src/dashboard/*`, `src/services/market-service.ts`, `node_modules/*`, scripts Python.
- **Contraintes respectées :** aucun `pm2 restart` ; chaque patch validé par `npx tsc --noEmit` (exit 0).

## Commandes de vérification

```
$ cd /root/clawd/Polymarket-bot && npx tsc --noEmit ; echo EXIT=$?
EXIT=0
```

```
$ npx tsx /root/.hermes/cache/scratch/diparb-smoke.mts
PASS :: ended market closes the waiting round (roundsCompleted=1)
PASS :: round phase -> completed
PASS :: completion is idempotent (still 1 after 3 calls)
PASS :: live market starts a round (roundsMonitored=1)
PASS :: new round is in waiting phase
PASS :: 'newRound' event emitted
PASS :: errStr truncates (len=240)
PASS :: errStr output is single-line

ALL PASS
SMOKE_EXIT=0
```

---

## Point 1 — canal WS `clob_market` déprécié : **UTILISÉ → NON COUPÉ**

**Verdict : des consommateurs RÉELS sont encore enregistrés sur les orderbooks de ce canal. Retirer l'abonnement serait contraire à la consigne (« si quelque chose les consomme, NE COUPE PAS »). Je n'ai donc PAS coupé.** Un commentaire d'avertissement a été ajouté dans `realtime-service-v2.ts`.

Ce qui est mesuré (déjà constaté par le parent) : le serveur rejette les souscriptions `clob_market` avec `{"message":"CLOB messages are not supported anymore..."}` (statusCode 400, 128×/h–274×/h) et ne délivre plus aucun message → `emit('orderbook', …)` (ligne ~977) **ne se déclenche jamais**.

Preuve que le canal est consommé (grep réel) :

```
$ grep -rn "subscribeMarkets" src/services/*.ts
src/services/dip-arb-service.ts:369:    this.marketSubscription = this.realtimeService.subscribeMarkets(
src/services/arbitrage-service.ts:400:    this.marketSubscription = this.realtimeService.subscribeMarkets(
```

```
$ grep -rn "onOrderbook" src/services/dip-arb-service.ts src/services/arbitrage-service.ts
src/services/dip-arb-service.ts:372:        onOrderbook: (book: OrderbookSnapshot) => {
src/services/arbitrage-service.ts:403:        onOrderbook: (book: OrderbookSnapshot) => {
```

Chain de consommation côté DipArb : `this.emit('orderbook')` (realtime-service-v2.ts:977) → handler `orderbookHandler` enregistré en realtime-service-v2.ts:374 → `handlers.onOrderbook?.()` → `DipArbService.handleOrderbookUpdate()` (dip-arb-service.ts:982), qui alimente `upAsks`/`downAsks` **et** déclenche `checkAndStartNewRound()`.

→ **Conséquence importante (cause racine du point 2) :** comme le canal est mort, `handleOrderbookUpdate()` n'est jamais appelé, donc (a) `upAsks`/`downAsks` restent vides (prix retombent sur les fallbacks 0.5/1) et (b) `checkAndStartNewRound()` n'est jamais appelé → compteurs DipArb figés à 0.

**Recommandation (hors périmètre de cet agent, à arbitrer par le parent) :** le canal étant mort, l'abonnement n'apporte aujourd'hui aucune donnée ; il ne produit que du bruit (réponses 400 du serveur). Un retrait ne deviendra propre qu'après avoir fait converger ces deux consommateurs vers une source REST (ou confirmé que l'orderbook n'est plus nécessaire). Je ne l'ai pas fait ici car la consigne l'interdit tant qu'un consommateur est enregistré.

---

## Point 2 — compteur `Rounds monitored: 0 / Rounds completed: 0 / Total profit: $0.00` : **compteurs jamais atteints, corrigé**

### Cause racine (prouvée par lecture du code)

`roundsMonitored` n'est incrémenté qu'à un seul endroit, dans `checkAndStartNewRound()` :

```
src/services/dip-arb-service.ts:1195:      this.stats.roundsMonitored++;
```

Or `checkAndStartNewRound()` n'était appelé que depuis `handleOrderbookUpdate()` :

```
src/services/dip-arb-service.ts:1009:      this.checkAndStartNewRound().catch(err => {
```

qui n'est atteignable que par l'ordrebook WS `clob_market` — **canal déprécié, mort** (point 1). Donc : le service « tourne » (heartbeat, REST feed, rotation) mais `checkAndStartNewRound()` n'est jamais invoqué → `roundsMonitored` / `roundsCompleted` restent à 0. Idem `roundsCompleted` : un round ne se terminait que via l'exécution Leg2 ou le timeout Leg1, deux chemins eux aussi alimentés par l'orderbook WS mort → en simple surveillance (`autoExecute=false`) le round restait bloqué en `waiting` à vie.

Bug annexe : `stop()` affichait `roundsSuccessful` sous le libellé « Rounds completed » (mauvais compteur).

### Correctifs appliqués

1. **Pilotage du cycle de vie depuis le flux REST (vivant, tick 5 s)** au lieu du WS mort — dans `startRestPriceFeed().tick()`.
2. **Clôture du round `waiting` à la fin du marché** dans `checkAndStartNewRound()` → `roundsCompleted` progresse.
3. **`stop()` affiche le bon compteur** (`roundsCompleted`) et distingue `roundsSuccessful (Leg2 filled)`.

Note sécurité : le correctif n'utilise **pas** `emit('error')` (aucun listener `'error'` n'est enregistré sur `DipArbService` → Node lancerait « Unhandled 'error' event » et tuerait le process) ; il logge via le helper borné.

### Diff (hunks applicables — mine, horodatés 2026-09-26)

```diff
@@ src/services/dip-arb-service.ts @@
@@ -533,8 +533,13 @@
     this.log('Stopped');
+    // ✅ FIX 2026-09-26 : « Rounds completed » affichait `roundsSuccessful`
+    // (rounds à double jambe exécutée) au lieu de `roundsCompleted` (rounds
+    // réellement terminés). En simple surveillance, un round terminé n'est
+    // jamais « successful » → le libellé était trompeur. On distingue les deux.
     this.log(`Rounds monitored: ${this.stats.roundsMonitored}`);
-    this.log(`Rounds completed: ${this.stats.roundsSuccessful}`);
+    this.log(`Rounds completed: ${this.stats.roundsCompleted}`);
+    this.log(`Rounds successful (Leg2 filled): ${this.stats.roundsSuccessful}`);
     this.log(`Total profit: $${this.stats.totalProfit.toFixed(2)}`);

@@ -1120,6 +1120,21 @@
     const tick = async () => {
       if (!this.isRunning || !this.market) return;
+
+      // ✅ FIX 2026-09-26 : le cycle de vie des rounds était déclenché
+      // UNIQUEMENT par `handleOrderbookUpdate()` (événement WS `clob_market`),
+      // canal DÉPRÉCIÉ côté Polymarket (réponse serveur 400 « CLOB messages are
+      // not supported anymore ») qui ne délivre plus AUCUN message. Résultat :
+      // `checkAndStartNewRound()` n'était jamais appelé → compteurs
+      // `Rounds monitored`/`Rounds completed` figés à 0 alors que le service
+      // tournait. On pilote désormais le cycle depuis le flux REST (vivant,
+      // tick 5 s), indépendamment du WS mort. On LOGGE l'erreur (et on n'utilise
+      // PAS emit('error') : aucun listener 'error' n'est enregistré → Node
+      // lancerait « Unhandled 'error' event » et tuerait le process).
+      this.checkAndStartNewRound().catch(err => {
+        this.log(`Round lifecycle error: ${this.errStr(err)}`);
+      });
+
       const coin = this.market.underlying.toUpperCase();
       if (!isSpotCoin(coin)) return;

@@ -1173,6 +1173,30 @@
   private async checkAndStartNewRound(): Promise<void> {
     if (!this.market) return;
 
+    // ✅ FIX 2026-09-26 : clôturer le round « waiting » quand le marché est
+    // terminé. Auparavant un round ne se terminait QUE via l'exécution Leg2 ou
+    // le timeout Leg1 — deux chemins alimentés par l'orderbook WS
+    // (`clob_market`, canal DÉPRÉCIÉ/mort). En simple surveillance
+    // (autoExecute=false) le round restait donc bloqué en 'waiting' à vie et
+    // `roundsCompleted` ne quittait jamais 0. On le clôt explicitement ici.
+    if (
+      this.currentRound &&
+      this.currentRound.phase === 'waiting' &&
+      new Date() >= this.market.endTime
+    ) {
+      this.currentRound.phase = 'completed';
+      this.stats.roundsCompleted++;
+
+      const completedRound: DipArbRoundResult = {
+        roundId: this.currentRound.roundId,
+        status: 'completed',
+        leg1: this.currentRound.leg1,
+        merged: false,
+      };
+      this.emit('roundComplete', completedRound);
+      this.log(`Round completed (market ended, no position): ${this.currentRound.roundId}`);
+    }
+
     // If no current round or current round is completed/expired, start new round
```

---

## Point 3 — code mort « chemin LLM `analyzeMarket` » : **NON SUPPRIMÉ (suppression non sûre)**

`analyzeMarket` n'est **pas** un export inutilisé. Grep réel :

```
$ grep -rn "analyzeMarket" --include=*.ts . | grep -v node_modules | grep -v dist
./bot-with-dashboard.ts:25:import { analyzeMarket, isEnabled } from './src/deepseek-analyzer.js';
./scripts/test-no-key-deepseek.ts:2:import { analyzeMarket, isEnabled } from '../src/deepseek-analyzer.js';
./scripts/test-no-key-deepseek.ts:20:  const res = await analyzeMarket({
./src/deepseek-analyzer.ts:265:export async function analyzeMarket(
```

- `bot-with-dashboard.ts:25` importe `analyzeMarket` (ligne **interdite** à l'édition — fichier d'un autre agent). Il ne l'appelle pas (seul `isEnabled()` est utilisé ligne 1075) : c'est donc un **import orphelin** dans un fichier que je ne possède pas.
- `scripts/test-no-key-deepseek.ts:20` l'**appelle** réellement.

Retirer la fonction `analyzeMarket` de `src/deepseek-analyzer.ts` casserait au moins le script (et l'import de `bot-with-dashboard.ts`), sans aucun gain vérifiable. **Aucun patch appliqué.** Le vrai nettoyage (= retirer l'import orphelin) doit être fait par le propriétaire de `bot-with-dashboard.ts`.

À noter : `tsconfig.json` n'inclut ni `bot-with-dashboard.ts` ni `scripts/test-no-key-deepseek.ts` (include = `src/**/*`, `scripts/dip-arb/**/*`) — un retrait passerait donc `tsc` tout en risquant de casser le runtime du bot. Raison de plus pour ne pas toucher.

---

## Point 4 — hygiène de log (pas de dump d'objets)

Analyse des logs réels (`paperbot*.log`, `paperbot.error.log`) — fuites identifiées :

1. **`console.log("onMessage error", { event })`** dans le client WS `@polymarket/real-time-data-client` : dumpait l'objet `MessageEvent` **complet** (dont l'instance `WebSocket` entière : `_socket`, `_events`, `Symbol(kData)`…) → 86 blocs dans le log rotaté, principal contributeur à la taille multi-Mo.
   `grep` montre que ce fichier a **déjà été neutralisé** (hors de mon périmètre : `node_modules`) :
   ```
   node_modules/@polymarket/real-time-data-client/dist/client.js.bak:81: console.log("onMessage error", { event });
   node_modules/@polymarket/real-time-data-client/dist/client.js:81: ... console.warn("[ws] non-payload message:", _d.slice(0, 200)); ...
   ```
   → **action requise hors de mes fichiers** (patch `node_modules`, à rendre durable si possible).

2. **Dump d'objet ethers de ~7,3 Ko par ligne** — celui-là est **dans mon fichier** et **corrigé**. Les erreurs ethers v5 embarquent tout le `transaction={…}` + `error={…}` (en-têtes HTTP Cloudflare complets) :
   ```
   $ awk 'length>300 {print NR": "substr($0,1,90)}' paperbot__2026-09-26_00-00-00.log
   1619: 2026-09-25T22:20:14: [DipArb] Warning: Failed to scan existing pairs: missing revert data
   2605: 2026-09-25T22:50:17: [DipArb] Warning: Failed to scan existing pairs: missing revert data
   4439: 2026-09-25T23:45:23: [DipArb] Warning: Failed to scan existing pairs: missing revert data
   ```
   (max = **7314 caractères sur une seule ligne**). Correctif : helper `errStr()` qui aplatit et **borne à 240 caractères** toute erreur loggée.

3. Restent deux `JSON.stringify` d'objets de config (`Config updated: {…}` ≈ 100 car., `Auto-rotate enabled: {…}` ≈ 250 car.) : **bornés et uniques au démarrage/rotation**, laissés tels quels (utiles au debug, sans croissance de log).

### Diff — helper + sites d'appel (mine)

```diff
@@ src/services/dip-arb-service.ts @@
@@ -2424,6 +2424,20 @@
     this.log(`   Change: UP ${upChange}% | DOWN ${downChange}%`);
   }
 
+  /**
+   * ✅ AUDIT 2026-09-26 (hygiène de log) : formate une erreur en UNE ligne
+   * bornée. Les erreurs ethers v5 embarquent `transaction={…}` / `error={…}`
+   * (avec en-têtes HTTP complets) → jusqu'à ~7 Ko PAR ligne dans le log, cf.
+   * « Failed to scan existing pairs: missing revert data in call exception;
+   * Transaction reverted without a reason string (data=…, transaction={…}) ».
+   * On aplatit les espaces et on tronque pour ne garder que la cause utile.
+   */
+  private errStr(err: unknown, maxLen = 240): string {
+    const raw = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
+    if (raw.length <= maxLen) return raw;
+    const suffix = `…[+${raw.length - maxLen}]`;
+    return raw.slice(0, Math.max(0, maxLen - suffix.length)) + suffix;
+  }
+
   private log(message: string): void {
```

Remplacement, sur 10 sites d'appel (toutes les interpolations d'erreur) :

```diff
-      this.log(`Warning: Trading service init failed: ${error}`);
+      this.log(`Warning: Trading service init failed: ${this.errStr(error)}`);
-      this.log(`Warning: Chainlink WS subscription failed (non bloquant): ${err instanceof Error ? err.message : String(err)}`);
+      this.log(`Warning: Chainlink WS subscription failed (non bloquant): ${this.errStr(err)}`);
-          this.log(`❌ Startup merge error: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`);
+          this.log(`❌ Startup merge error: ${this.errStr(mergeError)}`);
-      this.log(`Warning: Failed to scan existing pairs: ${error instanceof Error ? error.message : String(error)}`);
+      this.log(`Warning: Failed to scan existing pairs: ${this.errStr(error)}`);
-      this.log(`❌ Leg1 exit error: ${error instanceof Error ? error.message : String(error)}`);
+      this.log(`❌ Leg1 exit error: ${this.errStr(error)}`);
-      this.log(`Warning: Failed to scan redeemable positions: ${err instanceof Error ? err.message : String(err)}`);
+      this.log(`Warning: Failed to scan redeemable positions: ${this.errStr(err)}`);
-                this.log(`⚠️ Failed to merge ${market.slug}: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
+                this.log(`⚠️ Failed to merge ${market.slug}: ${this.errStr(mergeErr)}`);
-      this.log(`Error scanning redeemable positions: ${error instanceof Error ? error.message : String(error)}`);
+      this.log(`Error scanning redeemable positions: ${this.errStr(error)}`);
-        this.log(`Redemption error for ${pending.market.slug}: ${error instanceof Error ? error.message : String(error)}`);
+        this.log(`Redemption error for ${pending.market.slug}: ${this.errStr(error)}`);
```

---

## Point 1 (suite) — Diff commentaire `realtime-service-v2.ts` (fichier intégralement concerné par cet audit)

```diff
diff --git a/src/services/realtime-service-v2.ts b/src/services/realtime-service-v2.ts
@@ -323,6 +323,21 @@ export class RealtimeServiceV2 extends EventEmitter {
 
   // ============================================================================
   // Market Data Subscriptions (clob_market)
+  //
+  // ⚠️ AUDIT 2026-09-26 — topic DÉPRÉCIÉ côté Polymarket.
+  // Le serveur `wss://ws-live-data.polymarket.com/` rejette les souscriptions
+  // `clob_market` avec `{"message":"CLOB messages are not supported anymore..."}`
+  // (statusCode 400, mesuré 128×/h à 274×/h) et ne délivre plus AUCUN message :
+  // `emit('orderbook', …)` (et priceChange/lastTrade/tickSizeChange) ne se
+  // déclenche donc jamais.
+  //
+  // NON RETIRÉ (décision d'audit) : des consommateurs RÉELS sont encore
+  // enregistrés sur ces événements —
+  //   • DipArbService.start()  → subscribeMarkets(..., { onOrderbook })  (dip-arb-service.ts)
+  //   • ArbitrageService.start() → subscribeMarkets(..., { onOrderbook }) (arbitrage-service.ts)
+  // Retirer les topics casserait la réception des orderbooks si le serveur les
+  // réactivait un jour. À supprimer seulement quand ces deux consommateurs
+  // auront migré vers une source REST/autre canal. Voir docs/rebuild/code/REPORT.md.
   // ============================================================================
```

---

## Synthèse

| # | Sujet | Verdict | Patch |
|---|-------|---------|-------|
| 1 | WS `clob_market` déprécié | **Consommé** (DipArb + Arbitrage) → non coupé | Commentaire d'audit ajouté |
| 2 | Compteurs DipArb à 0 | Cause : cycle des rounds déclenché uniquement par le WS mort | ✅ 3 correctifs (REST tick, clôture fin de marché, libellé `stop()`) |
| 3 | Code mort `analyzeMarket` | **Pas supprimable en sécurité** (importé par `bot-with-dashboard.ts` + utilisé par un script) | Aucun |
| 4 | Hygiène de log | Dump WS dans `node_modules` (déjà mitigé) + dump ethers 7,3 Ko **dans mon fichier** | ✅ helper `errStr` borné à 240 car. sur 10 sites |

**Vérifications :** `npx tsc --noEmit` → exit 0 ; smoke test runtime `diparb-smoke.mts` → ALL PASS.

**Restant / recommandations (hors de mes fichiers) :**
- Faire converger `DipArbService` et `ArbitrageService` vers une source d'orderbook REST pour pouvoir retirer proprement les topics `clob_market` (et supprimer les réponses 400 + le bruit `[ws] non-payload message`).
- Retirer l'import orphelin `analyzeMarket` dans `bot-with-dashboard.ts` (propriétaire : autre agent) si le chemin LLM reste abandonné.
- Rendre durable la neutralisation du dump `onMessage error` dans `node_modules/@polymarket/real-time-data-client` (patch à rejouer après réinstallation).
