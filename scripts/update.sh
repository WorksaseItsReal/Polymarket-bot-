#!/usr/bin/env bash
# Mise à jour du bot sur le serveur, en une commande : code (main), dépendances, dashboard,
# diagnostic, relance PM2.
#
#   npm run upgrade            (ou : bash scripts/update.sh — sans argument)
#
# Le serveur ne déploie QUE main : PM2 exécute ce qui est extrait sur le disque, et les
# résultats papier (registre, journal) doivent venir du code validé et fusionné. Une branche se
# teste en local (npm run check, npm run demo) ; tout argument est refusé (code 2) AVANT la
# moindre commande git.
#
# Ne touche ni au .env ni aux données (~/.polymarket : registre, journal, historique). Avant de
# relancer le bot, copie le registre dans ~/.polymarket/backups/ (scripts/lib/backup-ledger.sh :
# le nouveau code peut le migrer au démarrage) ; sauvegarde impossible → bot NON relancé, code 1.
set -euo pipefail
# Tout le corps est dans main() : bash l'analyse en entier AVANT d'exécuter, donc le `git pull`
# qui remplace ce fichier en cours de route ne peut pas le casser.
main() {
if [ "$#" -gt 0 ]; then
  echo "❌ update.sh ne prend aucun argument (reçu : $*) : le serveur ne déploie que main." >&2
  echo "   Tester une branche en local (npm run check, npm run demo), la fusionner dans main, puis « npm run upgrade »." >&2
  exit 2
fi
cd "$(dirname "$0")/.."
APP="polymarket-paperbot"
# Chargée AVANT le pull, pour la même raison que main() : la version lue est celle du départ.
. scripts/lib/backup-ledger.sh
# Code qui a écrit le registre actuel : nomme la sauvegarde faite avant la relance.
PREV="$(git rev-parse --short HEAD 2>/dev/null || echo inconnu)"

echo "▶ Code : branche main"
# Lockfiles réécrits par un ancien « npm install » : régénérables, ils bloquaient le pull.
git checkout -- package-lock.json dashboard/package-lock.json 2>/dev/null || true
# Autres modifications locales de fichiers suivis : mises de côté (récupérables), jamais perdues.
if ! git diff --quiet || ! git diff --cached --quiet; then
  STASH_MSG="update.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "   ⚠️ Modifications locales mises de côté (« git stash list », puis « git stash pop » pour les reprendre) :"
  git status --short --untracked-files=no | sed 's/^/      /'
  git stash push -q -m "$STASH_MSG"
fi
# Toujours main, même si une autre branche a été extraite à la main entre-temps.
git fetch origin main
git checkout -q main
git pull --ff-only origin main
DEPLOYED="branche $(git rev-parse --abbrev-ref HEAD), commit $(git log --oneline -1)"
echo "   Déployé : $DEPLOYED"

# npm ci : installe exactement le lockfile sans le réécrire (le prochain pull reste propre).
install() { if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi; }

echo "▶ Dépendances"
install

echo "▶ Dashboard (interface)"
(cd dashboard && install && npm run build)

echo "▶ Diagnostic"
if ! npm run doctor; then
  echo "⚠️  Le doctor signale des erreurs (ci-dessus). Le bot est relancé quand même : corrige-les, puis « pm2 restart $APP »."
fi

# Juste avant la relance (état le plus récent) ; l'ancien processus tourne encore à ce stade.
echo "▶ Sauvegarde du registre"
if ! backup_ledger "$PREV"; then
  echo "❌ Sauvegarde du registre impossible : le bot n'est PAS relancé sur le nouveau code (il pourrait migrer le registre). Corriger, puis « npm run upgrade »." >&2
  exit 1
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "▶ PM2 : relance de $APP"
  pm2 delete "$APP" >/dev/null 2>&1 || true
  pm2 start ecosystem.config.cjs
  pm2 save >/dev/null 2>&1 || true
  pm2 list | grep -E "$APP|name" || true
  echo "   Logs : pm2 logs $APP"
else
  echo "PM2 absent : lancer avec « npx tsx bot-with-dashboard.ts », ou l'installer (npm i -g pm2) puis « pm2 start ecosystem.config.cjs »."
fi
echo "✅ Code déployé dans $(pwd) : $DEPLOYED"
}
main "$@"
