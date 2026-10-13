/**
 * Enregistre le jeton `claude setup-token` de la stratégie llm (papier uniquement).
 *
 *   claude setup-token            # affiche le jeton après autorisation dans le navigateur
 *   npm run llm:token             # puis colle-le, Entrée, Ctrl-D
 *   pbpaste | npm run llm:token   # ou par un tube
 *   npm run llm:token -- --dir /chemin/dossier
 *
 * Le jeton est lu sur STDIN (jamais en argument : il finirait dans l'historique du shell),
 * écrit en mode 0600 avec un fichier méta { createdAt }, et n'est JAMAIS affiché. La date
 * d'expiration affichée est CALCULÉE (aujourd'hui + 365 j, durée documentée), pas lue dans
 * le jeton.
 */
import { defaultTokenPaths, saveToken, tokenPaths } from '../../src/strategy/llm/token.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  const i = process.argv.indexOf('--dir');
  if (i >= 0 && !process.argv[i + 1]) {
    console.error('❌ --dir attend un chemin de dossier.');
    return 1;
  }
  const paths = i >= 0 ? tokenPaths(process.argv[i + 1]) : defaultTokenPaths();
  if (process.stdin.isTTY) console.error('Colle le jeton de `claude setup-token`, puis Entrée et Ctrl-D :');
  const raw = await readStdin();
  try {
    const { expiresAt } = saveToken(paths, raw, Date.now());
    console.log(`✅ Jeton enregistré (mode 600) : ${paths.tokenFile}`);
    console.log(`   Expiration CALCULÉE (enregistrement + 365 j, non lue dans le jeton) : ${new Date(expiresAt).toISOString().slice(0, 10)}`);
    return 0;
  } catch (e) {
    // Les messages de saveToken ne contiennent jamais le jeton.
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

main().then(code => process.exit(code));
