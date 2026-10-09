module.exports = {
  apps: [{
    name: 'polymarket-paperbot',
    script: 'bot-with-dashboard.ts',
    cwd: '/root/clawd/Polymarket-bot',
    // node + chargeur tsx dans LE MÊME process. Avant : le binaire `tsx` comme interpréteur
    // lançait le bot dans un process enfant ; à l'arrêt (pm2 stop/restart), tsx relaie
    // SIGINT puis tue l'enfant en SIGKILL s'il n'a pas répondu en ~60 ms — boucle
    // d'événements occupée à cet instant → arrêt propre jamais exécuté (journal et
    // message d'arrêt perdus, faux « arrêt brutal » au lancement suivant). Vérifié sous
    // PM2 5.4.3. Nécessite Node ≥ 20.6 (`npm run check` utilise déjà `--import tsx`).
    interpreter: 'node',
    interpreter_args: '--import tsx',
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
    // Filet de sécurité : le bot tient en ~110 Mo (tas 14 Mo après GC, soak de 10 h simulées) ;
    // au-delà de 400 Mo, quelque chose fuit → relance propre (SIGINT, registre intact) plutôt
    // qu'un serveur qui s'asphyxie.
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
    },
    out_file: '/root/clawd/Polymarket-bot/paperbot.log',
    error_file: '/root/clawd/Polymarket-bot/paperbot.error.log',
    merge_logs: true,
    time: true,
  }],
};