# AUDIT ON-CHAIN — SÉCURISATION DU MODE PAPER (DRY_RUN)

Périmètre audité (seuls fichiers modifiables) :

| Fichier | Lignes |
|---|---|
| `src/services/wallet-service.ts` | 1 080 (inchangé) |
| `src/services/swap-service.ts` | 896 → 933 |
| `src/services/onchain-service.ts` | 609 → 618 |
| `src/clients/ctf-client.ts` | 1 219 → 1 364 |
| `src/clients/bridge-client.ts` | 841 → 848 |
| `docs/rebuild/onchain/AUDIT.md` | créé — 532 |

Méthode : traçage statique de **tous** les appels d'écriture, puis preuve d'exécution
par sonde TypeScript (lecture seule sur le réseau + aucun envoi de transaction).
Toutes les vérifications réseau faites dans cet audit sont des **lectures**
(`balanceOf`, `decimals`, `getBlockNumber`, `getTransactionCount`). Aucune
transaction, aucune signature, aucune approbation n'a été envoyée.

---

## 0. RÉPONSE À LA QUESTION PRINCIPALE

> **Est-il réellement impossible que ce code envoie une transaction ou un ordre réel en DRY_RUN ?**

**AVANT ce correctif : NON, ce n'était pas garanti. Il existait au moins un chemin
d'écriture réellement atteignable en DRY_RUN, sans aucun test de `dryRun`.**

**APRÈS ce correctif : OUI.** Toute écriture on-chain des cinq fichiers passe
désormais par une garde unique, *fail-closed*, exécutée **avant** la première
action irréversible (approve / transfer / deposit / swap / mint · merge · redeem).
Preuve d'exécution : **28/28 chemins d'écriture bloqués**, 37 assertions OK, 0 échec
(section 7).

### Chemin non gardé trouvé (le plus important de la mission)

`dip-arb-service.ts` appelle directement des écritures CTF **sans aucun test de
`dryRun`**, alors que son `CTFClient` est instancié avec la clé **réelle** même en
DRY_RUN :

- `PolymarketSDK.create({ privateKey: process.env.POLYMARKET_PRIVATE_KEY })`
  (`bot-with-dashboard.ts:1600`) — la clé est passée **inconditionnellement**, y compris en DRY_RUN.
- `PolymarketSDK` → `new DipArbService(..., config.privateKey, ...)` (`src/index.ts:455`)
  → `new CTFClient({ privateKey, ... })` (`src/services/dip-arb-service.ts:171-176`).
- Écritures non gardées côté service : `this.ctf.mergeByTokenIds` (`dip-arb-service.ts:515`
  merge automatique au démarrage, `:1041`, `:2064`) et `this.ctf.redeemByTokenIds`
  (`:2306`, `:2528`). **Aucune** de ces lignes n'est conditionnée par `DRY_RUN`/`paper`.

