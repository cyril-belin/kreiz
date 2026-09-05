import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { defineCoreTables } from '@kreiz/core/data';

// Tables du Core — instances singleton, identiques à celles utilisées par
// les repositories de @kreiz/core (aucune duplication incohérente possible).
export const coreTables = defineCoreTables();

// Exports nommés directs de chaque table : c'est la forme que drizzle-kit
// collecte de manière fiable lors de la génération des migrations.
export const {
  adminUsers,
  adminSessions,
  adminAuditLog,
  contentEntries,
  redirects,
  media,
  contactRequests,
  analyticsEvents,
  rateLimits,
} = coreTables;

/**
 * Table projet de démonstration — appartient uniquement à `apps/demo`.
 * Elle prouve que Core + Project se composent dans le même schéma Drizzle et
 * la même chaîne de migrations. Elle n'est pas une fonctionnalité produit.
 */
export const demoSettings = pgTable('demo_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Schéma composé de l'application :
 *
 *   Core tables + Project tables = Application schema
 *
 * C'est ce schéma que l'application passe à Drizzle (client, API relationnelle
 * éventuelle) ; la chaîne de migrations dans `drizzle/` appartient à
 * `apps/demo`, jamais à @kreiz/core.
 */
export const schema = { ...coreTables, demoSettings };

export type DemoSchema = typeof schema;
