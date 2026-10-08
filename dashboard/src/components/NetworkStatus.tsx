interface NetworkStatusProps {
  connected: boolean;
}

export function NetworkStatus({ connected }: NetworkStatusProps) {
  // Avant : gaz, numéro de bloc et latence étaient TIRÉS AU HASARD toutes les 5 s (aucune
  // mesure). Seul l'état de connexion au bot est réel : c'est le seul affiché.
  return (
    <div className="flex items-center gap-4 text-xs">
      <div className="flex items-center gap-2">
        <div className={`status-dot ${connected ? 'status-dot-active animate-pulse' : 'status-dot-error'}`} />
        <span className={connected ? 'text-green-400' : 'text-red-400'}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
    </div>
  );
}
