#!/usr/bin/env bash
# Mise à jour du bot sur le serveur, en une commande : code (main), dépendances, dashboard,
# diagnostic, relance PM2.
#
#   npm run upgrade            (ou : bash scripts/update.sh [branche])
#
# Ne touche ni au .env ni aux données (~/.polymarket : registre, journal, historique).
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="${1:-main}"
APP="polymarket-paperbot"

echo "▶ Code : branche $BRANCH"
git fetch origin "$BRANCH"
git checkout -q "$BRANCH"
git pull --ff-only origin "$BRANCH"
echo "   $(git log --oneline -1)"

echo "▶ Dépendances"
npm install --no-audit --no-fund

echo "▶ Dashboard (interface)"
(cd dashboard && npm install --no-audit --no-fund && npm run build)

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
