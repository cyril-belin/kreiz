import { defineConfig } from '@playwright/test';
import { databaseUrl, kreizSecret } from './e2e/env';
import { HOOK_URL } from './e2e/rebuild-hook-server';
import { MAIL_URL } from './e2e/mail-capture-server';
import { STORAGE_ENV, STORAGE_PUBLIC_BASE_URL } from './e2e/storage-server';

/**
 * E2E Playwright — parcours critiques des slices 2-7 (auth, contenu,
 * publication/rebuild, médias, formulaires). Le serveur est le dev server
 * SSR de apps/demo ; les routes admin sont identiques en dev et en
 * production. Le deploy hook de rebuild pointe sur le **serveur local
 * contrôlé** (`rebuild-hook-server.ts`), le stockage média sur le **serveur
 * S3 local** (`storage-server.ts`, s3rver) et le relais email sur le
 * **serveur de capture local** (`mail-capture-server.ts`) — tous démarrés
 * par le global-setup sur un port fixe : aucun vrai Vercel, aucun bucket,
 * aucun SaaS, aucun credential cloud (mission §50).
 */
// Les workers héritent de l'environnement du runner : l'URL publique du
// stockage local est utilisée par les specs pour vérifier les objets.
process.env.E2E_STORAGE_PUBLIC_BASE_URL = STORAGE_PUBLIC_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Un seul worker : les specs partagent une base réelle et un admin commun —
  // deux fichiers en parallèle s'invalident mutuellement (ex. la révocation
  // des sessions du slice 2 tirerait au milieu d'un parcours contenu).
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    locale: 'fr-FR',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'node --env-file-if-exists=.env ./node_modules/astro/bin/astro.mjs dev --host 127.0.0.1 --port 4321 --ignore-lock',
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      KREIZ_DATABASE_URL: databaseUrl,
      KREIZ_SECRET: kreizSecret,
      KREIZ_REBUILD_DEPLOY_HOOK_URL: HOOK_URL,
      KREIZ_MAIL_WEBHOOK_URL: MAIL_URL,
      KREIZ_MAIL_FROM_EMAIL: 'no-reply@kreiz-demo.example',
      KREIZ_MAIL_FROM_NAME: 'Kreiz demo E2E',
      ...STORAGE_ENV,
    },
  },
});
