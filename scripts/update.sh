#!/usr/bin/env bash
# Mise à jour du bot sur le serveur, en une commande : code (main), dépendances, dashboard,
# diagnostic, relance PM2.
#
#   npm run upgrade            (ou : bash scripts/update.sh [branche])
#
# Ne touche ni au .env ni aux données (~/.polymarket : registre, journal, historique).
set -euo pipefail
# Tout le corps est dans main() : bash l'analyse en entier AVANT d'exécuter, donc le `git pull`
# qui remplace ce fichier en cours de route ne peut pas le casser.
main() {
cd "$(dirname "$0")/.."
BRANCH="${1:-main}"
APP="polymarket-paperbot"

echo "▶ Code : branche $BRANCH"
# Lockfiles réécrits par un ancien « npm install » : régénérables, ils bloquaient le pull.
git checkout -- package-lock.json dashboard/package-lock.json 2>/dev/null || true
# Autres modifications locales de fichiers suivis : mises de côté (récupérables), jamais perdues.
if ! git diff --quiet || ! git diff --cached --quiet; then
  STASH_MSG="update.sh $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "   ⚠️ Modifications locales mises de côté (« git stash list », puis « git stash pop » pour les reprendre) :"
  git status --short --untracked-files=no | sed 's/^/      /'
  git stash push -q -m "$STASH_MSG"
fi
git fetch origin "$BRANCH"
git checkout -q "$BRANCH"
git pull --ff-only origin "$BRANCH"
echo "   $(git log --oneline -1)"

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
}
main "$@"
