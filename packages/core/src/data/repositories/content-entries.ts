import { and, eq, isNull } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import {
  contentEntries,
  type KreizContentEntry,
  type KreizContentEntryInsert,
} from '../tables/content-entries.js';

/**
 * Repository du domaine contenus. Minimum du slice 1 : écriture, lecture
 * typée, lookup par slug actif. CRUD générique, listing, publication :
 * slices 3 et 4.
 */
export function createContentEntriesRepository(db: KreizDatabase) {
  return {
    async create(values: KreizContentEntryInsert): Promise<KreizContentEntry> {
      const rows = await db.insert(contentEntries).values(values).returning();
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : contentEntries.create() n’a retourné aucune ligne.');
      }
      return row;
    },

    findById(id: string): Promise<KreizContentEntry | null> {
      return db
        .select()
        .from(contentEntries)
        .where(eq(contentEntries.id, id))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /**
     * Lookup actif par namespace + slug : filtre `deleted_at IS NULL`, même
     * sémantique que l'index unique partiel — un slug soft-deleted n'est
     * jamais retourné comme contenu vivant.
     */
    findActiveByNamespaceAndSlug(
      routeNamespace: string,
      slug: string,
    ): Promise<KreizContentEntry | null> {
      return db
        .select()
        .from(contentEntries)
        .where(
          and(
            eq(contentEntries.routeNamespace, routeNamespace),
            eq(contentEntries.slug, slug),
            isNull(contentEntries.deletedAt),
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },
  };
}

export type ContentEntriesRepository = ReturnType<typeof createContentEntriesRepository>;
