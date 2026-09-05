import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Environnement résolu pour l'E2E : `KREIZ_DATABASE_URL` obligatoire
 * (process.env d'abord, puis apps/demo/.env), `KREIZ_SECRET` avec repli
 * sur une valeur aléatoire propre au run (le secret ne sert qu'à la clé
 * HMAC du rate limiting dans le processus du serveur dev).
 */

const DEMO_ROOT = join(import.meta.dirname, '..');

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    vars[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).trim();
  }
  return vars;
}

const fileVars = parseEnvFile(join(DEMO_ROOT, '.env'));

export const databaseUrl: string =
  process.env.KREIZ_DATABASE_URL ?? fileVars.KREIZ_DATABASE_URL ?? '';

export const kreizSecret: string =
  process.env.KREIZ_SECRET ?? fileVars.KREIZ_SECRET ?? randomBytes(32).toString('base64url');

export function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      'E2E : KREIZ_DATABASE_URL requis (variable d’environnement ou apps/demo/.env).',
    );
  }
  return databaseUrl;
}
