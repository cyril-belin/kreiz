import { fileURLToPath } from 'node:url';
import { createKreizDatabase, parseKreizDatabaseEnv } from '@kreiz/core/data';
import { migrate } from 'drizzle-orm/neon-http/migrator';

// Applique la chaîne de migrations possédée par apps/demo sur la base
// PostgreSQL (Neon) pointée par KREIZ_DATABASE_URL. Exécuté via
// `pnpm --filter @kreiz/demo db:migrate` (Node 24 exécute ce TS nativement).
const env = parseKreizDatabaseEnv(process.env);
const db = createKreizDatabase({ databaseUrl: env.KREIZ_DATABASE_URL });

// Les connexions HTTPS vers Neon peuvent échouer transitoirement (connect
// timeout, fetch failed — réalité serverless observée) : on retente ces
// erreurs réseau uniquement, jamais une erreur SQL.
const TRANSIENT_NETWORK_MARKERS = [
  'UND_ERR_CONNECT_TIMEOUT',
  'Connect Timeout Error',
  'fetch failed',
  'ECONNRESET',
  'other side closed',
];

function isTransientNetworkError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = String((current as { message?: unknown }).message ?? '');
    if (TRANSIENT_NETWORK_MARKERS.some((marker) => message.includes(marker))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let lastError: unknown;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    console.log('@kreiz/demo : migrations appliquées.');
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt === 3 || !isTransientNetworkError(error)) throw error;
    console.warn(`Tentative ${attempt} : erreur réseau transitoire, nouvel essai…`);
    await sleep(attempt * 750);
  }
}
throw lastError;
