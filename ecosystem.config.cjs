module.exports = {
  apps: [{
    name: 'polymarket-paperbot',
    script: 'bot-with-dashboard.ts',
    cwd: '/root/clawd/Polymarket-bot',
    interpreter: '/root/clawd/Polymarket-bot/node_modules/.bin/tsx',
    interpreter_args: '',
    force: true,
    autorestart: true,
    // Relance après 0,1 s, puis ×1,5 à chaque plantage (plafond PM2 : 15 s), remis à zéro
    // après 30 s sans plantage. (`restart_delay` était ignoré : PM2 le remplace par ce délai.)
    // `max_restarts` ne compte que les plantages en moins de `min_uptime` (1 s) : le bot
    // (tsx) met plus longtemps à démarrer, PM2 le relance donc indéfiniment. Les alertes
    // Telegram d'une boucle de plantage sont espacées par le bot (src/services/crash-guard.ts).
    max_restarts: 20,
    exp_backoff_restart_delay: 100,
    // Laisser au bot le temps d'écrire le journal et d'envoyer le message d'arrêt (≤ 5 s)
    // avant que PM2 ne le tue (défaut PM2 : 1,6 s).
    kill_timeout: 7000,
    env: {
      NODE_ENV: 'production',
    },
    out_file: '/root/clawd/Polymarket-bot/paperbot.log',
    error_file: '/root/clawd/Polymarket-bot/paperbot.error.log',
    merge_logs: true,
    time: true,
  }],
};