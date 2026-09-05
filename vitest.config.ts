import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    // Les tests d'intégration parlent à Neon via HTTPS (chaque requête est un
    // aller-retour réseau vers une région distante) : les défauts Vitest (5 s)
    // sont trop courts. Sans effet de fond sur les tests unitaires locaux.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