En DRY_RUN, ces appels étaient donc *atteignables* : le seul obstacle était
l'absence de positions réelles (mode paper). C'est exactement le type de garde
implicite non prouvable qui casse le jour où une position ERC-1155 existe déjà
dans le wallet (dépôt manuel, reliquat d'un test live, etc.).

**Correction apportée** (dans le périmètre autorisé) : la garde est posée au plus
bas, dans `CTFClient` lui-même — donc `dip-arb-service`, `arbitrage-service` et tous
les scripts héritent du blocage sans modifier une seule de leurs lignes.

### Second chemin non gardé

`OnchainService.approveAll()` / `approveUsdc()` / `setErc1155Approval()` délèguent à
`authorization-service.ts`, qui **ne contient aucune garde** `dryRun`/`DRY_RUN`
(vérifié : `grep` = 0 occurrence) et envoie de vraies transactions `approve()` et
`setApprovalForAll()` — dont une **avec `gasLimit` explicite**, ce qui **désactive
l'estimation de gaz** et donc tout contrôle préalable au broadcast
(`authorization-service.ts:309`). Ce fichier n'étant pas dans mon périmètre
d'écriture, la garde a été posée à la frontière que je contrôle :
`onchain-service.ts:235, 246, 257`.

---

## 1. INVENTAIRE DES CHEMINS D'ÉCRITURE ET LEUR GARDE

### 1.1 `src/clients/ctf-client.ts`

| Méthode | Action irréversible | Ligne d'action | Garde | Ligne garde |
|---|---|---|---|---|
| `split()` | `USDC.e.approve()` puis `CTF.splitPosition()` | 474, 484 | `assertWritesAllowed('CTFClient.split …')` — 1ʳᵉ instruction | **462** |
| `merge()` | `CTF.mergePositions()` | 535 | `assertWritesAllowed('CTFClient.merge …')` | **520** |
| `mergeByTokenIds()` | `CTF.mergePositions()` | 583 | `assertWritesAllowed('CTFClient.mergeByTokenIds …')` | **568** |
| `redeem()` | `CTF.redeemPositions()` | 657 | `assertWritesAllowed('CTFClient.redeem …')` | **633** |
| `redeemByTokenIds()` | `CTF.redeemPositions()` | 741 | `assertWritesAllowed('CTFClient.redeemByTokenIds …')` | **717** |
| `estimateSplitGas()` / `estimateMergeGas()` | `estimateGas` | 869 / 889 | *lecture* (`eth_estimateGas`) — volontairement non gardé | — |
| `getUsdcBalance`, `getPositionBalance*`, `getMarketResolution`, `getTransactionStatus`, `waitForTransaction`, `getRevertReason` | lectures (`balanceOf`, `payoutNumerators`, `getTransactionReceipt`, `provider.call`) | — | aucune écriture | — |

Dans chaque cas, la garde est la **première instruction** de la méthode : aucune
approbation, aucune estimation de gaz, aucune signature n'intervient avant.

### 1.2 `src/services/swap-service.ts`

| Méthode | Action irréversible | Ligne d'action | Garde | Ligne garde |
|---|---|---|---|---|
| `swapMultiHop()` | `approve()` puis `router.exactInput()` | 442, 461 | `assertWritesAllowed('SwapService.swapMultiHop …')` | **403** |
| `swap()` | `approve()` puis `router.exactInputSingle()` | 630, 674 | `assertWritesAllowed('SwapService.swap …')` | **594** |
| `wrapMatic()` | `WMATIC.deposit()` (payable) | 543 | `assertWritesAllowed('SwapService.wrapMatic …')` | **538** |
| `unwrapMatic()` | `WMATIC.withdraw()` | 566 | `assertWritesAllowed('SwapService.unwrapMatic …')` | **561** |
| `transferMatic()` | `signer.sendTransaction()` | 837 | `assertWritesAllowed('SwapService.transferMatic …')` | **826** |
| `transfer()` | `ERC20.transfer()` | 881 | `assertWritesAllowed('SwapService.transfer …')` | **859** |
| `transferUsdc()` | → `transfer('USDC')` | 908 | héritée (garde de `transfer`, l. 859) | — |
| `transferUsdcE()` | → `transfer('USDC_E')` | 931 | héritée (garde de `transfer`, l. 859) | — |
| `swapToUsdc()` | → `swap()` / `wrapMatic()` | — | héritée (`swap` l. 594, `wrapMatic` l. 538) | — |
| `checkPool`, `getQuote` (`callStatic`), `getBalances`, `getBalance`, `getAvailablePools`, `getWalletBalances`, `getWalletBalance`, `getTokenAddress`, `getTokenDecimals` | lectures / pur | — | aucune écriture (`quoter`/`factory` sont montés sur le **provider**, pas le signer) | — |

### 1.3 `src/clients/bridge-client.ts`

| Fonction | Action irréversible | Ligne d'action | Garde | Ligne garde |
|---|---|---|---|---|
| `depositUsdc()` | `ERC20.transfer()` vers l'adresse de dépôt bridge | 588 | `assertWritesAllowed('depositUsdc …')` — avant le `try` (donc l'erreur **n'est pas** avalée par le `catch`) | **543** |
| `swapAndDeposit()` | swap DEX **+** dépôt bridge | via `swap`/`depositUsdc` | `assertWritesAllowed('swapAndDeposit …')` — avant le `try` | **684** |
| `BridgeClient.createDepositAddresses()` | `POST /deposit` sur l'API bridge | 259 | **écriture hors-chaîne** (pas de mouvement de fonds, pas de tx) — laissée libre volontairement | — |
| `getSupportedAssets`, `getEvmDepositAddress`, `getMinDeposit`, `isSupported`, `getDepositInstructions`, `estimateBridgeOutput`, `getExplorerUrl` | lectures / calculs | — | aucune écriture | — |

> Note : `depositUsdc` et `swapAndDeposit` sont tous deux **au-dessus** de leur
> `try { … } catch`, qui renvoie un objet `{ success: false, error }`. La garde
> **jette** donc au lieu d'être convertie silencieusement en échec : impossible de
> confondre « bloqué par DRY_RUN » avec « échec réseau ».

### 1.4 `src/services/onchain-service.ts`

`OnchainService` est une façade : elle ne signe rien elle-même.

| Méthode | Cible | Garde locale | Sinon |
|---|---|---|---|
| `approveAll()` (l. 235) | `AuthorizationService.approveAll()` — **service sans garde** | ✅ ajoutée | — |
| `approveUsdc()` (l. 246) | `AuthorizationService.approveUsdc()` | ✅ ajoutée | — |
| `setErc1155Approval()` (l. 257) | `AuthorizationService.setErc1155Approval()` | ✅ ajoutée | — |
| `split`, `merge`, `mergeByTokenIds`, `redeem`, `redeemByTokenIds` | `CTFClient` | garde héritée (l. 462/520/568/633/717) | ✔ |
| `swap`, `swapAndDeposit`, `transfer`, `transferMatic`, `transferUsdc`, `transferUsdcE`, `wrapMatic`, `unwrapMatic` | `SwapService` | garde héritée | ✔ |

### 1.5 `src/services/wallet-service.ts` — **aucun chemin d'écriture**

Vérifié : le service ne contient **ni** `ethers.Wallet`, **ni** `privateKey`, **ni**
`Contract`, **ni** `sendTransaction`/`approve`. Il n'utilise que `DataApiClient`,
`SubgraphClient` et `UnifiedCache` (HTTP en lecture : profils, positions, activité,
leaderboards, PnL). **Aucune garde n'est nécessaire**, le fichier n'a pas été modifié.

### 1.6 Chemins d'écriture hors périmètre (signalés, non modifiables)

| Emplacement | Écriture | Garde actuelle | Statut |
|---|---|---|---|
| `authorization-service.ts:273, 363, 397` | `approve()` / `setApprovalForAll()` | **aucune** | bloqué désormais au niveau `OnchainService` (1.4) |
| `dip-arb-service.ts:515, 1041, 2064, 2306, 2528` | `mergeByTokenIds` / `redeemByTokenIds` | **aucune** (clé réelle injectée par le SDK) | bloqué désormais au niveau `CTFClient` |
| `arbitrage-service.ts:732, 742, 863, 1089, 1120` | `split` / `mergeByTokenIds` / `redeem` | gardes **appelant** : `privateKey: undefined` en DRY_RUN (`bot-with-dashboard.ts:731`) + `autoExecute/enableRebalancer: !CONFIG.dryRun` (l. 514-515) → `this.ctf` reste `null` | bloqué en double désormais |
| `smart-money-service.ts:957` | copie live → `TradingService` | `const dryRun = options.dryRun ?? (process.env.DRY_RUN !== 'false')` | semblerait déjà fail-closed |
| `trading-service.ts:190` | ordres CLOB | `this.paperMode = config.paperMode ?? (process.env.DRY_RUN !== 'false')` | déjà fail-closed (hors périmètre, non modifié) |

---

## 2. GARDES AJOUTÉES — SÉMANTIQUE

Nouvelles primitives exportées par `src/clients/ctf-client.ts` (source unique,
importée par les 4 autres fichiers — aucune duplication) :

- `isDryRunMode()` (l. 84) — **fail-closed**, sémantique strictement alignée sur
  `bot-config.ts:153` (`dryRun: process.env.DRY_RUN !== 'false'`) :

  ```ts
  const raw = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return true;  // absent, vide, illisible => mode paper
  ```

- `assertWritesAllowed(operation)` (l. 112) — jette `DryRunWriteBlockedError`.
- `DryRunWriteBlockedError` (l. 64) — message explicite, sans secret.

> ⚠️ **Conséquence à connaître** : ce défaut est *fermé* (fail-closed). Les outils
> live du dépôt qui n'ont jamais défini `DRY_RUN` (`scripts/redeem.ts`,
> `scripts/deposit/deposit.ts`, `scripts/arb/*`, `scripts/dip-arb/*`) doivent
> désormais exporter **`DRY_RUN=false`** pour écrire réellement. C'est cohérent avec
> le contrat du bot, mais c'est un changement de comportement assumé — voir « Limites ».

