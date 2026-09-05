import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { closeTestDb } from './db';
import { requireDatabaseUrl } from './env';

/**
 * Préparation de l'E2E : crée les comptes admin **via le CLI `kreiz`**
 * (preuve du chemin canonique CLI → create admin → Neon, cadrage §36),
 * puis expose les identifiants aux tests par variables d'environnement.
 */

const E2E_ROOT = import.meta.dirname;
const CLI_PATH = join(E2E_ROOT, '..', '..', '..', 'packages', 'core', 'dist', 'cli', 'kreiz.js');

const runId = Date.now().toString(36);
export const adminEmail = `e2e-${runId}-main@example.test`;
const victimEmail = `e2e-${runId}-victim@example.test`;
const disabledEmail = `e2e-${runId}-disabled@example.test`;
const adminPassword = 'phrase-e2e-tres-longue-2026';

function createAdminViaCli(email: string, name: string): void {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `E2E : le CLI @kreiz/core est introuvable (${CLI_PATH}). Exécuter « pnpm build » avant les tests E2E.`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [
      CLI_PATH,
      'admin:create',
      '--email',
      email,
      '--name',
      name,
      '--password',
      adminPassword,
    ],
    {
      env: { ...process.env, KREIZ_DATABASE_URL: requireDatabaseUrl() },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`E2E : échec de kreiz admin:create pour ${email} — ${result.stderr}`);
  }
}

export default function globalSetup(): void {
  try {
    createAdminViaCli(adminEmail, 'Admin E2E');
    createAdminViaCli(victimEmail, 'Victime E2E');
    createAdminViaCli(disabledEmail, 'Désactivé E2E');
    process.env.E2E_ADMIN_EMAIL = adminEmail;
    process.env.E2E_VICTIM_EMAIL = victimEmail;
    process.env.E2E_DISABLED_EMAIL = disabledEmail;
    process.env.E2E_ADMIN_PASSWORD = adminPassword;
  } finally {
    void closeTestDb();
  }
}
