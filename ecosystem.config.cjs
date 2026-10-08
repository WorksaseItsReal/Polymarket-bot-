module.exports = {
  apps: [{
    name: 'polymarket-paperbot',
    script: 'bot-with-dashboard.ts',
    cwd: '/root/clawd/Polymarket-bot',
    interpreter: '/root/clawd/Polymarket-bot/node_modules/.bin/tsx',
    interpreter_args: '',
    force: true,
    autorestart: true,
    max_restarts: 20,
    restart_delay: 5000,
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