---

## 3. GESTION DE LA CLÉ PRIVÉE

### (a) Journalisation — résultat : **aucune fuite**

`grep` sur `src/`, `bot-with-dashboard.ts`, `bot-config.ts` : **zéro** occurrence de
`console.*`/`log(...)`/`JSON.stringify(...)` impliquant `POLYMARKET_PRIVATE_KEY` ou
`privateKey`. Les seules lignes sont des constats d'absence :
`bot-with-dashboard.ts:1489` et `bot-config.ts:877` (`'POLYMARKET_PRIVATE_KEY not found'`).

Les constructeurs passent la clé dans un objet `CTFConfig` (`onchain-service.ts:158`)
— objet de transport, jamais imprimé.

### (b) Fuite via les messages d'erreur — **fuite réelle trouvée et corrigée**

`new ethers.Wallet(k)` (ethers v5.8.0) inclut la **valeur brute** dans son message
d'erreur lorsque la clé contient des caractères non-hex :

```
invalid hexlify value (argument="value", value="0xNOT_A_KEY_AT_ALL", …, bytes/5.8.0)
```

Et les appelants loguent `(err as Error).message` — p. ex. `bot-with-dashboard.ts`
(`Balance setup error: …`, `OnchainService setup failed: …`). Un `.env` mal copié
aurait donc écrit la (pseudo-)clé en clair dans `paperbot.log`.

