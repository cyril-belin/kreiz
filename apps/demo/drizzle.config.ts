import { defineConfig } from 'drizzle-kit';

// Chaîne de migrations possédée par apps/demo : le schéma composé
// (Core + Project) génère les migrations dans ./drizzle. L'URL n'est
// nécessaire que pour les commandes qui contactent la base (migrate, push,
// studio) — jamais pour `generate`.
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.KREIZ_DATABASE_URL ?? '',
  },
});
