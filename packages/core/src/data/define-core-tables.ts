import { kreizCoreTables, type CoreTables } from './core-tables.js';

/**
 * Point d'entrée public des définitions de tables du Core.
 *
 * Composition attendue côté application :
 *
 * ```ts
 * // apps/<app>/src/schema.ts
 * import { pgTable } from 'drizzle-orm/pg-core';
 * import { defineCoreTables } from '@kreiz/core/data';
 *
 * const projectTable = pgTable('project_table', { … });
 * export const schema = { ...defineCoreTables(), projectTable };
 * ```
 *
 * L'application possède ensuite sa chaîne Drizzle complète (drizzle.config,
 * dossier `drizzle/`, journal de migrations) — le Core n'embarque ni migration
 * ni journal consommateur, et ne migre jamais au runtime (cadrage §7).
 */
export function defineCoreTables(): CoreTables {
  return kreizCoreTables;
}
