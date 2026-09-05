import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import pg from 'pg';
import { describe } from 'vitest';
import { createKreizDatabase, type KreizDatabase } from '../../src/data/connection';

/**
 * Harnais des tests d'intégration Kreiz — PostgreSQL réel uniquement
 * (aucun mock de Drizzle, cadrage §17).
 *
 * Deux modes, par ordre de priorité :
 *
 * 1. `KREIZ_DATABASE_URL` — mode canonique : driver HTTP Neon via l'API
 *    publique `createKreizDatabase()`. En CI, la base est une branche Neon
 *    éphémère migrée par la chaîne de `apps/demo` avant les tests.
 * 2. `KREIZ_TEST_DATABASE_URL` — mode « PostgreSQL réel local » : valide la
 *    sémantique SQL de la migration (contraintes, index, FK) sans driver
 *    Neon. Ce mode n'existe que pour les tests ; il applique lui-même les
 *    migrations de `apps/demo` sur une base vide (créer une base jetable,
 *    par ex. `createdb kreiz_slice1_it`).
 *
 * Sans ces variables, les tests d'intégration sont ignorés — `pnpm test`
 * reste vert partout, et le chemin Neon reste validé en CI.
 */
const NEON_URL = process.env.KREIZ_DATABASE_URL;
const PG_URL = process.env.KREIZ_TEST_DATABASE_URL;

export type IntegrationMode = 'neon-http' | 'postgres';

export const integrationMode: IntegrationMode | null = NEON_URL
  ? 'neon-http'
  : PG_URL
    ? 'postgres'
    : null;

/** SQL brut : réservé aux vérifications du comportement PostgreSQL et au nettoyage — jamais pour la logique de domaine. */
export type RawExecutor = (query: SQL) => Promise<Array<Record<string, unknown>>>;

export type IntegrationHarness = {
  mode: IntegrationMode;
  /** Instance à passer aux factories de repositories — API publique du Core. */
  db: KreizDatabase;
  raw: RawExecutor;
  close: () => Promise<void>;
};

export async function setupIntegration(): Promise<IntegrationHarness> {
  if (NEON_URL) {
    const db = createKreizDatabase({ databaseUrl: NEON_URL });
    return {
      mode: 'neon-http',
      db,
      raw: buildRaw(db),
      close: async () => {},
    };
  }

  if (PG_URL) {
    const pool = new pg.Pool({ connectionString: PG_URL });
    const client = await pool.connect();
    try {
      // Verrou consultatif : les fichiers de test s'exécutant en parallèle,
      // un seul applique la migration sur la base vide, les autres la
      // retrouvent déjà en place.
      await client.query('select pg_advisory_lock(918273645)');
      try {
        const present = await client.query<{ present: string | null }>(
          "select to_regclass('public.kreiz_admin_users') as present",
        );
        if (!present.rows.at(0)?.present) {
          const drizzleDir = fileURLToPath(
            new URL('../../../../apps/demo/drizzle', import.meta.url),
          );
          const files = readdirSync(drizzleDir)
            .filter((name) => name.endsWith('.sql'))
            .sort();
          for (const file of files) {
            const content = readFileSync(`${drizzleDir}/${file}`, 'utf8');
            for (const statement of content.split('--> statement-breakpoint')) {
              await client.query(statement);
            }
          }
        }
      } finally {
        await client.query('select pg_advisory_unlock(918273645)');
      }
    } finally {
      client.release();
    }
    // Cast confiné au harnais de test : drizzle/node-postgres et drizzle/neon-http
    // partagent la même surface d'API core (select/insert/execute) utilisée par
    // les repositories ; le typage public du Core reste NeonHttpDatabase.
    const db = drizzleNodePg(pool) as unknown as KreizDatabase;
    return {
      mode: 'postgres',
      db,
      raw: buildRaw(db),
      close: async () => {
        await pool.end();
      },
    };
  }

  throw new Error(
    'Aucune base fournie : définir KREIZ_DATABASE_URL (Neon) ou KREIZ_TEST_DATABASE_URL (PostgreSQL réel local).',
  );
}

function buildRaw(db: KreizDatabase): RawExecutor {
  return async (query) => {
    const result = (await withTransientNetworkRetry(async () => {
      return (await db.execute(query)) as {
        rows: Array<Record<string, unknown>>;
      };
    })) as { rows: Array<Record<string, unknown>> };
    return result.rows;
  };
}

/** Extrait le code d'erreur PostgreSQL (23505, 23503, 23514…) d'une erreur Drizzle/driver. */
export function pgErrorCode(error: unknown): string | null {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Erreurs réseau transitoires du driver HTTP Neon (connect timeout, fetch
 * failed…) — réalité serverless observée, notamment à froid ou sous charge
 * locale. On les distingue explicitement des erreurs SQL (qui ne sont
 * jamais retentées).
 */
const TRANSIENT_NETWORK_MARKERS = [
  'UND_ERR_CONNECT_TIMEOUT',
  'Connect Timeout Error',
  'fetch failed',
  'ECONNRESET',
  'other side closed',
];

export function isTransientNetworkError(error: unknown): boolean {
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

/** Retente uniquement les erreurs réseau transitoires (jamais les erreurs SQL). */
export async function withTransientNetworkRetry<T>(
  run: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientNetworkError(error)) throw error;
      await sleep(attempt * 750);
    }
  }
  throw lastError;
}

export async function expectPgError(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    const actual = pgErrorCode(error);
    if (actual !== code) {
      throw new Error(`Code PostgreSQL attendu ${code}, reçu ${actual ?? 'aucun'} (${String(error)})`);
    }
    return;
  }
  throw new Error(`Erreur PostgreSQL ${code} attendue — aucune levée`);
}

/** Gate commun aux fichiers d'intégration. */
export function describeIntegration(name: string, fn: () => void): void {
  describe.skipIf(!integrationMode)(name, fn);
}
