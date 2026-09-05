import pg from 'pg';
import { requireDatabaseUrl } from './env';

/**
 * Accès PostgreSQL de l'E2E — infrastructures de test uniquement : préparation
 * d'états (désactivation, expiration, révocation) et nettoyage. Le parcours
 * utilisateur, lui, passe toujours par le navigateur (aucun raccourci
 * applicatif pour le flux login/logout).
 */

let pool: pg.Pool | null = null;

export function testDb(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: requireDatabaseUrl() });
  return pool;
}

export async function closeTestDb(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

/** Exécute une requête et retourne les lignes. */
export async function query<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await testDb().query(text, values);
  return result.rows as T[];
}