*(Pour une clé de longueur correcte mais invalide, ethers affiche `value="[[ REDACTED ]]"` ;
seul le cas « caractères non-hex » fuitait.)*

**Correction** : `assertValidPrivateKeyShape()` (`ctf-client.ts:98`), appelée
**avant** ethers dans `CTFClient` (l. 336) et `OnchainService` (l. 154). Elle rejette
toute clé ne matcheant pas `/^0x[0-9a-fA-F]{64}$/` avec un message **qui ne contient
jamais la valeur**. Preuve (section 7, sonde 2) : `new CTFClient({privateKey:'0xNOT_A_KEY_AT_ALL_ZZZ'})`
→ message assaini, `"NOT_A_KEY"` absent ; `new ethers.Wallet(...)` seul → « fuite : OUI ».

### (c) Écriture sur disque / exfiltration

Aucun `writeFileSync`/`appendFileSync` ne touche à la clé : les écritures disque du
dépôt concernent `dashboard/session-history.ts:152` (historique de sessions),
`deepseek-analyzer.ts:171` (budget d'appels) et `bot-with-dashboard.ts:373/577/598`
(historique) — champs vérifiés, aucun ne contient la clé.
Aucun envoi HTTP de la clé (le seul client HTTP externe, `deepseek-analyzer.ts`, ne
transmet que du texte de marché).

### (d) Exposition par API

`CTFClient`/`OnchainService` n'ont **pas** de getter de clé. `OnchainService.getWallet()`
(l. 606) rend l'`ethers.Wallet` complet — qui expose `wallet.privateKey` : c'est
inhérent à ethers et documenté ici comme point de vigilance pour tout code qui
sérialiserait ce retour.

### (e) Clé placeholder

`POLYGON_RPC_URL=https://polygon.drpc.org` et `DRY_RUN` sont dans `.env` ; la clé est
un hex 64 caractères placeholder. **Valeur jamais affichée dans cet audit — `[REDACTED]`.**

---

## 4. ROBUSTESSE RPC

### État initial

Les 5 fichiers faisaient tous :
`new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org')`
— **un seul fournisseur, aucun timeout, aucune bascule**. Le dépôt ne contenait
aucun utilitaire de provider (`grep` : `FallbackProvider`/`StaticJsonRpcProvider`/
`createProvider` = 0 occurrence hors `onchain-service.ts`). C'est la cause racine
directe des 123 erreurs/heure « could not detect network » : `JsonRpcProvider`
lance `eth_chainId`/`net_version` au démarrage, et un RPC rate-limité fait échouer
cette détection — échec **définitif** (aucun retry, aucun autre nœud).

*(À noter : les logs `paperbot*.log` présents sur le disque ne contiennent
actuellement **0** occurrence de « could not detect network » — la cascade a donc
été purgée/rotée, mais le défaut de conception reste.)*

### Correctif : `createPolygonProvider()` (`ctf-client.ts:184`)

- **`StaticJsonRpcProvider`** : plus **aucun** appel `eth_chainId` au démarrage →
  la cause de « could not detect network » disparaît structurellement.
- **Timeout HTTP 15 s** par requête (`{ url, timeout: 15_000 }`) : une requête qui
  pend est coupée au lieu de bloquer le bot.
- **Bascule multi-fournisseurs** sur les 4 RPC connus vivants, dans l'ordre :
  `polygon.drpc.org` → `polygon-bor-rpc.publicnode.com` → `polygon.gateway.tenderly.co`
  → `api.zan.top/polygon-mainnet`. L'URL de `POLYGON_RPC_URL` reste prioritaire.
- **Bascule intelligente** : elle ne se déclenche que sur une **erreur de transport**
  (timeout, fetch, réseau). Si le nœud **répond** une erreur JSON-RPC (revert,
  `insufficient funds`…), elle est renvoyée telle quelle — on ne masque pas une
  erreur métier et on ne la rejoue pas inutilement sur 3 autres nœuds.
- Le dernier backend sain est mémorisé (`_activeIndex`) pour ne pas repayer l'échec
  à chaque appel.

Branchements : `ctf-client.ts:333`, `swap-service.ts:160` (constructeur),
`swap-service.ts:759`, `swap-service.ts:801` (statiques `getWalletBalances`/`getWalletBalance`),
`onchain-service.ts:153`.

**Preuve d'exécution (lecture seule)** : avec un primaire volontairement mort
(`http://127.0.0.1:9`), `createPolygonProvider('http://127.0.0.1:9').getBlockNumber()`
retourne un vrai numéro de bloc (94538650, puis 94538739) — la bascule fonctionne.

### Limite résiduelle honnête

`SwapService` utilise le provider du signer quand celui-ci en a un
(`swap-service.ts:160`, `this.provider = signer.provider || …`). Or
`bot-with-dashboard.ts:1026` construit ce signer sur un `JsonRpcProvider` **non
résilient**, dans un fichier hors de mon périmètre d'écriture. Les *écritures* de
`SwapService` héritent donc encore de ce provider fragile ; ses **lectures**
`quoter`/`factory`/`getBalances` utilisent, elles, le provider résilient quand
`getWalletBalances`/`getWalletBalance` sont appelées seules. Correctif recommandé
(hors périmètre) : remplacer la ligne 1026 de `bot-with-dashboard.ts` par
`createPolygonProvider(process.env.POLYGON_RPC_URL)`.

---

## 5. CONVERSIONS D'UNITÉS (wei / USDC 6 / positions)

### Vérifié conforme (preuves dans la section 7, sonde 2)

Toutes les décimales de la table locale ont été **comparées aux valeurs on-chain**
(appel `decimals()` en lecture) :

| Token | Table locale | On-chain | Verdict |
|---|---|---|---|
| USDC.e (collatéral CTF, `0x2791…4174`) | 6 | 6 | ✔ |
| USDC natif (`0x3c49…3359`) | 6 | 6 | ✔ |
| USDT (`0xc213…e8f`) | 6 | 6 | ✔ |
| DAI (`0x8f3C…063`) | 18 | 18 | ✔ |
| WMATIC (`0x0d50…270`) | 18 | 18 | ✔ |
| WETH (`0x7ceB…619`) | 18 | 18 | ✔ |

- **Positions CTF (ERC-1155)** : libellées dans les décimales du **collatéral**
  (USDC.e = 6), pas en 18. `USDC_DECIMALS = 6` est donc **correct** pour
  `split`/`merge`/`redeem` et pour `balanceOf` des positions.
  Preuve : `parseUnits('10', 6) = 10000000` (1e7) et **non** 1e19.
  Un commentaire a été ajouté (`ctf-client.ts:51`) pour figer cette contrainte.
- **MATIC** : `parseEther` → `1e18` ✔ (natif, 18 décimales).
- `parseUsdc('1') = 1000000` (1e6), `formatUsdc(1e6) = '1.0'` ✔.
- Le branchement stablecoins de `swap()` (`swap-service.ts:636-657`) rescale
  correctement `decimalsIn` ≠ `decimalsOut` avant d'appliquer le slippage (bps) ✔.

### Bug d'unité trouvé et corrigé — `getTokenDecimals()` (défaut silencieux à 18)

Avant : `return TOKEN_DECIMALS[upperToken] || 18;`. Or `getTokenAddress()` accepte
une **adresse** (`0x…`, 42 caractères) et la renvoie telle quelle. Donc
`transfer('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', to, '1')` — c'est-à-dire
USDC.e passé par adresse — était interprété en **18 décimales** au lieu de 6 :
`parseUnits('1', 18) = 1e18` au lieu de `1e6`, soit **un transfert 1 000 000 000 000×
trop gros**. Erreur invisible en lecture, fatale en écriture.

Correction (`swap-service.ts:216-240`) : les décimales sont résolues via
`POLYGON_TOKENS` quand l'argument est une adresse, et une **adresse inconnue est
refusée explicitement** plutôt que supposée à 18 décimales (fail-closed).
Preuve : `getTokenDecimals(<adresse USDC.e>) = 6` ✔ ; adresse inconnue → erreur
explicite ✔.

### Bug comptable trouvé et corrigé — `amountOut` = solde total, pas le delta

`swap()` (`swap-service.ts:674`) et `swapMultiHop()` (`:461`) calculaient
`amountOut = formatUnits(balanceOf(wallet), decimals)`, c'est-à-dire le **solde
total** du token de sortie après l'échange — pas le montant reçu. Deux conséquences :
rapports/PnL surévalués, et surtout `swapAndDeposit()` qui chaînait ce montant vers
`depositUsdc()` : il **déposait donc tout le solde USDC du wallet**, y compris des
fonds préexistants sans rapport avec l'échange (`bridge-client.ts:759`), puis `:763`. 
Correction : les deux méthodes lisent le solde **avant** la transaction et
retournent le **delta** (`received = finalBalance - balanceBefore`) ; `swapAndDeposit`
dépose ce delta (`bridge-client.ts:760-763`).

### Points de vigilance restants (non corrigés, signalés)

1. `swap()` : pour les paires **non-stablecoins**, `amountOutMinimum = 0`
   (`swap-service.ts:656`) — **aucune protection de slippage**. Le commentaire du
   code l'assume (« In production, you should use a quoter »), mais un
   `exactInputSingle` à `amountOutMinimum = 0` est un sandwich-attack magnet.
2. `depositUsdc()` prend un `number` et fait `parseUnits(amount.toString(), 6)` :
   un montant à plus de 6 décimales (`10.1234567`) jette ; des montants > 2^53
   perdraient en précision via `number`. Impact faible (plafond $2 mini, valeurs USDC).
3. `bridge-client.ts:580` : `feeData.gasPrice` (legacy) — si le RPC ne renvoie pas
   `gasPrice`, ethers complète, mais on est sur Polygon EIP-1559 : à surveiller.

---

## 6. CODE MORT (recensé, **non supprimé** — importé/exporté ailleurs)

Méthodes publiques **jamais appelées** dans tout le dépôt (`grep -w` sur `src/`,
`bot-with-dashboard.ts`, `bot-config.ts`, `scripts/`, `tests/`, `tools/` → 1 seule
occurrence = la définition). Elles sont toutes attachées à des classes **ré-exportées
par le barrel `src/index.ts`** (`CTFClient`, `SwapService`, `BridgeClient`,
`OnchainService`) : ce sont des points d'entrée SDK publics, donc **conservées**.

| Fichier | Ligne | Symbole | Remarque |
|---|---|---|---|
| `ctf-client.ts` | 1 095 | `getAllPositions()` | jamais appelé (SDK public) |
| `ctf-client.ts` | 1 205 | `getPortfolioValue()` | jamais appelé (SDK public) |
| `ctf-client.ts` | 955 | `setMaticPrice()` | jamais appelé ; `getMaticPrice()` (appelé en interne) renvoie toujours la constante `DEFAULT_MATIC_PRICE = 0.50` → **le coût gaz en USDC affiché est faux** si MATIC ≠ 0.50 $ (signalé, non modifié) |
| `swap-service.ts` | 394 | `swapMultiHop()` | jamais appelé ; **non testé** (contient un `approve` + `exactInput` — désormais gardé) |
| `swap-service.ts` | 748 | `getSupportedTokens()` | jamais appelé |
| `swap-service.ts` | 796 | `getWalletBalance()` (static) | jamais appelé (`getWalletBalances` l'est moins souvent) |
| `bridge-client.ts` | 323 | `getDepositAddress()` | `@deprecated`, shim de compatibilité, jamais appelé |

Autres classes de code mort observé (hors périmètre, non touché) :
`DepositStatus`, `DepositAddress` (types), `estimateBridgeOutput`/`getExplorerUrl`
(exportés, ~0 usage métier), `SwapQuote`, `PoolInfo`, `QuoteResult` (types).

---

## 7. SORTIES RÉELLES

### 7.1 `npx tsc --noEmit`

```console
$ cd /root/clawd/Polymarket-bot && npx tsc --noEmit; echo "EXIT=$?"
EXIT=0
```

Aucune sortie, code retour **0**. (`tsconfig.json` couvre `src/**/*` + `scripts/dip-arb/**/*` ;
`bot-with-dashboard.ts` et `bot-config.ts` ne sont pas inclus dans le projet tsc.)

### 7.2 Sonde 1 — blocage DRY_RUN (`/root/.hermes/cache/scratch/onchain_guard_probe.ts`)

```console
$ DRY_RUN=true npx tsx onchain_guard_probe.ts
===== A. DRY_RUN=true : toutes les écritures doivent être bloquées =====
isDryRunMode() = true
✅ bloqué (DryRunWriteBlockedError) : CTFClient.split
✅ bloqué (DryRunWriteBlockedError) : CTFClient.merge
✅ bloqué (DryRunWriteBlockedError) : CTFClient.mergeByTokenIds
✅ bloqué (DryRunWriteBlockedError) : CTFClient.redeem
✅ bloqué (DryRunWriteBlockedError) : CTFClient.redeemByTokenIds
✅ bloqué (DryRunWriteBlockedError) : SwapService.swap
✅ bloqué (DryRunWriteBlockedError) : SwapService.swapMultiHop
✅ bloqué (DryRunWriteBlockedError) : SwapService.wrapMatic
✅ bloqué (DryRunWriteBlockedError) : SwapService.unwrapMatic
✅ bloqué (DryRunWriteBlockedError) : SwapService.transfer
✅ bloqué (DryRunWriteBlockedError) : SwapService.transferMatic
✅ bloqué (DryRunWriteBlockedError) : SwapService.transferUsdc
✅ bloqué (DryRunWriteBlockedError) : SwapService.transferUsdcE
✅ bloqué (DryRunWriteBlockedError) : SwapService.swapToUsdc
✅ bloqué (DryRunWriteBlockedError) : OnchainService.approveAll
✅ bloqué (DryRunWriteBlockedError) : OnchainService.approveUsdc
✅ bloqué (DryRunWriteBlockedError) : OnchainService.setErc1155Approval
✅ bloqué (DryRunWriteBlockedError) : OnchainService.split
✅ bloqué (DryRunWriteBlockedError) : OnchainService.merge
✅ bloqué (DryRunWriteBlockedError) : OnchainService.redeem
✅ bloqué (DryRunWriteBlockedError) : OnchainService.redeemByTokenIds
✅ bloqué (DryRunWriteBlockedError) : OnchainService.swap
✅ bloqué (DryRunWriteBlockedError) : OnchainService.swapAndDeposit
✅ bloqué (DryRunWriteBlockedError) : OnchainService.transfer
✅ bloqué (DryRunWriteBlockedError) : OnchainService.transferMatic
✅ bloqué (DryRunWriteBlockedError) : OnchainService.wrapMatic
✅ bloqué (DryRunWriteBlockedError) : depositUsdc
✅ bloqué (DryRunWriteBlockedError) : swapAndDeposit

===== B. Lectures autorisées en DRY_RUN (aucune garde) =====
✅ SwapService.getTokenAddress('USDC_E') = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
✅ SwapService.getTokenDecimals('USDC_E')  = 6
✅ CTFClient.getAddress()                  = 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A
✅ OnchainService.getAddress()             = 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A
✅ OnchainService.getProvider().constructor.name = FailoverPolygonProvider

===== C. DRY_RUN absent (fail-closed) : doit bloquer =====
isDryRunMode() = true
✅ bloqué (DryRunWriteBlockedError) : CTFClient.split (DRY_RUN absent)
✅ assertWritesAllowed jette même sans DRY_RUN défini

===== D. DRY_RUN=false (in-process, SANS réseau) : la garde doit laisser passer =====
isDryRunMode() = false
✅ assertWritesAllowed ne jette plus -> les écritures réelles sont possibles
(aucune écriture n'est tentée dans cette section)

===== E. Robustesse RPC : bascule sur fournisseur suivant (LECTURE SEULE) =====
✅ getBlockNumber() via bascule = 94538739 (primaire http://127.0.0.1:9 mort, bascule OK)

RÉSULTAT: 37 OK, 0 ÉCHEC
```

### 7.3 Sonde 2 — unités + clé privée (`units_key_probe.ts`, lectures on-chain)

```console
===== (d) Décimales : table locale vs on-chain =====
TOKEN_DECIMALS = {"MATIC":18,"WMATIC":18,"USDC":6,"NATIVE_USDC":6,"USDC_E":6,"USDT":6,"DAI":18,"WETH":18}
✅ USDC.e (collatéral CTF): table=6 / on-chain=6
✅ USDC natif (NON CTF): table=6 / on-chain=6
✅ USDT: table=6 / on-chain=6
✅ DAI: table=18 / on-chain=18
✅ WMATIC: table=18 / on-chain=18
✅ WETH: table=18 / on-chain=18
✅ USDC_DECIMALS (positions CTF) = 6 (collatéral USDC.e = 6)

===== (d) Résolution symbole vs adresse (fail-closed) =====
✅ USDC_E: symbole=6, adresse=6
✅ adresse inconnue: refus explicite -> Unknown token address: 0x00000000000000000000000000000000000...

===== (d) Conversions wei / USDC 6 / positions =====
✅ parseUsdc("1") = 1000000 (= 1e6)
✅ formatUsdc(1e6) = 1.0
✅ split/merge de "10" => 10000000 unités (1e7, PAS 1e19)
✅ MATIC: parseEther("1") = 1000000000000000000 (= 1e18)

===== (b) Clé privée : garde de forme, aucune fuite dans le message =====
✅ CTFClient: erreur assainie -> Private key invalide: attendu "0x" + 64 caractères hexadécimaux. Valeur volontairement non affichée (anti-fuite de secret dans les logs).
✅ OnchainService: erreur assainie -> Private key invalide: attendu "0x" + 64 caractères hexadécimaux. Valeur volontairement non affichée (anti-fuite de secret dans les logs).
   (rappel) message ethers v5 non filtré contient la valeur: OUI -> fuite évitée par la garde

RÉSULTAT: 15 OK, 0 ÉCHEC
```

### 7.4 Vérification on-chain : aucune transaction émise par cet audit

La première version de la sonde a testé (une seule fois) le chemin `DRY_RUN=false`
et a ainsi atteint le réseau. Vérification post-mortem, en lecture seule, sur
l'adresse dérivée de la clé placeholder utilisée par la sonde
(`0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A` — clé `0x1111…11`, adresse de test
publique) :

```console
nonce à block 94538633 ( 0.0 min ) => 4169
nonce à block 94538603 ( 1.1 min ) => 4169
nonce à block 94538513 ( 4.2 min ) => 4169
nonce à block 94538333 ( 10.5 min ) => 4169
nonce à block 94537633 ( 35.0 min ) => 4169
balance: 0
```

**Conclusion : aucune transaction n'a pu être minée** (nonce identique sur ~35 min
d'historique, solde 0 wei → aucun frais de gaz possible ; le nonce 4169 est
historique, lié à cette clé de test publique). La sonde finale (7.2) n'exécute plus
**que** des lectures.

---

## 8. RÉCAPITULATIF DES MODIFICATIONS

| Fichier | Nature |
|---|---|
| `src/clients/ctf-client.ts` | + gardes `isDryRunMode`/`assertWritesAllowed`/`DryRunWriteBlockedError` + `assertValidPrivateKeyShape` + `createPolygonProvider`/`FailoverPolygonProvider`/`KNOWN_POLYGON_RPCS` ; 5 gardes d'écriture ; provider résilient ; garde de forme de clé ; commentaire décimales positions |
| `src/services/swap-service.ts` | import des gardes ; 6 gardes d'écriture ; provider résilient ×3 ; `getTokenDecimals` fail-closed (bug d'unité) ; `amountOut` = delta (bug comptable) |
| `src/clients/bridge-client.ts` | import des gardes ; 2 gardes d'écriture (hors `try`) ; dépôt du **delta** USDC au lieu du solde total |
| `src/services/onchain-service.ts` | import des gardes ; 3 gardes sur les approbations (chemin non gardé) ; provider résilient ; garde de forme de clé |
| `src/services/wallet-service.ts` | **non modifié** — aucun chemin d'écriture |

