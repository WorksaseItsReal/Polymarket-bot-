import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Une erreur d'affichage ne doit pas laisser une page blanche : on montre l'erreur et un
 * bouton pour recharger (avant : une seule entrée de journal inattendue démontait l'app).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Dashboard] erreur d\'affichage', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 text-gray-300 bg-gray-950 p-6">
        <div className="text-4xl">⚠️</div>
        <div className="text-lg">Erreur d&apos;affichage du dashboard (le bot, lui, continue de tourner).</div>
        <pre className="text-xs text-red-400 max-w-2xl whitespace-pre-wrap">{this.state.error.message}</pre>
        <button className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20" onClick={() => window.location.reload()}>
          Recharger
        </button>
      </div>
    );
  }
}
