import { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { Header } from './components/Header';
import { ConnectionStatus } from './components/ConnectionStatus';
import { KpiRow } from './components/KpiRow';
import { FairValuePanel } from './components/FairValuePanel';
import { RiskPanel } from './components/RiskPanel';
import { PositionsPanel } from './components/PositionsPanel';
import { EvaluationsPanel } from './components/EvaluationsPanel';
import { HealthPanel } from './components/HealthPanel';
import { ActivityLog } from './components/ActivityLog';
import { ConfigPanel } from './components/ConfigPanel';
import { HistoryPage } from './components/HistoryPage';

type Page = 'dashboard' | 'history';

/**
 * Dashboard du bot papier « Up or Down 5 min ». Tout ce qui est affiché vient du registre
 * papier (source de vérité) ou de l'état de santé du process — rien n'est estimé ici.
 */
function App() {
  const [page, setPage] = useState<Page>('dashboard');
  const { state, config, logs, connected, error } = useWebSocket();

  if (page === 'history') return <HistoryPage onBack={() => setPage('dashboard')} />;

  return (
    <div className="min-h-screen bg-poly-dark text-white">
      <div className="bg-blue-500/15 border-b border-blue-500/30 px-4 py-1.5 text-center">
        <span className="text-blue-300 font-medium text-xs flex items-center justify-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
          PAPIER — aucun ordre réel n'est envoyé (exécution réelle non implémentée)
        </span>
      </div>
      <ConnectionStatus connected={connected} error={error} />
      <Header state={state} connected={connected} onHistoryClick={() => setPage('history')} />

      <main className="p-4 space-y-4 max-w-[1800px] mx-auto">
        <KpiRow state={state} />
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div className="xl:col-span-2"><FairValuePanel state={state} /></div>
          <RiskPanel state={state} />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <PositionsPanel state={state} />
          <EvaluationsPanel state={state} config={config} />
          <HealthPanel state={state} config={config} />
        </div>
        <ActivityLog logs={logs} />
        <details className="group">
          <summary className="cursor-pointer text-gray-500 text-sm hover:text-gray-400 flex items-center gap-2 py-2">
            <span className="transition-transform group-open:rotate-90">▶</span>
            Réglages en vigueur
          </summary>
          <div className="mt-2"><ConfigPanel config={config} /></div>
        </details>
      </main>

      <footer className="text-center py-3 border-t border-white/5 text-gray-600 text-xs">
        Polymarket paper bot · {connected ? '🟢 connecté au bot' : '🔴 déconnecté'}
      </footer>
    </div>
  );
}

export default App;
