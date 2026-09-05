import { defineConfig } from '@playwright/test';
import { databaseUrl, kreizSecret } from './e2e/env';

/**
 * E2E Playwright — parcours critiques du slice 2 uniquement
 * (login valide/invalide, admin désactivé, logout + CSRF, session
 * révoquée/expirée). Le serveur est le dev server SSR de apps/demo ; les
 * routes admin sont identiques en dev et en production (Argon2id, sessions
 * Neon, guards). La CSP `<meta>` native d'Astro n'est émise qu'au
 * build/preview — non assertée ici.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
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
    },
  },
});