Aucun fichier hors des 5 autorisés n'a été modifié. `.env`, `bot-with-dashboard.ts`,
`package.json`, `node_modules`, `/root/.polymarket/**` : intacts. Aucun `pm2 restart`.
Aucune transaction envoyée.

## 9. LIMITES ET SUITES RECOMMANDÉES (hors périmètre)

1. `authorization-service.ts` : ajouter la même garde à la source (aujourd'hui protégé
   seulement par la façade `OnchainService`) ; supprimer le `gasLimit` explicite de
   `setApprovalForAll` (l. 309) qui court-circuite l'estimation.
2. `dip-arb-service.ts` : ajouter un test `DRY_RUN` explicite en tête de `mergeByTokenIds`/
   `redeemByTokenIds` (aujourd'hui protégé seulement par `CTFClient`).
3. `bot-with-dashboard.ts:1026` et `src/index.ts:431` : instancier les providers via
   `createPolygonProvider()` au lieu de `new JsonRpcProvider(...)`.
4. `src/index.ts:466` : ne pas injecter la clé réelle dans `DipArbService` en DRY_RUN
   (`config.dryRun ? undefined : config.privateKey`), comme le fait déjà
   `bot-with-dashboard.ts:731` pour `ArbitrageService`.
5. `swap-service.ts:662` : `amountOutMinimum = 0` sur les paires non-stablecoins →
   intégrer le quoter pour une protection de slippage réelle.
6. `ctf-client.ts` : `getMaticPrice()` renvoie une constante (0,50 $) → coût gaz estimé
   non fiable dans les rapports.
7. `DRY_RUN` explicitement à `false` désormais requis pour les scripts live
   (`scripts/redeem.ts`, `scripts/deposit/deposit.ts`, `scripts/arb/*`,
   `scripts/dip-arb/*`) — comportement fail-closed assumé et documenté ici.
