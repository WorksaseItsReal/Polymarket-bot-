# RAPPORT — Audit & fiabilisation du RECAP Telegram Polymarket

Fichier édité : `/root/.hermes/scripts/paperbot-recap.py` (seul fichier de code touché).
Sonde : `/root/.hermes/cache/scratch/probe_recap.py` (n'appelle jamais `send()`/`main()`).
Aucun message Telegram réel n'a été envoyé pendant l'audit (`build_message()` uniquement).

---

## 1. Bugs détectés dans le message réel (AVANT)

Message réel régénéré via `build_message()` (extrait pertinent, marqueur `\x00` déjà retiré) :

```
· Solana: <b>UP 52%</b> / DOWN 48%
   à battre <b>Solana</b>: $121 (ouverture) · live $121 (+0.08%)
· Dogecoin: <b>UP 46%</b> / DOWN 54%
   à battre <b>Dogecoin</b>: $0.0965 (ouverture) · live $0.0965 (+0.03%)
🔁 Round: <b>1790463000</b>
🕐 <b>22:51</b> — Paper (dry) · next round
```

| # | Ligne | Absurdité | Cause |
|---|-------|-----------|-------|
| A | Solana / Dogecoin « à battre » | **valeurs dupliquées** : prix « à battre » et « live » affichés identiques alors que la variation indiquée est non nulle (+0.08% / +0.03%) | `fmtp()` arrondissait à 0 décimale dès `p ≥ 10` (SOL→121) et à 4 décimales pour DOGE, masquant la variation réelle |
| B | `🔁 Round: 1790463000` | **libellé faux / illisible** : epoch Unix brut présenté comme « Round » | fallback `slug.split("-updown-5m-")[-1]` renvoyait le timestamp du slot |
| C | `— Paper (dry) · next round` | libellé trompeur : le round affiché est le round **en cours**, pas le suivant | texte statique |
| D | (manquant) | **aucun indicateur statistique** : le PnL affiché seul laisse croire à un edge, sans dire s'il est distinguable du bruit | statistique absente |

Non-problèmes vérifiés : pas de mojibake (aucun `Ã`/`Â`/`â€`), probas UP/DOWN somment bien à 100%, win rate cohérent avec W/L (87/39 → 69.0%), PnL cumulé cohérent avec `cumulative.json`.

---

## 2. Correctifs appliqués

1. **`fmtp()` à précision adaptative** — `p<0.1` → 5 déc. ; `p<10` → 4 déc. ; `p<1000` → 2 déc. ; sinon 0 déc. Deux prix distincts s'affichent désormais distincts.
2. **`fmt_round()`** — un epoch (`1790463000`) devient la fenêtre lisible `22:50→22:55`.
3. **En-tête** — « next round » remplacé par « cycle 5 min ».
4. **`edge_stats()` + ligne `📐 Edge`** — t-statistique honnête : moyenne par mise, écart-type, `t = mean / (sd/√n)`, verdict « significatif » si `|t| ≥ 1.96`, sinon « non significatif (bruit) ».
   - Source : `~/.polymarket/cumulative.json` (valeurs réalisées par trade) **complétée** par `~/.polymarket/history.json` (trades récents stockés en booléen). Dédup par clé `conditionId|side|price` → jamais compté deux fois.
   - Vérification croisée : la somme de l'échantillon reconstruit = **7.7877** = `cumulative.json.pnl` exactement → l'échantillon couvre bien les 127 trades affichés.

La dédup existante (marqueur `VOL = "\x00"`, exclusion de `🔁 Round:`, normalisation de l'heure) est **intacte** ; la nouvelle ligne Edge est volontairement **dans** la clé (elle ne change que quand un trade se résout — c'est un événement, pas du bruit).

---

## 3. Message APRÈS (extrait réel, `\x00` retirés)

```
🔁 Round: <b>22:50→22:55</b>
🕐 <b>22:53</b> — Paper (dry) · cycle 5 min
💲 <b>Prix live</b>
₿ <b>Bitcoin</b>  $84,342
Ξ <b>Ethereum</b>  $2,691
◆ <b>Solana</b>  $121.30
✕ <b>XRP</b>  $1.5237
Ð <b>Dogecoin</b>  $0.09648
· Solana: <b>UP 88%</b> / DOWN 12%
   à battre <b>Solana</b>: $121.20 (ouverture) · live $121.30 (+0.08%)
· Dogecoin: <b>UP 46%</b> / DOWN 54%
   à battre <b>Dogecoin</b>: $0.09650 (ouverture) · live $0.09648 (-0.02%)
🟢 <b>PnL réalisé (résolu): $+6.79</b> · 127 trades
🎯 Win rate: <b>68.5%</b> (87W / 40L)
📐 <b>Edge</b>: moy <b>+0.05$</b>/mise · t-stat <b>+0.84</b> (n=127, seuil 1.96) → <b>non significatif (bruit)</b>
```

Les valeurs « à battre » / « live » sont maintenant distinctes (SOL 121.20 vs 121.30, DOGE 0.09650 vs 0.09648).

---

## 4. Preuve : clé de dédup STABLE sur deux appels consécutifs

Sonde `probe_recap.py` (2 × `build_message()`, logique de clé recopiée à l'identique de `main()`) :

```
STABLE(k1==k2): True
VOL présent dans message ENVOYÉ ? : False (doit être False)
VOL présent dans clé de dédup ? : False (doit être False)
lignes volatiles EXCLUES de la clé (preuve): 5
  ex: à battre <b>Bitcoin</b>: $84,302 (ouverture) · live $84,342 (+0.05%)
prix live dans la clé ? : False (doit être False)
probas UP/DOWN dans la clé ? : False (doit être False)

===== VERDICT =====
OK — aucune absurdité détectée, clé stable, pas de \x00.
EXIT=0
```

Entre les deux appels, les prix live ont réellement bougé (Solana `$121.30` → `$121.29`, DOGE `$0.09648` → `$0.09649`) **sans** modifier la clé : la preuve que les données volatiles en sont bien exclues. Sans ce correctif, le recap repartait toutes les 5 minutes.

---

## 5. Contraintes respectées

- N'a édité que `paperbot-recap.py` (+ ce rapport).
- Aucun `send()` / `main()` appelé (zéro message réel).
- Aucun cron créé ou modifié.
- Fichiers interdits (`bot-with-dashboard.ts`, `.env`, `src/**`, `paperbot-pnl.py`) non touchés.

## 6. Limite connue (honnêteté)

`paperbot-pnl.py` (non modifiable ici) écrit désormais `cumulative.json.resolved[key] = True` (booléen) au lieu de la valeur réalisée : au-delà de la fenêtre de `history.json`, la valeur par trade n'est plus conservée. La t-stat reste donc honnête (`n` affiché), mais son échantillon cessera de grandir quand les trades sortiront de `history.json`. Correctif côté `paperbot-pnl.py` à prévoir (stocker la valeur réalisée, pas `True`).
